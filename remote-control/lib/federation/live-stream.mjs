/** Leased, single-credit read transport over a borrowed authenticated derived channel. */
import { createHash, randomUUID } from 'node:crypto'
import { FederationContractError, parseSessionRef, sameSessionRef } from './identity.mjs'
import { canonicalJson } from './journal.mjs'
import { decodeExportCursor, FAILURE_CODES as F, NATIVE_HISTORY_FORMATS, PROTOCOL_LIMITS as P } from './protocol.mjs'
import { LIVE_CHANNEL_LIMITS as L, liveId } from '../live-channel-protocol.mjs'

const MAX_ACTIVE = 16, MAX_GUARDS = 8192
const GUARD_MS = L.maxLifetimeMs + L.clockSkewMs
const CODES = new Set(Object.values(F))
const MESSAGE = 'live source stream failed'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const error = code => new FederationContractError(CODES.has(code) ? code : F.SOURCE_UNAVAILABLE, MESSAGE)
const codeOf = value => value instanceof FederationContractError && CODES.has(value.code) ? value.code : F.SOURCE_UNAVAILABLE
const reject = code => { throw error(code) }
function freeze(value) {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function snapshot(value) { return freeze(JSON.parse(canonicalJson(value))) }
function size(value) { return Buffer.byteLength(canonicalJson(value), 'utf8') }
function exact(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some(key => !required.includes(key) && !optional.includes(key))) reject(F.INVALID_MESSAGE)
}
function authority(value) {
  exact(value, ['generation', 'grantRevision'])
  if (!count(value.generation) || !count(value.grantRevision)) reject(F.INVALID_MESSAGE)
  return value
}
function spec(value) {
  exact(value, ['ref', 'authority', 'request'])
  const ref = parseSessionRef(value.ref), current = authority(value.authority), request = value.request
  exact(request, ['includeAssistantStream'], ['after'])
  if (request.includeAssistantStream !== true) reject(F.ACTION_UNSUPPORTED)
  if (Object.hasOwn(request, 'after')) {
    if (typeof request.after !== 'string' || !request.after.startsWith('fec2.')) reject(F.CURSOR_STALE)
    decodeExportCursor(request.after, { ...ref, ...current, format: NATIVE_HISTORY_FORMATS.DETAILS })
  }
  return snapshot({ ref, authority: current, request })
}
function body(value) {
  const copied = snapshot(value)
  if (size(copied) > P.maxFrameBytes) reject(F.PAGE_TOO_LARGE)
  const common = ['version', 'type', 'id', 'ref', 'authority']
  if (!object(copied) || copied.version !== 1 || !liveId(copied.id)) reject(F.INVALID_MESSAGE)
  switch (copied.type) {
    case 'open':
      exact(copied, [...common, 'request', 'createdAt', 'expiresAt'])
      spec({ ref: copied.ref, authority: copied.authority, request: copied.request })
      if (!count(copied.createdAt) || !count(copied.expiresAt) || copied.expiresAt - copied.createdAt !== L.maxLifetimeMs) reject(F.INVALID_MESSAGE)
      break
    case 'pull': exact(copied, [...common, 'index']); break
    case 'data': exact(copied, [...common, 'index', 'frame']); break
    case 'stop': exact(copied, common); break
    case 'end':
      exact(copied, [...common, 'index'], ['code'])
      if (Object.hasOwn(copied, 'code') && !CODES.has(copied.code)) reject(F.INVALID_MESSAGE)
      break
    default: reject(F.INVALID_MESSAGE)
  }
  parseSessionRef(copied.ref); authority(copied.authority)
  if (copied.type !== 'open' && copied.type !== 'stop' && !count(copied.index)) reject(F.INVALID_MESSAGE)
  return copied
}
function frameScope(frame, entry) {
  if (!object(frame) || !['snapshot', 'records', 'assistant-stream'].includes(frame.type)) reject(F.INVALID_MESSAGE)
  const scope = frame.type === 'snapshot' ? frame.page : frame
  if (!object(scope) || scope.generation !== entry.authority.generation || scope.grantRevision !== entry.authority.grantRevision) reject(F.GRANT_CHANGED)
  if (frame.type === 'snapshot' && (!object(frame.header) || frame.header.id !== entry.ref.sessionId)) reject(F.GRANT_CHANGED)
}
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')

/**
 * @param {import('./live-stream.mjs').LiveStreamsOptions} options - borrowed channel and explicit Runtime policy/authority callbacks.
 * @returns {import('./live-stream.mjs').LiveStreams} isolated credit state; Native mapping and durable ACKs stay outside it.
 */
