import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELAY_CODES = new Set(['unauthorized', 'peer_not_allowed', 'invalid_ids', 'not_found', 'storage_unavailable', 'relay_closing', 'poll_already_active', 'mailbox_full', 'invalid_poll']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function diagnosticBase(relayUrl, allowLoopback = false) {
  if (typeof relayUrl !== 'string' || /[\s\\?#]/.test(relayUrl)) throw new Error('INVALID_RELAY_URL');
  let base;
  try { base = new URL(relayUrl); } catch { throw new Error('INVALID_RELAY_URL'); }
  const authority = relayUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1];
  if (!authority || authority.includes('@') || base.username || base.password || !base.hostname || base.search || base.hash) throw new Error('INVALID_RELAY_URL');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && allowLoopback === true && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority))) throw new Error('HTTPS_REQUIRED');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}

async function probe(base, route, { relayToken, timeoutMs, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const began = Date.now();
  let reader;
  try {
    const headers = { accept: 'application/json' };
    if (relayToken !== undefined) headers.authorization = `Bearer ${relayToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(route, base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const result = { ok: false, httpStatus: response.status, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'unknown' };
    if (response.status >= 300 && response.status < 400) return { ...result, code: 'HTTP_REDIRECT', elapsedMs: Date.now() - began };
    let payload;
    if ((mime === 'application/json' || !response.ok) && response.body?.getReader) {
      reader = response.body.getReader();
      const chunks = []; let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 8192) return { ...result, code: 'RESPONSE_TOO_LARGE', elapsedMs: Date.now() - began };
        chunks.push(value);
      }
      const responseText = Buffer.concat(chunks, total).toString('utf8');
      try { payload = JSON.parse(responseText); } catch {
        // Classify fixed gateway phrases only: never return arbitrary HTML or echoed request headers.
        const lower = responseText.toLowerCase();
        const phrases = ['offline', 'connection refused', 'connection reset', 'timeout', 'timed out', 'unexpected eof', 'upstream', 'bad gateway', 'tuna'];
        const hints = phrases.filter(phrase => lower.includes(phrase));
        if (hints.length) result.gatewayHints = hints;
      }
    }
    if (payload && RELAY_CODES.has(payload.error)) result.relayError = payload.error;
    if (!response.ok) return { ...result, code: response.status === 401 || response.status === 403 ? 'RELAY_AUTH_FAILED' : 'RELAY_HTTP_ERROR', elapsedMs: Date.now() - began };
    let valid = false;
    if (route === 'health') valid = payload?.protocol === 1 && payload?.service === 'dsh-remote-relay';
    else if (route === 'v1/ack') valid = payload?.acknowledged === true;
    else if (route === 'v1/poll') {
      valid = Array.isArray(payload?.items) && payload.items.length <= 16;
      if (valid) result.itemCount = payload.items.length;
    }
    return { ...result, ok: valid, code: valid ? 'OK' : 'INVALID_RELAY_RESPONSE', elapsedMs: Date.now() - began };
  } catch (error) {
    const source = error?.cause?.code || error?.code;
    return { ok: false, code: controller.signal.aborted ? 'REQUEST_TIMEOUT' : NETWORK_CODES.has(source) ? source : 'NETWORK_FAILURE', elapsedMs: Date.now() - began };
  } finally {
    clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});
  }
}

function adviceFor(probes) {
  const advice = [];
  for (const [stage, result] of Object.entries(probes)) {
    if (!result || result.ok) continue;
    const status = result.httpStatus;
    if ([502, 503, 504].includes(status)) advice.push(`${stage}: tunnel/upstream unavailable; check that relay and Tuna stay running after SSH disconnect (tmux/systemd), port8787, and relay logs.`);
    else if ([401, 403].includes(status)) advice.push(`${stage}: relay rejected this device token or grant; compare the matching pairing files locally; do not send tokens in chat.`);
    else if (status === 409 && result.relayError === 'poll_already_active') advice.push(`${stage}: another poll for this device ID is active; stop duplicate DSH instances before testing. This is expected if a diagnostic poll runs alongside the normal plugin.`);
    else if (status === 429) advice.push(`${stage}: relay mailbox or tunnel rate limit; inspect the limit, do not blindly resend tasks.`);
    else if (status === 404) advice.push(`${stage}: relay route not found; relayUrl must be the tunnel base URL, not /health; check tunnel target and deployed relay.`);
    else if (result.code === 'HTTP_REDIRECT') advice.push(`${stage}: redirect refused; use the final configured HTTPS endpoint, do not disable TLS verification.`);
    else if (result.code === 'REQUEST_TIMEOUT') advice.push(`${stage}: request timed out from this computer; check tunnel, DNS, firewall/proxy and internet access.`);
    else if (result.code === 'INVALID_RELAY_RESPONSE') advice.push(`${stage}: response is not the relay protocol JSON; check wrong target, tunnel interstitial or proxy page.`);
    else advice.push(`${stage}: check network reachability and local relay/Tuna diagnostics; do not disable certificate checks.`);
  }
  return [...new Set(advice)];
}

/** Safe probes: default authentication uses ACK of an EMPTY list, never a task or a real message ACK. */
export async function diagnoseRelay({ relayUrl, relayToken, allowLoopback = false, timeoutMs = 12000, poll = false } = {}) {
  const base = diagnosticBase(relayUrl, allowLoopback);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 || typeof poll !== 'boolean') throw new Error('INVALID_DIAGNOSTIC_OPTIONS');
  if (relayToken !== undefined && (typeof relayToken !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(relayToken))) throw new Error('INVALID_RELAY_TOKEN');
  const checks = { health: await probe(base, 'health', { timeoutMs }) };
  if (checks.health.ok && relayToken !== undefined) {
    checks.auth = await probe(base, 'v1/ack', { relayToken, timeoutMs, body: { ids: [] } });
    if (poll && checks.auth.ok) checks.poll = await probe(base, 'v1/poll', { relayToken, timeoutMs: Math.max(timeoutMs, 16000), body: {} });
  }
  return { checkedAt: new Date().toISOString(), relayOrigin: base.origin, ok: checks.health.ok && checks.auth?.ok === true && (!poll || checks.poll?.ok === true), authenticatedProbe: relayToken === undefined ? 'not-requested' : 'empty-ack-only', checks, advice: adviceFor(checks) };
}

export async function main(argv = process.argv.slice(2)) {
  let configFile; let poll = false; let url;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--config' && !configFile) configFile = argv[++index];
    else if (argv[index] === '--url' && !url) url = argv[++index];
    else if (argv[index] === '--poll') poll = true;
    else throw new Error('Usage: node scripts/relay-diagnose.mjs --config PATH [--poll], or --url HTTPS_URL');
  }
  if (!!configFile === !!url || (poll && !configFile)) throw new Error('Select one --config or --url; --poll needs a config and a stopped endpoint.');
  let settings = { relayUrl: url };
  if (configFile) {
    const file = path.resolve(configFile);
    if ((await stat(file)).size > 128 * 1024) throw new Error('CONFIG_TOO_LARGE');
    try { settings = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('CONFIG_INVALID_JSON'); }
  }
  const result = await diagnoseRelay({ relayUrl: settings.relayUrl, relayToken: settings.relayToken, allowLoopback: settings.allowLoopback, poll });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { if (!result.ok && result.authenticatedProbe !== 'not-requested') process.exitCode = 1; }).catch(() => { console.error('Diagnostic failed: check command arguments and config structure locally. Credentials are never printed.'); process.exitCode = 1; });
}
