/** Disposable authenticated read delivery. No filesystem, durable outbox, mutation handler, or application ACK. */
import { randomUUID, createHash } from 'node:crypto'
import { CompactEncrypt, compactDecrypt } from 'jose'
import { canonicalJson } from './federation/journal.mjs'
import { LIVE_CHANNEL, LIVE_CHANNEL_LIMITS as L, liveCiphertext, liveId, liveKeys, liveRecord } from './live-channel-protocol.mjs'
import { openRelaySocket } from './relay-socket.mjs'

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
class ChannelError extends Error { constructor(code) { super(`Live channel: ${code}`); this.code = code } }
const fail = code => { throw new ChannelError(code) }
function relayBase(settings) {
  const input = settings.relayUrl
  if (typeof input !== 'string' || !input || /[\s\\?#]/.test(input)) fail('INVALID_RELAY_URL')
  let url
  try { url = new URL(input) } catch { fail('INVALID_RELAY_URL') }
  const authority = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)?.[1]
  if (!authority || authority.includes('@') || url.username || url.password) fail('INVALID_RELAY_URL')
  if (url.protocol !== 'https:' && (url.protocol !== 'http:' || settings.allowLoopback !== true
    || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority))) fail('HTTPS_REQUIRED')
  if (!url.hostname || url.search || url.hash) fail('INVALID_RELAY_URL')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}
function bodyText(body) {
  if (!liveRecord(body) || !['open', 'pull', 'data', 'stop', 'end'].includes(body.type)) fail('INVALID_LIVE_BODY')
  let text
  try { text = canonicalJson(body) } catch { fail('INVALID_LIVE_BODY') }
  if (Buffer.byteLength(text) > L.maxFrameBytes) fail('MESSAGE_TOO_LARGE')
  return text
}