export function createLiveStreams({ role, channel, timeoutMs, open, check }) {
  if (!['controller', 'worker'].includes(role) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !channel || typeof channel.send !== 'function' || typeof channel.status !== 'function'
    || (open !== undefined && typeof open !== 'function') || (check !== undefined && typeof check !== 'function')) reject(F.INVALID_MESSAGE)
  const cadence = Math.max(1, Math.floor(Math.min(timeoutMs / 2, (L.maxLifetimeMs - L.clockSkewMs) / 2)))
  const leaseMs = 2 * cadence + GUARD_MS
  const states = new Map(), tasks = new Set(), transient = new Set()
  let closing = false, closingPromise, timer, retainedBytes = 0, admissionBlockedUntil = 0
  const now = () => Date.now()
  const tracked = promise => {
    tasks.add(promise)
    void promise.then(() => { tasks.delete(promise) }, () => { tasks.delete(promise) })
    return promise
  }
  const base = (entry, type, extra = {}) => ({ version: 1, type, id: entry.id, ref: entry.ref, authority: entry.authority, ...extra })
  const terminalBody = entry => base(entry, 'end', { index: entry.index, ...(entry.terminal.code === undefined ? {} : { code: entry.terminal.code }) })
  const wake = entry => { const notify = entry.wake; entry.wake = undefined; notify?.() }
  const healthy = () => {
    const status = channel.status()
    if (!status.running || status.closed || status.supported === false) reject(F.SOURCE_UNAVAILABLE)
  }
  const current = entry => {
    if (closing || !entry.active) reject(F.SOURCE_UNAVAILABLE)
    healthy()
    if (typeof check !== 'function') reject(F.ACTION_UNSUPPORTED)
    check(entry.ref, entry.authority)
  }
  const same = (entry, packet) => {
    if (!sameSessionRef(entry.ref, packet.ref) || entry.authority.generation !== packet.authority.generation
      || entry.authority.grantRevision !== packet.authority.grantRevision) reject(F.GRANT_CHANGED)
  }
  const clearCache = entry => {
    if (entry.cache !== undefined) { retainedBytes -= entry.cache.bytes; entry.cache = undefined }
  }
  const cache = (entry, packet) => {
    const bytes = size(packet)
    if (retainedBytes + bytes > P.maxFollowBufferBytes) reject(F.PAGE_TOO_LARGE)
    entry.cache = { body: packet, bytes, digest: digest(packet) }
    retainedBytes += bytes
  }
  const busy = entry => entry.reading || entry.returning || entry.sending
  const schedule = () => {
    clearTimeout(timer); timer = undefined
    if (closing) return
    let next = Infinity
    for (const entry of states.values()) {
      if (entry.active) {
        if (role === 'worker') next = Math.min(next, entry.leaseUntil)
        else if (entry.started) next = Math.min(next, entry.heartbeatAt)
      } else if (!busy(entry)) next = Math.min(next, entry.until)
    }
    if (Number.isFinite(next)) timer = setTimeout(tick, Math.max(1, next - now()))
  }
  const transientSend = packet => {
    if (transient.size >= MAX_ACTIVE) return
    const controller = new AbortController()
    transient.add(controller)
    const operation = (async () => {
      const deadline = setTimeout(() => controller.abort(), Math.min(timeoutMs, L.maxLifetimeMs))
      try { await channel.send(packet, controller.signal) } catch (_error) { /* Static terminal delivery is best-effort. */ }
      finally { clearTimeout(deadline); transient.delete(controller) }
    })()
    tracked(operation)
  }
  const send = (entry, packet) => {
    // One in-flight send and one replacement intent; DATA retries share the cached immutable body.
    entry.outgoing = packet
    if (entry.sending) return
    entry.sending = true
    const operation = (async () => {
      try {
        while (entry.outgoing !== undefined) {
          const pending = entry.outgoing
          entry.outgoing = undefined
          const terminal = pending.type === 'stop' || pending.type === 'end'
          if (!terminal) current(entry)
          const controller = new AbortController()
          entry.sendAbort = controller
          const deadline = setTimeout(() => controller.abort(), Math.min(timeoutMs, L.maxLifetimeMs))
          try {
            if (pending.type === 'data') frameScope(pending.frame, entry)
            const beforePublish = terminal ? undefined : () => {
              current(entry)
              if (pending.type === 'data') frameScope(pending.frame, entry)
            }
            await channel.send(pending, controller.signal, beforePublish)
            if (!terminal) current(entry)
          } catch (failure) {
            if (entry.active) retire(entry, codeOf(failure), true)
          } finally { clearTimeout(deadline); if (entry.sendAbort === controller) entry.sendAbort = undefined }
        }
      } catch (failure) {
        if (entry.active) retire(entry, codeOf(failure), true)
      } finally {
        entry.sending = false
        if (entry.outgoing !== undefined) { const next = entry.outgoing; entry.outgoing = undefined; send(entry, next) }
        schedule()
      }
    })()
    tracked(operation)
  }
  const closeIterator = entry => {
    if (entry.iterator === undefined || entry.returning || entry.returned) return
    entry.returning = true
    const operation = (async () => {
      try { await entry.iterator.return?.() } catch (_error) { /* The first terminal reason owns failure; cleanup diagnostics stay private. */ }
      finally { entry.returning = false; entry.returned = true; entry.iterator = undefined; schedule() }
    })()
    tracked(operation)
  }
  const retire = (entry, code, notify) => {
    if (!entry.active) return
    entry.active = false
    entry.terminal = { code }
    entry.until = Math.max(now() + GUARD_MS, (entry.openBody?.expiresAt ?? 0) + L.clockSkewMs)
    entry.abort.abort()
    if (entry.callerSignal !== undefined) entry.callerSignal.removeEventListener('abort', entry.callerAbort)
    entry.sendAbort?.abort()
    clearCache(entry)
    entry.outgoing = undefined
    wake(entry)
    if (role === 'worker') closeIterator(entry)
    if (notify && entry.started) send(entry, role === 'worker' ? terminalBody(entry) : base(entry, 'stop'))
    schedule()
  }
  const prune = () => {
    const time = now()
    for (const [id, entry] of states) if (!entry.active && entry.until <= time && !busy(entry)) {
      states.delete(id); retainedBytes -= entry.baseBytes
    }
  }
  const allocate = (id, reference, original) => {
    prune()
    const baseBytes = size(original) * 2
    if (now() < admissionBlockedUntil || [...states.values()].filter(entry => entry.active).length >= MAX_ACTIVE
      || states.size >= MAX_GUARDS || retainedBytes + baseBytes > P.maxFollowBufferBytes) {
      if (role === 'worker') admissionBlockedUntil = Math.max(admissionBlockedUntil, now() + GUARD_MS)
      reject(F.PAGE_TOO_LARGE)
    }
    const entry = { id, ...reference, index: 0, active: true, started: false, abort: new AbortController(), baseBytes,
      leaseUntil: now() + leaseMs, heartbeatAt: now() + cadence, reading: false, returning: false, sending: false,
      lastIndex: -1, lastDigest: undefined, yielded: false, responded: false }
    retainedBytes += baseBytes; states.set(id, entry)
    return entry
  }
  const read = entry => {
    if (!entry.active || entry.reading || entry.cache !== undefined) return
    entry.reading = true
    const operation = Promise.resolve().then(async () => {
      try {
        current(entry)
        if (entry.iterator === undefined) {
          if (typeof open !== 'function') reject(F.ACTION_UNSUPPORTED)
          const wrapFrame = frame => { current(entry); return base(entry, 'data', { index: entry.index, frame }) }
          const source = open(entry.spec, entry.abort.signal, wrapFrame)
          current(entry)
          entry.iterator = source[Symbol.asyncIterator]()
        }
        current(entry)
        const result = await entry.iterator.next()
        current(entry)
        if (result.done) { retire(entry, undefined, true); return }
        frameScope(result.value, entry)
        const packet = body(base(entry, 'data', { index: entry.index, frame: result.value }))
        current(entry)
        cache(entry, packet)
        send(entry, packet)
      } catch (failure) { if (entry.active) retire(entry, codeOf(failure), true) }
      finally { entry.reading = false; if (!entry.active) closeIterator(entry); schedule() }
    })
    tracked(operation)
  }
  const heartbeat = entry => {
    current(entry)
    const packet = !entry.responded && now() < entry.openBody.expiresAt ? entry.openBody : base(entry, 'pull', { index: entry.index })
    send(entry, packet)
    entry.heartbeatAt = now() + cadence
  }
  function tick() {
    timer = undefined
    prune()
    for (const entry of states.values()) {
      if (!entry.active) continue
      try {
        if (role === 'worker' && entry.leaseUntil <= now()) retire(entry, F.SOURCE_UNAVAILABLE, true)
        else if (role === 'controller' && entry.started && entry.heartbeatAt <= now()) heartbeat(entry)
      } catch (failure) { retire(entry, codeOf(failure), true) }
    }
    schedule()
  }
  const stopUnknown = packet => {
    try {
      const entry = allocate(packet.id, { ref: packet.ref, authority: packet.authority }, packet)
      entry.started = true
      retire(entry, F.SOURCE_UNAVAILABLE, true)
    } catch (_error) {
      // Capacity fences new admissions for the entire flight window rather than evicting a fresh STOP guard.
      admissionBlockedUntil = Math.max(admissionBlockedUntil, now() + GUARD_MS)
    }
  }
  const receiveWorker = packet => {
    let entry = states.get(packet.id)
    if (entry !== undefined) same(entry, packet)
    if (packet.type === 'stop') {
      if (entry === undefined) { stopUnknown(packet); return }
      if (entry.active) {
        try { current(entry) } catch (failure) { retire(entry, codeOf(failure), true); return }
        retire(entry, F.SOURCE_UNAVAILABLE, true)
      } else send(entry, terminalBody(entry))
      return
    }
    if (packet.type === 'open') {
      const hash = digest(packet)
      if (entry !== undefined) {
        if (entry.openDigest !== undefined && entry.openDigest !== hash) reject(F.HISTORY_GAP)
        if (!entry.active) { send(entry, terminalBody(entry)); return }
        current(entry)
        if (entry.leaseUntil <= now()) { retire(entry, F.SOURCE_UNAVAILABLE, true); return }
        entry.leaseUntil = now() + leaseMs
        if (entry.cache !== undefined) send(entry, entry.cache.body)
        return
      }
      if (packet.createdAt > now() + L.clockSkewMs || packet.expiresAt <= now()) reject(F.SOURCE_UNAVAILABLE)
      const reference = spec({ ref: packet.ref, authority: packet.authority, request: packet.request })
      healthy()
      if (typeof check !== 'function' || typeof open !== 'function') reject(F.ACTION_UNSUPPORTED)
      check(reference.ref, reference.authority)
      entry = allocate(packet.id, reference, packet)
      entry.spec = reference; entry.openBody = packet; entry.openDigest = hash; entry.started = true
      read(entry)
      return
    }
    if (packet.type !== 'pull') reject(F.INVALID_MESSAGE)
    if (entry === undefined) { transientSend({ ...packet, type: 'end', code: F.SOURCE_UNAVAILABLE }); return }
    if (!entry.active) { send(entry, terminalBody(entry)); return }
    current(entry)
    if (entry.leaseUntil <= now()) { retire(entry, F.SOURCE_UNAVAILABLE, true); return }
    entry.leaseUntil = now() + leaseMs
    if (packet.index < entry.index) return
    if (packet.index === entry.index) { if (entry.cache !== undefined) send(entry, entry.cache.body); return }
    if (packet.index !== entry.index + 1 || entry.cache === undefined || entry.reading) reject(F.HISTORY_GAP)
    clearCache(entry)
    entry.index = packet.index
    read(entry)
  }
  const receiveController = packet => {
    const entry = states.get(packet.id)
    if (entry === undefined) return
    same(entry, packet)
    if (!entry.active) return
    current(entry)
    if (!entry.started || !['data', 'end'].includes(packet.type)) reject(F.INVALID_MESSAGE)
    entry.responded = true
    if (packet.index < entry.index) {
      if (packet.type === 'data' && packet.index === entry.lastIndex && digest(packet) !== entry.lastDigest) reject(F.HISTORY_GAP)
      return
    }
    if (packet.index !== entry.index) reject(F.HISTORY_GAP)
    if (packet.type === 'end') {
      if (entry.cache !== undefined && packet.code === undefined) reject(F.HISTORY_GAP)
      retire(entry, packet.code, false)
      return
    }
    frameScope(packet.frame, entry)
    if (entry.cache !== undefined) {
      if (entry.cache.digest !== digest(packet)) reject(F.HISTORY_GAP)
      return
    }
    if (entry.yielded) { if (digest(packet) !== entry.lastDigest) reject(F.HISTORY_GAP); return }
    cache(entry, packet)
    wake(entry)
  }
  const failAll = code => {
    const selected = CODES.has(code) ? code : F.SOURCE_UNAVAILABLE
    for (const entry of states.values()) if (entry.active) retire(entry, selected, true)
  }
  return Object.freeze({
    receive(value) {
      if (closing) return
      let packet
      try {
        packet = body(value)
        if (!(role === 'worker' ? ['open', 'pull', 'stop'] : ['data', 'end']).includes(packet.type)) reject(F.INVALID_MESSAGE)
        prune()
        healthy()
        if (typeof check !== 'function') reject(F.ACTION_UNSUPPORTED)
        check(packet.ref, packet.authority)
        if (role === 'worker') receiveWorker(packet)
        else receiveController(packet)
      } catch (failure) {
        const code = codeOf(failure), entry = packet === undefined ? undefined : states.get(packet.id)
        if (entry?.active) retire(entry, code, true)
        else if (role === 'worker' && entry !== undefined) send(entry, terminalBody(entry))
        else if (role === 'worker' && packet?.type === 'stop') stopUnknown(packet)
        else if (role === 'worker' && packet !== undefined) transientSend(base(packet, 'end', { index: packet.index ?? 0, code }))
        else if (packet === undefined) failAll(F.INVALID_MESSAGE)
      } finally { schedule() }
    },
    follow(value, signal) {
      if (role !== 'controller') reject(F.ACTION_UNSUPPORTED)
      if (closing || signal?.aborted) reject(F.SOURCE_UNAVAILABLE)
      let reference
      try { reference = spec(snapshot(value)); healthy(); if (typeof check !== 'function') reject(F.ACTION_UNSUPPORTED); check(reference.ref, reference.authority) }
      catch (failure) { throw error(codeOf(failure)) }
      const entry = allocate(randomUUID(), reference, reference)
      entry.spec = reference
      const aborted = () => { retire(entry, F.SOURCE_UNAVAILABLE, true) }
      entry.callerSignal = signal; entry.callerAbort = aborted
      signal.addEventListener('abort', aborted, { once: true })
      const iterator = (async function *() {
        try {
          current(entry)
          const createdAt = now()
          entry.openBody = body(base(entry, 'open', { request: reference.request, createdAt, expiresAt: createdAt + L.maxLifetimeMs }))
          const baseBytes = 2 * size(entry.openBody)
          if (retainedBytes + baseBytes - entry.baseBytes > P.maxFollowBufferBytes) reject(F.PAGE_TOO_LARGE)
          retainedBytes += baseBytes - entry.baseBytes; entry.baseBytes = baseBytes
          entry.started = true; entry.heartbeatAt = now() + cadence
          send(entry, entry.openBody); schedule()
          for (;;) {
            if (!entry.active) { if (entry.terminal.code !== undefined) throw error(entry.terminal.code); return }
            if (entry.cache === undefined) { await new Promise(resolve => { entry.wake = resolve; if (!entry.active || entry.cache !== undefined) wake(entry) }); continue }
            current(entry)
            const cached = entry.cache
            entry.yielded = true; entry.lastIndex = entry.index; entry.lastDigest = cached.digest
            yield cached.body.frame
            if (!entry.active) { if (entry.terminal.code !== undefined) throw error(entry.terminal.code); return }
            current(entry)
            clearCache(entry); entry.yielded = false
            if (!count(entry.index + 1)) reject(F.HISTORY_GAP)
            entry.index++
            send(entry, base(entry, 'pull', { index: entry.index }))
            entry.heartbeatAt = now() + cadence; schedule()
          }
        } catch (failure) {
          if (entry.active) retire(entry, codeOf(failure), true)
          throw error(entry.terminal?.code ?? codeOf(failure))
        } finally {
          signal.removeEventListener('abort', aborted)
          if (entry.active) retire(entry, F.SOURCE_UNAVAILABLE, true)
          entry.consumer = undefined
        }
      })()
      entry.consumer = iterator
      return iterator
    },
    failAll,
    close() {
      if (closingPromise !== undefined) return closingPromise
      closing = true; clearTimeout(timer); timer = undefined
      for (const controller of transient) controller.abort()
      for (const entry of states.values()) {
        entry.sendAbort?.abort()
        if (entry.active) retire(entry, F.SOURCE_UNAVAILABLE, true)
      }
      closingPromise = (async () => {
        await Promise.allSettled([...states.values()].map(entry => entry.consumer?.return()).filter(Boolean))
        while (tasks.size > 0) await Promise.allSettled([...tasks])
        for (const entry of states.values()) clearCache(entry)
        states.clear(); retainedBytes = 0
      })()
      return closingPromise
    },
    status() {
      return { active: [...states.values()].filter(entry => entry.active).length, tombstones: [...states.values()].filter(entry => !entry.active).length,
        retainedBytes, pendingReads: [...states.values()].filter(entry => entry.reading).length,
        pendingSends: [...states.values()].filter(entry => entry.sending).length + transient.size, timers: timer === undefined ? 0 : 1 }
    },
  })
}
