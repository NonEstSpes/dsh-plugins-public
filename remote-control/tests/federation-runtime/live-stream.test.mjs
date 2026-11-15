/** Credit/lease transport units with a memory carrier and one fixture producer; not native SDK/composition evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createLiveStreams } from '../../lib/federation/live-stream.mjs'
import { canonicalJson } from '../../lib/federation/journal.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { FAILURE_CODES as F, PROTOCOL_LIMITS as P } from '../../lib/federation/protocol.mjs'
import { LIVE_CHANNEL_LIMITS as L } from '../../lib/live-channel-protocol.mjs'

const SECRET = 'PRIVATE_NATIVE_LIVE_DIAGNOSTIC_938'
const clone = value => JSON.parse(canonicalJson(value))
const deferred = () => Promise.withResolvers()
const reference = sessionId => ({ ref: { machineKey: 'worker', projectId: 'project', sessionId },
  authority: { generation: 1, grantRevision: 2 }, request: { includeAssistantStream: true } })
const frame = (index, extra = '') => ({ type: 'records', generation: 1, grantRevision: 2, exportCursor: 'fixture-cursor',
  records: [{ type: 'withheld', firstSeq: index, lastSeq: index, reason: 'policy' }], fixture: index, extra })
const failure = (code = F.SOURCE_UNAVAILABLE) => new FederationContractError(code, SECRET)
function staticError(code) {
  return value => value instanceof FederationContractError && value.code === code && value.message === 'live source stream failed'
    && value.detail === undefined && value.cause === undefined && !JSON.stringify(value).includes(SECRET)
}
async function bounded(value) {
  let timer
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('live-stream fixture deadline')), 3000) })]) }
  finally { clearTimeout(timer) }
}
function producer(length = Infinity) {
  const calls = { open: 0, next: 0, returned: 0 }
  return { calls, open() {
    calls.open++
    let position = 0
    return { [Symbol.asyncIterator]() { return this },
      async next() { calls.next++; return position < length ? { done: false, value: frame(position++) } : { done: true, value: undefined } },
      async return() { calls.returned++; return { done: true, value: undefined } },
    }
  } }
}
function fixture(t, options = {}) {
  const events = [], watchers = new Set(), managers = {}, checks = { controller: 0, worker: 0 }
  let packetId = 0
  const channels = Object.fromEntries(['controller', 'worker'].map(role => [role, {
    start: async () => true,
    status: () => ({ running: true, closed: false, supported: true }),
    async send(body, signal, beforePublish) {
      if (signal?.aborted) throw new Error('carrier canceled')
      const value = clone(body), event = { role, body: value, packetId: ++packetId }
      const held = options.hold?.(event)
      if (held !== undefined) await held
      if (signal?.aborted) throw new Error('carrier canceled')
      beforePublish?.()
      events.push(event)
      for (const watcher of [...watchers]) watcher()
      if (options.drop?.(event)) return { id: String(packetId) }
      const target = role === 'controller' ? 'worker' : 'controller'
      assert.equal(managers[target].receive(value), undefined, 'receive must return before Native.next settles')
      return { id: String(packetId) }
    },
  }]))
  managers.controller = createLiveStreams({ role: 'controller', channel: channels.controller, timeoutMs: options.timeoutMs ?? 8,
    check(ref, authority) { checks.controller++; options.controllerCheck?.(ref, authority) } })
  managers.worker = createLiveStreams({ role: 'worker', channel: channels.worker, timeoutMs: options.timeoutMs ?? 8,
    open: options.open, check(ref, authority) { checks.worker++; options.workerCheck?.(ref, authority) } })
  t.after(async () => { await Promise.allSettled([managers.controller.close(), managers.worker.close()]) })
  const wait = predicate => {
    if (predicate(events)) return Promise.resolve()
    const gate = deferred()
    const watcher = () => { if (predicate(events)) { watchers.delete(watcher); gate.resolve() } }
    watchers.add(watcher)
    return bounded(gate.promise)
  }
  return { ...managers, channels, events, checks, wait,
    deliver(role, body) { assert.equal(managers[role].receive(clone(body)), undefined) },
    follow(id = 'session') { return managers.controller.follow(reference(id), new AbortController().signal)[Symbol.asyncIterator]() },
  }
}
function openPacket(id = 'stream') {
  const createdAt = Date.now()
  return { version: 1, type: 'open', id, ...reference('session'), createdAt, expiresAt: createdAt + L.maxLifetimeMs }
}

test('640 frames use one producer despite lost first OPEN, DATA and END, with immutable retries', async t => {
  const source = producer(640), lost = new Set()
  const h = fixture(t, { open: source.open, drop(event) {
    const key = event.body.type === 'open' ? 'open' : event.body.type === 'end' ? 'end'
      : event.body.type === 'data' && event.body.index === 5 ? 'data' : undefined
    if (key !== undefined && !lost.has(key)) { lost.add(key); return true }
    return false
  } })
  const output = []
  await bounded((async () => { for await (const value of h.controller.follow(reference('session'), new AbortController().signal)) output.push(value.fixture) })())
  assert.deepEqual(output, Array.from({ length: 640 }, (_, index) => index))
  assert.deepEqual(source.calls, { open: 1, next: 641, returned: 1 })
  assert.deepEqual([...lost].sort(), ['data', 'end', 'open'])
  const retries = h.events.filter(event => event.body.type === 'data' && event.body.index === 5)
  assert.ok(retries.length >= 2)
  assert.equal(canonicalJson(retries[0].body), canonicalJson(retries[1].body))
  assert.notEqual(retries[0].packetId, retries[1].packetId)
  assert.equal(h.worker.status().pendingReads, 0)
  assert.equal(h.worker.status().active, 0)
})

test('a paused consumer keeps an owned same-index heartbeat but grants no extra Native.next credit', async t => {
  const source = producer(), h = fixture(t, { open: source.open }), iterator = h.follow()
  assert.equal((await bounded(iterator.next())).value.fixture, 0)
  await h.wait(events => events.filter(event => event.role === 'controller' && event.body.type === 'pull' && event.body.index === 0).length >= 2)
  assert.equal(source.calls.next, 1)
  assert.equal(source.calls.open, 1)
  assert.equal((await bounded(iterator.next())).value.fixture, 1)
  assert.equal(source.calls.next, 2)
  await iterator.return()
  await h.wait(events => events.some(event => event.role === 'controller' && event.body.type === 'stop'))
})

test('actual grant withdrawal retires cached data while the Controller generator is paused at yield', async t => {
  const source = producer()
  let allowed = true
  const h = fixture(t, { open: source.open, workerCheck() { if (!allowed) throw failure(F.GRANT_CHANGED) } })
  const iterator = h.follow()
  await bounded(iterator.next())
  allowed = false
  await h.wait(events => events.some(event => event.role === 'worker' && event.body.type === 'end' && event.body.code === F.GRANT_CHANGED))
  await assert.rejects(iterator.next(), staticError(F.GRANT_CHANGED))
  assert.equal(source.calls.next, 1)
  assert.equal(h.worker.status().retainedBytes <= P.maxFollowBufferBytes, true)
})

test('a post-crypto publication guard refuses DATA when the grant changes while send is held', async t => {
  const source = producer(), entered = deferred(), encrypted = deferred()
  let allowed = true
  t.after(() => encrypted.resolve())
  const h = fixture(t, { open: source.open, timeoutMs: 10000,
    workerCheck() { if (!allowed) throw failure(F.GRANT_CHANGED) },
    hold(event) {
      if (event.role === 'worker' && event.body.type === 'data') { entered.resolve(); return encrypted.promise }
      return undefined
    },
  })
  const iterator = h.follow(), pending = iterator.next(), rejected = assert.rejects(pending, staticError(F.GRANT_CHANGED))
  await bounded(entered.promise)
  assert.equal(source.calls.next, 1)
  allowed = false
  encrypted.resolve()
  await bounded(rejected)
  assert.equal(h.events.some(event => event.role === 'worker' && event.body.type === 'data'), false)
  assert.equal(h.events.some(event => event.role === 'worker' && event.body.type === 'end' && event.body.code === F.GRANT_CHANGED), true)
  assert.equal(source.calls.open, 1)
})

test('a genuinely idle Native read gets keepalive reauthorization without a second pending next', async t => {
  const entered = deferred(), aborted = deferred()
  let allowed = true, opens = 0, reads = 0, returned = 0
  const h = fixture(t, { workerCheck() { if (!allowed) throw failure(F.GRANT_CHANGED) }, open(_spec, signal) {
    opens++
    return { [Symbol.asyncIterator]() { return this }, next() {
      reads++; entered.resolve()
      return new Promise(resolve => { signal.addEventListener('abort', () => { aborted.resolve(); resolve({ done: true }) }, { once: true }) })
    }, async return() { returned++; return { done: true } } }
  } })
  const iterator = h.follow(), pending = iterator.next(), rejected = assert.rejects(pending, staticError(F.GRANT_CHANGED))
  await entered.promise
  await h.wait(events => events.filter(event => event.role === 'controller' && event.body.type === 'open').length >= 3)
  assert.equal(opens, 1); assert.equal(reads, 1)
  allowed = false
  await bounded(aborted.promise)
  await rejected
  assert.equal(returned, 1)
})

test('STOP overtaking a lost OPEN tombstones the id and never admits the delayed original consumer', async t => {
  const source = producer(), saved = []
  const h = fixture(t, { open: source.open, drop(event) { if (event.role === 'controller' && event.body.type === 'open') { saved.push(event.body); return true } return false } })
  const caller = new AbortController(), iterator = h.controller.follow(reference('session'), caller.signal)[Symbol.asyncIterator]()
  const pending = iterator.next(), rejected = assert.rejects(pending, staticError(F.SOURCE_UNAVAILABLE))
  await h.wait(events => events.some(event => event.body.type === 'open'))
  caller.abort(new Error(SECRET))
  await rejected
  await h.wait(events => events.some(event => event.role === 'controller' && event.body.type === 'stop'))
  assert.equal(source.calls.open, 0)
  assert.ok(h.worker.status().tombstones >= 1)
  h.deliver('worker', saved[0])
  assert.equal(source.calls.open, 0)
})

test('scope mismatches retire only the named stream and never publish another reference through its id', async t => {
  const source = producer(), h = fixture(t, { open: source.open }), a = h.follow('a'), b = h.follow('b')
  await bounded(a.next()); await bounded(b.next())
  const packet = h.events.find(event => event.role === 'worker' && event.body.type === 'data' && event.body.ref.sessionId === 'a').body
  h.deliver('controller', { ...packet, ref: { ...packet.ref, sessionId: 'other' } })
  await assert.rejects(a.next(), staticError(F.GRANT_CHANGED))
  assert.equal((await bounded(b.next())).value.fixture, 1)
  await b.return()
})

test('conflicting cached duplicates and future credits fail rather than fabricate dense delivery', async t => {
  for (const future of [false, true]) {
    const source = producer(), h = fixture(t, { open: source.open }), iterator = h.follow()
    await bounded(iterator.next())
    const packet = h.events.find(event => event.role === 'worker' && event.body.type === 'data').body
    if (future) h.deliver('worker', { version: 1, type: 'pull', id: packet.id, ref: packet.ref, authority: packet.authority, index: 2 })
    else h.deliver('controller', { ...packet, frame: { ...packet.frame, fixture: 999 } })
    await assert.rejects(iterator.next(), staticError(F.HISTORY_GAP))
    assert.equal(source.calls.next, 1)
  }
})

test('complete DATA wrappers including source scope enforce exact UTF-8 bytes', async t => {
  for (const oversized of [false, true]) {
    const h = fixture(t, { open(_spec, _signal, wrapFrame) {
      const available = P.maxFrameBytes - Buffer.byteLength(canonicalJson(wrapFrame(frame(0, ''))), 'utf8')
      const value = frame(0, oversized ? '😀'.repeat(available) : 'x'.repeat(available))
      return (async function *() { yield value })()
    } })
    const iterator = h.follow()
    if (oversized) await assert.rejects(bounded(iterator.next()), staticError(F.PAGE_TOO_LARGE))
    else {
      const item = await bounded(iterator.next())
      assert.equal(item.done, false)
      const packet = h.events.find(event => event.role === 'worker' && event.body.type === 'data').body
      assert.equal(Buffer.byteLength(canonicalJson(packet), 'utf8'), P.maxFrameBytes)
      await iterator.return()
    }
  }
})

test('unconsumed Controller streams obey the active cap and close removes all caller listeners', async t => {
  const source = producer(), h = fixture(t, { open: source.open }), callers = []
  for (let index = 0; index < 16; index++) {
    const caller = new AbortController(); callers.push(caller)
    h.controller.follow(reference(`session-${index}`), caller.signal)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 1)
  }
  assert.throws(() => h.controller.follow(reference('overflow'), new AbortController().signal), staticError(F.PAGE_TOO_LARGE))
  assert.equal(h.controller.status().active, 16)
  assert.equal(source.calls.open, 0)
  await h.controller.close()
  for (const caller of callers) assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  assert.deepEqual(h.controller.status(), { active: 0, tombstones: 0, retainedBytes: 0, pendingReads: 0, pendingSends: 0, timers: 0 })
})

test('receive returns synchronously while close aborts then joins both a late read and Native.return', async t => {
  const entered = deferred(), result = deferred(), returning = deferred(), returned = deferred()
  const packets = []
  let sourceSignal
  const manager = createLiveStreams({ role: 'worker', timeoutMs: 8, check() {},
    channel: { start: async () => true, status: () => ({ running: true, closed: false }), async send(value) { packets.push(clone(value)) } },
    open(_spec, signal) {
      sourceSignal = signal
      return { [Symbol.asyncIterator]() { return this }, next() { entered.resolve(); return result.promise },
        async return() { returning.resolve(); await returned.promise; return { done: true } } }
    } })
  t.after(() => manager.close())
  assert.equal(manager.receive(openPacket()), undefined)
  await entered.promise
  let settled = false
  const closing = manager.close().then(() => { settled = true })
  assert.equal(sourceSignal.aborted, true)
  await returning.promise
  assert.equal(settled, false)
  result.resolve({ done: false, value: frame(0) })
  returned.resolve()
  await bounded(closing)
  assert.equal(packets.some(packet => packet.type === 'data'), false)
  assert.deepEqual(manager.status(), { active: 0, tombstones: 0, retainedBytes: 0, pendingReads: 0, pendingSends: 0, timers: 0 })
})

test('lease expiry aborts an idle source and expired OPEN cannot readmit after STOP guard retirement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 })
  const entered = deferred(), aborted = deferred()
  let opens = 0
  const manager = createLiveStreams({ role: 'worker', timeoutMs: 8, check() {},
    channel: { start: async () => true, status: () => ({ running: true, closed: false }), async send() {} },
    open(_spec, signal) {
      opens++
      return { [Symbol.asyncIterator]() { return this }, next() {
        entered.resolve()
        return new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve({ done: true }) }, { once: true }))
      }, async return() { return { done: true } } }
    } })
  t.after(() => manager.close())
  const original = openPacket()
  manager.receive(original)
  await entered.promise
  t.mock.timers.tick(21000)
  await aborted.promise
  assert.equal(manager.status().active, 0)
  t.mock.timers.tick(21000)
  manager.receive(original)
  assert.equal(opens, 1)
  await manager.close()
})

test('unknown/private source and checker failures become static first-terminal codes', async t => {
  const h = fixture(t, { open() { throw new Error(SECRET) } })
  await assert.rejects(bounded(h.follow().next()), staticError(F.SOURCE_UNAVAILABLE))
  const bad = fixture(t, { open: producer().open, controllerCheck() { throw new Error(SECRET) } })
  assert.throws(() => bad.follow(), staticError(F.SOURCE_UNAVAILABLE))
  const noCheck = createLiveStreams({ role: 'controller', timeoutMs: 8,
    channel: { start: async () => true, status: () => ({ running: true, closed: false }), async send() {} } })
  t.after(() => noCheck.close())
  assert.throws(() => noCheck.follow(reference('session'), new AbortController().signal), staticError(F.ACTION_UNSUPPORTED))
})
