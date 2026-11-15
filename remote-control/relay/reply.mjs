/** Transport-neutral JSON reply with synchronous cancellation owned by its transport. */
import { WebSocketServer, WebSocket } from 'ws'
export const RELAY_FRAME_BYTES = 100 * 1024
export const RELAY_SOCKET_PENDING = 16
export const RELAY_SOCKET_PROTOCOL = 'dsh-relay-rpc-v1'
export const RELAY_ROUTES = Object.freeze(['send', 'poll', 'ack', 'live/info', 'live/send', 'live/poll'])

export function createReply(deliver) {
  let closed = false
  const listeners = new Set()
  const close = () => {
    if (closed) return
    closed = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  return {
    get closed() { return closed },
    close,
    onClose(listener) {
      if (closed) { listener(); return () => {} }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    json(status, body) {
      if (closed) return
      if (Buffer.byteLength(JSON.stringify(body)) > RELAY_FRAME_BYTES) { status = 500; body = { error: 'response_too_large' } }
      close()
      deliver(status, body)
    },
  }
}

/** Only this adapter knows the Node HTTP response API. */
export function httpReply(res) {
  const reply = createReply((status, value) => {
    if (res.destroyed || res.writableEnded) return
    const body = JSON.stringify(value)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(body),
      ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) })
    res.end(body)
  })
  res.once('close', reply.close)
  return reply
}

/** Share authenticated relay handlers across HTTP and a bounded socket connection. */
export function attachRelaySockets(server, { authenticate, dispatch }) {
  const sockets = new Set(), stops = new Map(), byDevice = new Map(), handlers = new Set()
  let closed = false
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(RELAY_SOCKET_PROTOCOL) ? RELAY_SOCKET_PROTOCOL : false })
  const reject = (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  const upgrade = (req, socket, head) => {
    if (closed || req.url !== '/v1/socket' || req.headers['sec-websocket-protocol'] !== RELAY_SOCKET_PROTOCOL) return reject(socket, 404)
    let device
    try { device = authenticate(req) } catch { return reject(socket, 401) }
    if ((byDevice.get(device.id) ?? 0) >= 2) return reject(socket, 429)
    try {
      wss.handleUpgrade(req, socket, head, ws => {
        byDevice.set(device.id, (byDevice.get(device.id) ?? 0) + 1)
        const active = new Map(), running = new Set()
        sockets.add(ws)
        const stop = () => { for (const reply of [...active.values()]) reply.close() }
        ws.once('close', () => {
          stop(); sockets.delete(ws); stops.delete(ws)
          const count = (byDevice.get(device.id) ?? 1) - 1
          if (count === 0) byDevice.delete(device.id); else byDevice.set(device.id, count)
        })
        ws.on('error', () => { stop(); ws.terminate() })
        const send = value => {
          if (ws.readyState !== WebSocket.OPEN) return
          const frame = JSON.stringify(value)
          if (Buffer.byteLength(frame) > RELAY_FRAME_BYTES || ws.bufferedAmount > RELAY_FRAME_BYTES * RELAY_SOCKET_PENDING) return ws.terminate()
          ws.send(frame, error => { if (error) ws.terminate() })
        }
        ws.on('message', (buffer, binary) => {
          let value
          try {
            if (binary || buffer.byteLength > RELAY_FRAME_BYTES) throw new Error()
            value = JSON.parse(buffer.toString('utf8'))
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
          } catch { ws.close(1008, 'invalid_frame'); return }
          if (Object.keys(value).length === 1 && typeof value.cancel === 'string') { active.get(value.cancel)?.close(); return }
          if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'route') || !Object.hasOwn(value, 'data')
            || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) || !RELAY_ROUTES.includes(value.route)
            || !value.data || typeof value.data !== 'object' || Array.isArray(value.data) || active.has(value.id)) { ws.close(1008, 'invalid_frame'); return }
          if (active.size >= RELAY_SOCKET_PENDING || running.size >= RELAY_SOCKET_PENDING) { send({ id: value.id, status: 429, body: { error: 'socket_capacity' } }); return }
          const reply = createReply((status, body) => send({ id: value.id, status, body }))
          active.set(value.id, reply)
          reply.onClose(() => { active.delete(value.id) })
          const operation = dispatch(value.route, value.data, device, reply).catch(() => { reply.json(503, { error: 'relay_unavailable' }) })
          handlers.add(operation); running.add(operation)
          void operation.finally(() => { handlers.delete(operation); running.delete(operation) })
        })
        ws.once('error', () => {})
        ws.on('ping', () => { if (ws.bufferedAmount > RELAY_FRAME_BYTES * RELAY_SOCKET_PENDING) ws.terminate() })
        stops.set(ws, stop)
      })
    } catch {
      socket.destroy()
    }
  }
  server.on('upgrade', upgrade)
  return {
    async close() {
      closed = true
      server.off('upgrade', upgrade)
      const stopped = [...sockets].map(ws => new Promise(resolve => { ws.once('close', resolve); stops.get(ws)?.(); ws.terminate() }))
      await Promise.all(stopped)
      while (handlers.size > 0) await Promise.allSettled([...handlers])
      await new Promise(resolve => wss.close(resolve))
    },
  }
}
