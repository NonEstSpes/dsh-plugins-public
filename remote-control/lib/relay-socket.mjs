/** Private Node carrier for the existing authenticated relay routes; never replays a published request. */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'

const LIMIT = 100 * 1024, PENDING = 16, PROTOCOL = 'dsh-relay-rpc-v1'
const ROUTES = ['send', 'poll', 'ack', 'live/info', 'live/send', 'live/poll']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = code => Object.assign(new Error(`Relay socket: ${code}`), { code })

/** Open is local; only request() can connect or publish. undefined authorizes legacy HTTPS only before publication. */
export function openRelaySocket(settings) {
  const mode = settings.relayTransport === undefined ? 'https' : settings.relayTransport
  if (!['https', 'auto'].includes(mode) || (mode === 'https' && settings.relaySocketConnectTimeoutMs !== undefined)) throw fault('INVALID_SOCKET_SETTINGS')
  let url
  if (mode === 'auto') {
    if (!Number.isSafeInteger(settings.relaySocketConnectTimeoutMs) || settings.relaySocketConnectTimeoutMs <= 0
      || !Number.isSafeInteger(settings.requestTimeoutMs) || settings.requestTimeoutMs <= 0
      || settings.relaySocketConnectTimeoutMs > settings.requestTimeoutMs || settings.requestTimeoutMs > 60000
      || typeof settings.relayToken !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(settings.relayToken)) throw fault('INVALID_SOCKET_SETTINGS')
    const input = settings.relayUrl
    if (typeof input !== 'string' || /[\s\\?#]/.test(input)) throw fault('INVALID_RELAY_URL')
    try { url = new URL(input) } catch { throw fault('INVALID_RELAY_URL') }
    const authority = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)?.[1]
    if (!authority || authority.includes('@') || url.username || url.password || !url.hostname || url.search || url.hash
      || (url.protocol !== 'https:' && !(settings.allowLoopback === true && url.protocol === 'http:'
        && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority)))) throw fault('INVALID_RELAY_URL')
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    url = new URL('v1/socket', url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  const pending = new Map(), operations = new Set()
  const counters = { requestsSent: 0, framesSent: 0, framesReceived: 0, bytesSent: 0, bytesReceived: 0 }
  let socket, connecting, closed = false, connected = false, supported, retryAt = 0, authFailed = false, closing
  const rejectPending = code => { for (const entry of [...pending.values()]) entry.finish(undefined, fault(code)) }
  const sendFrame = (ws, frame) => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > LIMIT * PENDING) throw fault('SOCKET_DISCONNECTED')
    counters.framesSent++; counters.bytesSent += Buffer.byteLength(frame)
    ws.send(frame, error => { if (error) { rejectPending('SOCKET_DISCONNECTED'); ws.terminate() } })
  }
  function connect() {
    if (closed) return Promise.reject(fault('SOCKET_CLOSED'))
    if (authFailed) return Promise.reject(fault('RELAY_AUTH_FAILED'))
    if (supported === false || Date.now() < retryAt) return Promise.resolve(undefined)
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
    if (connecting) return connecting
    const result = Promise.withResolvers()
    connecting = result.promise
    const ws = new WebSocket(url, PROTOCOL, { headers: { Authorization: `Bearer ${settings.relayToken}` },
      followRedirects: false, perMessageDeflate: false, maxPayload: LIMIT })
    socket = ws
    let settled = false
    const timer = setTimeout(() => { finish(); ws.terminate() }, settings.relaySocketConnectTimeoutMs)
    const finish = (value, error) => {
      if (settled) return
      settled = true; clearTimeout(timer); connecting = undefined
      if (value === undefined && supported !== false) retryAt = Date.now() + settings.relaySocketConnectTimeoutMs
      if (error) result.reject(error); else result.resolve(value)
    }
    ws.once('open', () => {
      if (closed) { finish(); ws.terminate(); return }
      connected = true; supported = true; retryAt = 0; finish(ws)
    })
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      if (status === 401 || status === 403) { authFailed = true; finish(undefined, fault('RELAY_AUTH_FAILED')) }
      else { if (status === 404 || status === 426) supported = false; finish() }
      ws.terminate()
    })
    ws.on('message', (buffer, binary) => {
      if (socket !== ws || closed) return
      counters.framesReceived++; counters.bytesReceived += buffer.byteLength
      let value
      try {
        if (binary || buffer.byteLength > LIMIT) throw new Error()
        value = JSON.parse(buffer.toString('utf8'))
        if (!object(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'status')
          || !Object.hasOwn(value, 'body') || typeof value.id !== 'string' || !Number.isSafeInteger(value.status)
          || value.status < 100 || value.status > 599) throw new Error()
      } catch { rejectPending('INVALID_SOCKET_RESPONSE'); ws.terminate(); return }
      pending.get(value.id)?.finish({ status: value.status, body: value.body })
    })
    ws.on('error', () => {
      finish()
      if (socket === ws) { rejectPending('SOCKET_DISCONNECTED'); if (!closed && supported !== false) retryAt = Date.now() + settings.relaySocketConnectTimeoutMs }
      ws.terminate()
    })
    ws.once('close', () => {
      finish()
      if (socket === ws) {
        connected = false; rejectPending(closed ? 'SOCKET_CLOSED' : 'SOCKET_DISCONNECTED')
        if (!closed && supported !== false) retryAt = Date.now() + settings.relaySocketConnectTimeoutMs
      }
    })
    return result.promise
  }
  async function run(route, data, signal, beforePublish) {
    if (closed) throw fault('SOCKET_CLOSED')
    if (signal?.aborted) throw fault('REQUEST_ABORTED')
    if (mode === 'https') return undefined
    if (!ROUTES.includes(route) || !object(data)) throw fault('INVALID_SOCKET_FRAME')
    const id = randomUUID()
    let frame
    try { frame = JSON.stringify({ id, route, data }) } catch { throw fault('INVALID_SOCKET_FRAME') }
    if (Buffer.byteLength(frame) > LIMIT) throw fault('SOCKET_FRAME_TOO_LARGE')
    let abortConnect
    const aborted = new Promise((_resolve, reject) => {
      abortConnect = () => reject(fault('REQUEST_ABORTED'))
      signal?.addEventListener('abort', abortConnect, { once: true })
    })
    let ws
    try { ws = await Promise.race([connect(), aborted]) } finally { signal?.removeEventListener('abort', abortConnect) }
    if (closed) throw fault('SOCKET_CLOSED')
    if (signal?.aborted) throw fault('REQUEST_ABORTED')
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined
    return new Promise((resolve, reject) => {
      let done = false
      const cancel = code => {
        try { sendFrame(ws, JSON.stringify({ cancel: id })) } catch { ws.terminate() }
        finish(undefined, fault(code))
      }
      const abort = () => cancel('REQUEST_ABORTED')
      const timer = setTimeout(() => cancel('SOCKET_TIMEOUT'), settings.requestTimeoutMs)
      const finish = (value, error) => {
        if (done) return
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id)
        if (error) reject(error); else resolve(value)
      }
      pending.set(id, { finish }); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try { beforePublish?.() } catch (error) { finish(undefined, error); return }
      try { counters.requestsSent++; sendFrame(ws, frame) } catch { finish(undefined, fault('SOCKET_DISCONNECTED')); ws.terminate() }
    })
  }
  return {
    request(route, data, signal, beforePublish) {
      if (operations.size >= PENDING) return Promise.reject(fault('SOCKET_CAPACITY'))
      const operation = run(route, data, signal, beforePublish)
      operations.add(operation)
      void operation.then(() => operations.delete(operation), () => operations.delete(operation))
      return operation
    },
    status() { return { mode, connected, supported: supported ?? null, backoff: !closed && Date.now() < retryAt, closed, pending: pending.size, ...counters } },
    close() {
      if (closing) return closing
      closed = true; rejectPending('SOCKET_CLOSED')
      const ws = socket
      closing = (async () => {
        if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise(resolve => { ws.once('close', resolve); ws.terminate() })
        while (operations.size > 0) await Promise.allSettled([...operations])
      })()
      return closing
    },
  }
}
