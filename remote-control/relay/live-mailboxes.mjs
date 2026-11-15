/** In-memory, at-most-once relay for derived live frames. Reset/loss requires a native rebaseline, never mutation replay. */
import { LIVE_CHANNEL, LIVE_CHANNEL_LIMITS as L, liveCiphertext, liveId, liveKeys } from '../lib/live-channel-protocol.mjs'

export class LiveMailboxError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const reject = (status, code) => { throw new LiveMailboxError(status, code) }
function respond(reply, value) { reply.json(200, value) }

/** Same authenticated peer routing as the durable relay; no persistence, tombstones, or effect ACKs. */
export function createLiveMailboxes(pollMs, maxPending, configuredDevices) {
  const queues = new Map(), polls = new Map()
  let closed = false, expiryTimer
  const pendingLimit = Math.min(maxPending, L.maxPending)
  const waitMs = Math.min(pollMs, L.maxLifetimeMs - L.clockSkewMs)
  const prune = id => {
    const queue = queues.get(id)
    if (queue === undefined) return []
    const now = Date.now(), current = queue.filter(item => item.packet.expiresAt > now)
    if (current.length === 0) queues.delete(id)
    else queues.set(id, current)
    return current
  }
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer)
    let first = Infinity
    for (const id of [...queues.keys()]) for (const item of prune(id)) first = Math.min(first, item.packet.expiresAt)
    if (closed || first === Infinity) return
    expiryTimer = setTimeout(scheduleExpiry, Math.max(1, first - Date.now()))
    expiryTimer.unref()
  }
  const take = id => {
    const queue = prune(id), selected = []
    let bytes = Buffer.byteLength(JSON.stringify({ protocol: LIVE_CHANNEL, items: [] }))
    while (queue.length > 0 && selected.length < L.maxPollItems) {
      const first = queue[0]
      if (bytes + first.bytes + (selected.length ? 1 : 0) > L.maxHttpBytes) break
      queue.shift(); selected.push(first.packet); bytes += first.bytes + (selected.length > 1 ? 1 : 0)
    }
    if (queue.length === 0) queues.delete(id)
    else queues.set(id, queue)
    return selected
  }
  const finish = (poll, items) => {
    if (polls.get(poll.id) !== poll) return
    polls.delete(poll.id); clearTimeout(poll.timer)
    poll.unsubscribe?.()
    respond(poll.res, { protocol: LIVE_CHANNEL, items })
  }
  return {
    info(body, res) {
      if (closed) reject(503, 'live_unavailable')
      if (!liveKeys(body, [])) reject(400, 'invalid_live_info')
      respond(res, { protocol: LIVE_CHANNEL })
    },
    send(body, device, res) {
      if (closed) reject(503, 'live_unavailable')
      if (!liveKeys(body, ['id', 'to', 'ciphertext', 'expiresAt']) || !liveId(body.id) || !liveId(body.to)
        || !liveCiphertext(body.ciphertext) || !Number.isSafeInteger(body.expiresAt)) reject(400, 'invalid_live_packet')
      if (body.to !== device.peerId || configuredDevices.get(body.to)?.peerId !== device.id) reject(403, 'peer_not_allowed')
      const now = Date.now()
      if (body.expiresAt <= now || body.expiresAt > now + L.maxLifetimeMs + L.clockSkewMs) reject(400, 'invalid_live_lifetime')
      const packet = { id: body.id, from: device.id, to: body.to, ciphertext: body.ciphertext, expiresAt: body.expiresAt }
      const bytes = Buffer.byteLength(JSON.stringify(packet)), queue = prune(body.to)
      if (bytes + Buffer.byteLength(JSON.stringify({ protocol: LIVE_CHANNEL, items: [] })) > L.maxHttpBytes) reject(413, 'live_packet_too_large')
      const same = queue.find(item => item.packet.id === body.id)
      if (same !== undefined) {
        if (JSON.stringify(same.packet) !== JSON.stringify(packet)) reject(409, 'live_id_conflict')
        respond(res, { accepted: true }); return
      }
      if (queue.length >= pendingLimit || queue.reduce((sum, item) => sum + item.bytes + 1, 2) + bytes + 1 > L.maxBufferBytes) reject(429, 'live_mailbox_full')
      queue.push({ packet, bytes }); queues.set(body.to, queue); scheduleExpiry()
      respond(res, { accepted: true })
      const poll = polls.get(body.to)
      if (poll !== undefined) finish(poll, take(body.to))
    },
    poll(body, device, res) {
      if (closed) reject(503, 'live_unavailable')
      if (!liveKeys(body, [])) reject(400, 'invalid_live_poll')
      if (polls.has(device.id)) reject(409, 'live_poll_already_active')
      const current = { id: device.id, res, timer: undefined, cancel: undefined }
      current.cancel = () => {
        if (polls.get(device.id) !== current) return
        polls.delete(device.id); clearTimeout(current.timer)
      }
      polls.set(device.id, current); current.unsubscribe = res.onClose(current.cancel)
      const items = take(device.id)
      if (items.length > 0 || waitMs === 0) { finish(current, items); return }
      current.timer = setTimeout(() => { finish(current, take(device.id)) }, waitMs)
      current.timer.unref()
    },
    close() {
      closed = true; clearTimeout(expiryTimer)
      for (const poll of [...polls.values()]) finish(poll, [])
      queues.clear()
    },
  }
}