/** Open is local only. start probes the exact new relay protocol before any live data is sent. */
export function openLiveChannel(settings, { onMessage, onError = () => {} } = {}) {
  if (!liveRecord(settings) || settings.protocol !== 2 || !['controller', 'worker'].includes(settings.role)
    || !liveId(settings.id) || !liveId(settings.peerId) || settings.id === settings.peerId
    || !Number.isSafeInteger(settings.pairingGeneration) || settings.pairingGeneration < 1
    || typeof settings.relayToken !== 'string' || /^[a-zA-Z0-9._~-]{16,512}$/.exec(settings.relayToken)?.[0] !== settings.relayToken
    || typeof settings.sharedKey !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(settings.sharedKey)
    || (settings.allowLoopback !== undefined && typeof settings.allowLoopback !== 'boolean')) fail('INVALID_SETTINGS')
  if (typeof onMessage !== 'function' || typeof onError !== 'function') fail('INVALID_HANDLERS')
  const key = Buffer.from(settings.sharedKey, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== settings.sharedKey) fail('INVALID_SHARED_KEY')
  let base
  try { base = relayBase(settings) } catch (error) { key.fill(0); throw error }
  const { id, peerId, pairingGeneration, relayToken } = settings
  const fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') { key.fill(0); fail('FETCH_UNAVAILABLE') }
  let relaySocket
  try { relaySocket = openRelaySocket(settings) } catch (error) { key.fill(0); throw error }
  const lifetime = new AbortController(), operations = new Set(), seen = new Map()
  let closed = false, running = false, supported, starting, polling, closing, lastError = null
  const report = code => {
    lastError = { code, at: new Date().toISOString() }
    try {
      void Promise.resolve(onError({ ...lastError })).catch((_error) => { /* Async diagnostic rejection cannot leak private errors or escape its owner. */ })
    } catch (_error) { /* Synchronous diagnostics cannot affect channel ownership. */ }
  }
  const prune = () => {
    const now = Date.now()
    for (const [packetId, item] of seen) if (item.until <= now) seen.delete(packetId)
  }
  async function request(route, value, callerSignal, beforePublish) {
    if (closed) fail('CHANNEL_CLOSED')
    if (callerSignal?.aborted) fail('REQUEST_ABORTED')
    const controller = new AbortController()
    const abort = () => { controller.abort() }
    lifetime.signal.addEventListener('abort', abort, { once: true })
    callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, L.maxLifetimeMs)
    let reader, publicationFailure
    try {
      const body = JSON.stringify(value)
      if (Buffer.byteLength(body) > L.maxHttpBytes) fail('REQUEST_TOO_LARGE')
      const socketReply = await relaySocket.request(`live/${route}`, value, controller.signal, () => {
        try { beforePublish?.() } catch (error) { publicationFailure = { error }; throw error }
      })
      if (socketReply !== undefined) {
        if (socketReply.status === 404 && route === 'info') fail('LIVE_UNSUPPORTED')
        if (socketReply.status >= 300 && socketReply.status < 400) fail('HTTP_REDIRECT')
        if (socketReply.status < 200 || socketReply.status >= 300) fail(socketReply.status === 401 || socketReply.status === 403 ? 'RELAY_AUTH_FAILED'
          : socketReply.status === 429 ? 'LIVE_CAPACITY' : 'RELAY_HTTP_ERROR')
        return socketReply.body
      }
      try { beforePublish?.() } catch (error) { publicationFailure = { error }; throw error }
      const response = await fetchImpl(new URL(`v1/live/${route}`, base), { method: 'POST', redirect: 'manual',
        credentials: 'omit', cache: 'no-store', headers: { authorization: `Bearer ${relayToken}`,
          'content-type': 'application/json', accept: 'application/json' }, body, signal: controller.signal })
      if (response.status === 404 && route === 'info') fail('LIVE_UNSUPPORTED')
      if (response.status >= 300 && response.status < 400) fail('HTTP_REDIRECT')
      if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'RELAY_AUTH_FAILED'
        : response.status === 429 ? 'LIVE_CAPACITY' : 'RELAY_HTTP_ERROR')
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('INVALID_RELAY_RESPONSE')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > L.maxHttpBytes)) fail('RESPONSE_TOO_LARGE')
      if (!response.body || typeof response.body.getReader !== 'function') fail('INVALID_RELAY_RESPONSE')
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > L.maxHttpBytes) fail('RESPONSE_TOO_LARGE')
        chunks.push(part.value)
      }
      try { return JSON.parse(decoder.decode(Buffer.concat(chunks, size))) } catch { fail('INVALID_RELAY_RESPONSE') }
    } catch (error) {
      if (publicationFailure !== undefined) throw publicationFailure.error
      if (error instanceof ChannelError) throw error
      if (error?.code === 'RELAY_AUTH_FAILED') fail('RELAY_AUTH_FAILED')
      if (error?.code === 'SOCKET_CAPACITY') fail('LIVE_CAPACITY')
      if (error?.code === 'INVALID_SOCKET_RESPONSE') fail('INVALID_RELAY_RESPONSE')
      fail(controller.signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_FAILURE')
    } finally {
      clearTimeout(timer); controller.abort()
      lifetime.signal.removeEventListener('abort', abort); callerSignal?.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => {})
    }
  }
  async function receive(packet) {
    if (!liveKeys(packet, ['id', 'from', 'to', 'ciphertext', 'expiresAt']) || !liveId(packet.id)
      || packet.from !== peerId || packet.to !== id || !liveCiphertext(packet.ciphertext)
      || !Number.isSafeInteger(packet.expiresAt)) fail('INVALID_PACKET')
    prune()
    const digest = createHash('sha256').update(packet.ciphertext).digest('hex'), previous = seen.get(packet.id)
    if (previous !== undefined) {
      if (previous.digest !== digest || previous.expiresAt !== packet.expiresAt) fail('ID_COLLISION')
      return
    }
    let result
    try { result = await compactDecrypt(packet.ciphertext, key, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] }) }
    catch { fail('INVALID_CRYPTO') }
    if (!liveKeys(result.protectedHeader, ['alg', 'enc', 'typ']) || result.protectedHeader.alg !== 'dir'
      || result.protectedHeader.enc !== 'A256GCM' || result.protectedHeader.typ !== LIVE_CHANNEL
      || result.plaintext.byteLength > L.maxPlaintextBytes) fail('INVALID_CRYPTO')
    let envelope
    try { envelope = JSON.parse(decoder.decode(result.plaintext)) } catch { fail('INVALID_ENVELOPE') }
    const now = Date.now()
    if (!liveKeys(envelope, ['version', 'id', 'from', 'to', 'pairingGeneration', 'createdAt', 'expiresAt', 'purpose', 'body'])
      || envelope.version !== 1 || envelope.purpose !== LIVE_CHANNEL || envelope.id !== packet.id
      || envelope.from !== peerId || envelope.to !== id || envelope.pairingGeneration !== pairingGeneration
      || !Number.isSafeInteger(envelope.createdAt) || !Number.isSafeInteger(envelope.expiresAt)
      || envelope.expiresAt !== packet.expiresAt || envelope.expiresAt <= envelope.createdAt
      || envelope.expiresAt - envelope.createdAt > L.maxLifetimeMs || envelope.createdAt > now + L.clockSkewMs
      || envelope.expiresAt <= now) fail('INVALID_ENVELOPE')
    bodyText(envelope.body)
    if (seen.size >= L.maxReplayRecords) fail('REPLAY_CAPACITY')
    // Reserve before the callback. This channel must never retry an application effect.
    seen.set(packet.id, { digest, expiresAt: envelope.expiresAt, until: envelope.expiresAt + L.clockSkewMs })
    try { await onMessage(envelope.body, lifetime.signal) } catch { fail('HANDLER_FAILED') }
  }
  const track = promise => {
    operations.add(promise)
    void promise.then(() => { operations.delete(promise) }, () => { operations.delete(promise) })
    return promise
  }
  async function idle() {
    if (!running || lifetime.signal.aborted) return
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, L.minEmptyPollMs)
      lifetime.signal.addEventListener('abort', finish, { once: true })
      if (lifetime.signal.aborted) finish()
    })
  }
  async function poll() {
    while (running) {
      try {
        prune()
        const response = await request('poll', {})
        if (!liveKeys(response, ['protocol', 'items']) || response.protocol !== LIVE_CHANNEL
          || !Array.isArray(response.items) || response.items.length > L.maxPollItems) fail('INVALID_RELAY_RESPONSE')
        for (const packet of response.items) {
          if (!running) break
          await receive(packet)
        }
        lastError = null
        if (response.items.length === 0) await idle()
      } catch (error) {
        if (!running || closed) break
        // Retire the carrier; the owner must abandon/rebaseline its derived streams, never replay mutations.
        running = false
        report(error instanceof ChannelError ? error.code : 'CHANNEL_FAILED')
      }
    }
  }
  async function send(body, signal, beforePublish) {
    if (closed || !running || supported !== true) fail(closed ? 'CHANNEL_CLOSED' : 'LIVE_UNAVAILABLE')
    const serialized = bodyText(body), now = Date.now(), packetId = randomUUID(), expiresAt = now + L.maxLifetimeMs
    const envelope = { version: 1, id: packetId, from: id, to: peerId, pairingGeneration,
      createdAt: now, expiresAt, purpose: LIVE_CHANNEL, body: JSON.parse(serialized) }
    const plaintext = encoder.encode(JSON.stringify(envelope))
    if (plaintext.byteLength > L.maxPlaintextBytes) fail('MESSAGE_TOO_LARGE')
    const ciphertext = await new CompactEncrypt(plaintext).setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: LIVE_CHANNEL }).encrypt(key)
    if (!liveCiphertext(ciphertext)) fail('MESSAGE_TOO_LARGE')
    if (closed || !running || signal?.aborted) fail(signal?.aborted ? 'REQUEST_ABORTED' : 'LIVE_UNAVAILABLE')
    const response = await request('send', { id: packetId, to: peerId, ciphertext, expiresAt }, signal, beforePublish)
    if (!liveKeys(response, ['accepted']) || response.accepted !== true) fail('INVALID_RELAY_RESPONSE')
    return { id: packetId }
  }
  return {
    start() {
      if (closed) return Promise.reject(new ChannelError('CHANNEL_CLOSED'))
      if (running) return Promise.resolve(true)
      if (starting !== undefined) return starting
      starting = track((async () => {
        try {
          const value = await request('info', {})
          if (!liveKeys(value, ['protocol']) || value.protocol !== LIVE_CHANNEL) fail('INVALID_RELAY_RESPONSE')
          if (closed) fail('CHANNEL_CLOSED')
          supported = true; running = true; lastError = null
          polling = poll()
          return true
        } catch (error) {
          supported = error instanceof ChannelError && error.code === 'LIVE_UNSUPPORTED' ? false : undefined
          if (!closed && supported !== false) report(error instanceof ChannelError ? error.code : 'CHANNEL_FAILED')
          return false
        }
      })())
      void starting.finally(() => { starting = undefined })
      return starting
    },
    send(body, signal, beforePublish) {
      if (operations.size >= L.maxPending) return Promise.reject(new ChannelError('SEND_CAPACITY'))
      return track(send(body, signal, beforePublish))
    },
    close() {
      if (closing !== undefined) return closing
      closed = true; running = false; lifetime.abort()
      closing = (async () => {
        await Promise.allSettled([relaySocket.close(), ...operations, polling].filter(Boolean))
        seen.clear(); key.fill(0)
      })()
      return closing
    },
    status() { return { supported, running, closed, pending: operations.size, replayRecords: seen.size,
      lastError: lastError === null ? null : { ...lastError }, transport: relaySocket.status() } },
  }
}
