/** Source-plane direct journal/native-JSONL behavior; packaged owner/readiness has separate built-plane tests. */
import { describe, it, expect, onTestFinished, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../dsh-remote-core/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { createSessionTestController } from '../../../dsh-remote-core/packages/api/session-controller/tests/test-remote.ts'
import * as nativeLlm from '@deepseek-ai/dsh-llm'
import * as nativeSession from '@deepseek-ai/dsh-session'
import * as nativeSandbox from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { persistedSourceFixture } from '../../../dsh-remote-core/packages/api/session-controller/tests/source-preparation-fixture.host.ts'
import { createNativeAdapter, type NativeModelSelectRequest } from '../../lib/federation/native-adapter.mjs'
import { openFederationJournal, type FederationCreateOperation, type FederationJournal, type FederationJournalPair, type FederationModelStamp, type FederationOperation } from '../../lib/federation/journal.mjs'
import { evaluateGrant, type FederationSessionRef } from '../../lib/federation/grants.mjs'

const machineKey = 'native-joint-worker'
const route = { provider: 'fixture', model: 'route-a' }
const signal = () => new AbortController().signal
interface PromptOperation extends FederationOperation {
  readonly action: 'session.prompt'
  readonly target: FederationSessionRef
  readonly body: { readonly text: string; readonly expected: FederationModelStamp }
  readonly guard: { readonly selection: FederationModelStamp['selection'] }
}
interface ModelSelectOperation extends FederationOperation {
  readonly action: 'model.select'
  readonly target: FederationSessionRef
  readonly body: { readonly selection: NativeModelSelectRequest['selection']; readonly expected: FederationModelStamp }
}
function nativeEvents(session: Pick<nativeSession.Session, 'seq' | 'eventAt'>): nativeSession.SessionEvent[] {
  return Array.from({ length: session.seq }, (_, seq) => {
    const event = session.eventAt(nativeSession.SessionSeq(seq))
    if (event === undefined) throw new Error('native fixture log is missing a covered event')
    return event
  })
}
function onlyOperation(journal: FederationJournal) {
  const rows = Object.values(journal.snapshot().operations)
  expect(rows).toHaveLength(1)
  const row = rows[0]
  if (row === undefined) throw new Error('native fixture operation was not journaled')
  return row
}
async function setup() {
  const fixture = await persistedSourceFixture()
  vi.spyOn(fixture.adapter, 'listModels').mockResolvedValue([{ provider: 'fixture', id: 'route-a', name: 'Route A' }, { provider: 'fixture', id: 'route-b', name: 'Route B' }])
  await fixture.ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
  const backend = await createNativeAdapter({ ctx: fixture.ctx, settings: { projects: { demo: { workspaceId: 'native-workspace' } } }, native: { llm: nativeLlm, session: nativeSession, sandbox: nativeSandbox, cordis: { symbols }, controllerOwner: {} } })
  expect(backend.mutationReadiness).toBeUndefined()
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-fed-native-joint-')))
  const journals: Awaited<ReturnType<typeof openFederationJournal>>[] = []
  let closed = false
  onTestFinished(async () => {
    closed = true; backend.close()
    for (const journal of journals) await journal.close()
    const target = await realpath(root)
    expect(path.dirname(target)).toBe(await realpath(tmpdir()))
    expect(path.basename(target).startsWith('dsh-fed-native-joint-')).toBe(true)
    await rm(target, { recursive: true, force: true })
  })
  async function ledger(actor: string, sessionId: string) {
    const peerId = `controller-${actor}`
    const pair = { role: 'worker', id: `worker-${actor}`, peerId, machineKey, pairingGeneration: 1, keyFingerprint: (actor === 'a' ? 'a' : 'b').repeat(64), stateDir: path.join(root, actor) } satisfies FederationJournalPair
    const journal = await openFederationJournal(pair)
    journals.push(journal)
    const grant = { version: 1, grantId: `native_grant_${actor}`, principal: { kind: 'controller', id: peerId }, machineKey, revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list', 'model.list'], exportClasses: ['conversation.user', 'conversation.assistant', 'turn'], sessions: [{ sessionId, imported: true, actions: ['session.read', 'session.follow', 'session.status', 'session.prompt', 'model.select', 'session.cancel'] }] }] }
    await journal.installGrant(grant)
    const ref = { machineKey, projectId: 'demo', sessionId }
    const check = () => {
      if (closed) throw new Error('native smoke owner closed')
      const state = journal.snapshot()
      if (state.grant === null || state.lastGrantRevision === null) throw new Error('native smoke authority is unavailable')
      const decision = evaluateGrant(state.grant, { principal: grant.principal, ...ref, action: 'session.prompt' }, { currentRevision: state.lastGrantRevision, now: Date.now() })
      if (!decision.allowed) throw new Error('native smoke authority changed')
    }
    const recovery = {
      check,
      async restore(agent: Parameters<typeof backend.restoreGuard>[0]) {
        for (const guard of journal.guardsFor(agent.id)) {
          if (backend.hasPromptEvidence(agent, guard.nativeRequestId, guard.expected)) await journal.confirmGuardEvidence(agent.id, guard.requestId)
          else backend.restoreGuard(agent, guard.nativeRequestId, guard.expected, check)
        }
      },
    }
    function operation(id: string, text: string, expected: FederationModelStamp, action?: 'session.prompt'): PromptOperation
    function operation(id: string, text: string, expected: FederationModelStamp, action: 'model.select'): ModelSelectOperation
    function operation(id: string, text: string, expected: FederationModelStamp, action: 'session.prompt' | 'model.select' = 'session.prompt'): PromptOperation | ModelSelectOperation {
      const base = { principal: peerId, machineKey, requestId: id, target: ref }
      if (action === 'session.prompt') return { ...base, action, body: { text, expected }, guard: { selection: expected.selection } }
      return { ...base, action, body: { selection: { provider: 'fixture', model: 'route-b' }, expected } }
    }
    return { journal, ref, recovery, operation, async reopen() { await journal.close(); const reopened = await openFederationJournal(pair); journals.push(reopened); return reopened } }
  }
  return { ...fixture, backend, ledger }
}

describe('joint durable federation/native smoke', () => {
  it('namespaces native receipts, executes exact bodies once and flushes native prompt/model state before committed ACK', async () => {
    const { ctx, controller, adapter, backend, cwd, ledger } = await setup()
    const created = await controller.create({ cwd })
    const agent = ctx.agents.get(created.sessionId)!
    agent.model.select(route)
    const rawId = brandString<SessionRequestId>('wire-same-operation')
    const localStamp = await controller.sourceModelState(agent.id)
    await controller.guardedPrompt({ sessionId: agent.id, requestId: rawId, mode: 'queue', content: [{ type: 'text', text: 'local original' }], requireIdle: true, expectedFrontierSeq: localStamp.frontierSeq, expectedSelection: localStamp.selection }, signal())
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const a = await ledger('a', agent.id), b = await ledger('b', agent.id)
    let nativeReceiptFlushes = 0
    const realFlush = ctx.sessions.flush.bind(ctx.sessions)
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async session => {
      for (const journal of [a.journal, b.journal]) expect(Object.values(journal.snapshot().operations).every(row => row.state !== 'committed' || row.result !== undefined)).toBe(true)
      const result = await realFlush(session)
      if (nativeEvents(session).some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId.startsWith('frpc_')))) nativeReceiptFlushes++
      return result
    })
    onTestFinished(() => flushSpy.mockRestore())
    async function send(owner: typeof a, text: string) {
      const expected = Object.freeze({ generation: owner.journal.snapshot().generation, ...await backend.modelState(owner.ref, signal()) })
      const op = owner.operation(rawId, text, expected)
      const ack = await owner.journal.execute(op, transaction => backend.prompt(owner.ref, { ...op.body, requestId: transaction.nativeRequestId }, transaction.dispatch, signal(), owner.recovery).catch(error => { console.error('native joint direct failure', error); throw error }))
      expect(ack).toEqual({ accepted: true })
      await agent.whenIdle()
      const count = adapter.requests.length
      expect(await owner.journal.execute(op, () => { throw new Error('duplicate executed') })).toEqual(ack)
      expect(adapter.requests).toHaveLength(count)
      return { op, nativeId: onlyOperation(owner.journal).nativeRequestId }
    }
    const first = await send(a, 'source A exact text'), second = await send(b, 'source B exact text')
    expect(first.nativeId).toMatch(/^frpc_[a-f0-9]{64}$/)
    expect(first.nativeId).not.toBe(rawId)
    expect(first.nativeId).not.toBe(second.nativeId)
    expect(adapter.requests).toHaveLength(3)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('danger-full-access')
    expect(nativeReceiptFlushes).toBeGreaterThanOrEqual(2)
    await expect(a.journal.execute({ ...first.op, body: { ...first.op.body, text: 'changed' } }, () => { throw new Error('changed duplicate executed') })).rejects.toMatchObject({ code: 'request-conflict' })
    const expected = { generation: a.journal.snapshot().generation, ...await backend.modelState(a.ref, signal()) }
    const select = a.operation('select-native-route', '', expected, 'model.select')
    const selected = await a.journal.execute(select, tx => backend.modelSelect(a.ref, { ...select.body, requestId: tx.nativeRequestId }, tx.dispatch, signal(), a.recovery).catch(error => { console.error('native select direct failure', error); throw error }))
    expect(selected.selection).toEqual({ provider: 'fixture', model: 'route-b' })
    expect(await controller.sourceModelState(agent.id)).toEqual(selected)
    expect(ctx.agentDefaultModel.currentSelection().model).toBe('default-must-not-be-guessed')
    using persisted = await ctx.sessionQuery.observeSession(agent.id)
    expect(persisted.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === first.nativeId)).toBe(true)
    expect(persisted.events.some(event => event.type === 'model/selection' && event.data.model === 'route-b')).toBe(true)
  })

  it('rejects stale cold CAS before publication can drive the native queued input', async () => {
    const { ctx, controller, adapter, backend, id, ledger } = await setup()
    const owner = await ledger('a', id)
    const published = vi.fn()
    ctx.on('agent/created', ({ agent }) => { if (agent.id === id) { published(); const pending = agent.inbox.nextTurn[0]; if (pending) { agent.inbox.remove(pending.id); agent.followup(pending) } } })
    const observed = await controller.sourceModelState(id)
    const expected = { generation: owner.journal.snapshot().generation, ...observed, frontierSeq: observed.frontierSeq - 1 }
    const op = owner.operation('cold-stale-request', 'must not run', expected)
    await expect(owner.journal.execute(op, tx => backend.prompt(owner.ref, { ...op.body, requestId: tx.nativeRequestId }, tx.dispatch, signal(), owner.recovery))).rejects.toMatchObject({ code: 'selection-conflict' })
    expect(published).not.toHaveBeenCalled()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    using stored = await ctx.sessionQuery.observeSession(id)
    expect(stored.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)).toBe(true)
  })

  it('resolves sessions strictly when the real Bridge plugin scope has no sessions injection', async () => {
    const ctx = new Context(), sessions = { async flush() { return true } }
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin({ name: 'separate-native-store-provider', apply(provider: Context) { provider.provide('sessions', sessions) } })
    const inject = ['sessionController', 'sessionQuery', 'sessionProjections', 'agents', 'commands', 'tools', 'sandboxPolicy']
    for (const name of inject) ctx.provide(name, {})
    let observed = false
    await ctx.plugin({ name: 'exact-bridge-scope-proof', inject, apply(bridge: Context) {
      expect(() => bridge.sessions).toThrow(/cannot get property "sessions" without inject/)
      expect(bridge.get('sessions')).toBe(sessions)
      observed = true
    } })
    expect(observed).toBe(true)
  })

  it('retains exact raw owner readiness across fresh real Cordis service proxies', async () => {
    const ctx = new Context()
    class Owner extends Service {
      constructor() { super(ctx, 'sessionController') }
      sourceModelState() {} prepareSourceSession() {} createSourceSession() {} guardedSourcePrompt() {}
      installPromptSelectionGuard() {} selectSessionModel() {} cancel() {} modelCatalog() {}
    }
    const owner = new Owner()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('sandboxPolicy', { resolve() {} }); ctx.provide('sessions', { async flush() { return true } })
    const names = ['sourceModelState', 'prepareSourceSession', 'createSourceSession', 'guardedSourcePrompt', 'installPromptSelectionGuard', 'selectSessionModel', 'cancel', 'modelCatalog']
    const methods: readonly unknown[] = names.map(name => Object.getOwnPropertyDescriptor(Owner.prototype, name)!.value)
    const controllerOwner = { ownsSourceMutationHelpers(value: unknown) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Owner.prototype && names.every((name, index) => !Object.hasOwn(value, name) && Object.getOwnPropertyDescriptor(Owner.prototype, name)!.value === methods[index]) } }
    const first = ctx.get('sessionController'), second = ctx.get('sessionController')
    if (first === undefined || second === undefined) throw new Error('native owner proxies are unavailable')
    const firstOriginal: unknown = Reflect.get(first, symbols.original), secondOriginal: unknown = Reflect.get(second, symbols.original)
    expect(first).not.toBe(second)
    expect(firstOriginal).toBe(owner)
    expect(secondOriginal).toBe(owner)
    const backend = await createNativeAdapter({ ctx, settings: { projects: {} }, native: { llm: nativeLlm, session: nativeSession, sandbox: nativeSandbox, cordis: { symbols }, controllerOwner } })
    expect(backend.mutationReadiness).toEqual({ durableJournal: 'verified', firstRouteCapture: 'verified' })
    Object.defineProperty(owner, 'sourceModelState', { value() {}, configurable: true })
    expect(backend.mutationReadiness).toBeUndefined()
    backend.close()
  })

  it('creates on a real native workspace with durable full-access/proof before publication and never adopts an ID collision', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-fed-native-create-')))
    const projectRoot = path.join(root, 'project'); await mkdir(projectRoot)
    const ctx = new Context()
    let journal: Awaited<ReturnType<typeof openFederationJournal>> | undefined
    onTestFinished(async () => { await ctx.fiber.dispose(); await journal?.close(); const target = await realpath(root); expect(path.dirname(target)).toBe(await realpath(tmpdir())); expect(path.basename(target).startsWith('dsh-fed-native-create-')).toBe(true); await rm(target, { recursive: true, force: true }) })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: path.join(root, 'native') })
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', domain); ctx.provide('storageDomain', domain)
    await ctx.plugin(WorkspaceRegistry)
    const workspace = await ctx.workspaceRegistry.create(projectRoot)
    class NoCallsAdapter extends nativeLlm.LlmAdapter {
      override providerInfo(provider: string) { return { id: provider, name: provider } }
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      override async *stream(): AsyncIterable<nativeLlm.StreamChunk> { throw new Error('creation unexpectedly called the LLM') }
    }
    const external = new NoCallsAdapter(); const llmCall = vi.spyOn(external, 'stream')
    ctx.llm.registerAdapter(['fixture'], external)
    const controller = await createSessionTestController(ctx, { cwd: projectRoot, defaultModelSelection: () => route })
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
    await mountAgentLoopTestHarness(ctx)
    const backend = await createNativeAdapter({ ctx, settings: { projects: { demo: { workspaceId: workspace.id } } }, native: { llm: nativeLlm, session: nativeSession, sandbox: nativeSandbox, cordis: { symbols }, controllerOwner: {} } })
    const pair = { role: 'worker', id: 'create-worker', peerId: 'create-controller', machineKey, pairingGeneration: 1, keyFingerprint: 'c'.repeat(64), stateDir: path.join(root, 'journal') } satisfies FederationJournalPair
    journal = await openFederationJournal(pair)
    const log = journal
    const exportClasses = ['conversation.user', 'conversation.assistant', 'turn']
    const grant = { version: 1, grantId: 'native_create_grant', principal: { kind: 'controller', id: pair.peerId }, machineKey, revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses, createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses }, sessions: [] }] }
    await log.installGrant(grant)
    const ref = { machineKey, projectId: 'demo' }
    const check = () => { expect(evaluateGrant(log.snapshot().grant, { principal: grant.principal, ...ref, action: 'session.create' }, { currentRevision: 1, now: Date.now() }).allowed).toBe(true) }
    let reserved = '', published = 0
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== reserved) return
      published++
      const row = Object.values(log.snapshot().operations).find(row => row.reservedSessionId === reserved)
      if (row === undefined || row.nativeCreatedProof === undefined) throw new Error('native create proof was not persisted before publication')
      expect(row.state).toBe('dispatched')
      expect(row.nativeCreatedProof.sessionId).toBe(reserved)
      expect(row.nativeCreatedProof.initialSelection).toEqual(route)
      expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('danger-full-access')
    })
    const op = { principal: pair.peerId, machineKey, requestId: 'native-create-exact', action: 'session.create', target: ref, body: {} } satisfies FederationCreateOperation
    const created = await log.execute(op, tx => {
      reserved = tx.reservedSessionId
      return backend.create({ ref, reservedSessionId: tx.reservedSessionId }, tx.dispatch, signal(), { check, created: tx.recordNativeCreation })
    })
    expect(created.sessionId).toBe(reserved); expect(published).toBe(1)
    expect(workspace.sessionIds).toContain(reserved)
    expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')
    expect(log.snapshot().remoteOwnedSessions[reserved]?.state).toBe('committed')
    const disk = await ctx.sessionPersistence.open(nativeSession.SessionId(reserved), 'read')
    try { const read = await disk.read(); expect(read.events.some(event => event.type === 'sandbox/mode' && event.data.mode === 'danger-full-access')).toBe(true); expect(read.events.some(event => event.type === 'model/selection' && event.data.model === 'route-a')).toBe(true) } finally { await disk.close() }
    expect(await log.execute(op, () => { throw new Error('create duplicate reran') })).toEqual(created)
    let foreign = ''
    await expect(log.execute({ ...op, requestId: 'native-create-collision' }, async tx => {
      foreign = tx.reservedSessionId
      await controller.createSourceSession({ sessionId: nativeSession.SessionId(foreign), workspaceId: workspace.id }, () => {})
      return backend.create({ ref, reservedSessionId: tx.reservedSessionId }, tx.dispatch, signal(), { check, created: tx.recordNativeCreation })
    })).rejects.toMatchObject({ code: 'outcome-unknown' })
    expect(log.snapshot().remoteOwnedSessions[foreign]).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: ctx.agents.get(nativeSession.SessionId(foreign))!.session }).mode).toBe('read-only')
    expect(llmCall).not.toHaveBeenCalled()
    backend.close()
  })

  it('correlates recovery to the first consuming native step and exact effort/default semantics', async () => {
    const { ctx, controller, backend, cwd } = await setup()
    const created = await controller.create({ cwd }), agent = ctx.agents.get(created.sessionId)!
    agent.model.select(route)
    const rpcId = brandString<SessionRequestId>('native-evidence-request')
    const observed = await controller.sourceModelState(agent.id)
    await controller.guardedPrompt({ sessionId: agent.id, requestId: rpcId, mode: 'queue', content: [{ type: 'text', text: 'native evidence seed' }], requireIdle: true, expectedFrontierSeq: observed.frontierSeq, expectedSelection: observed.selection }, signal())
    await agent.whenIdle()
    const recorded = nativeEvents(agent.session).find((event): event is nativeSession.SessionEvent<'request/header'> => event.type === 'request/header')
    if (recorded === undefined) throw new Error('native evidence request header was not recorded')
    const headerEvent = recorded
    const header = headerEvent.data.header
    const { adapterDefaults, ...explicitHeader } = header
    const high = { ...explicitHeader, config: { ...header.config, reasoningEffort: nativeLlm.ReasoningEffortId('high') } }
    function proof(first: typeof header, later?: typeof header) {
      const events: nativeSession.SessionEvent[] = [
        { type: 'turn/start', seq: nativeSession.SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: nativeSession.SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
        { type: 'user/message', seq: nativeSession.SessionSeq(2), time: 3, surfaceOp: 'append', data: nativeLlm.createUserMessage({ source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'evidence' }] }) },
        { ...headerEvent, seq: nativeSession.SessionSeq(3), time: 4, data: { ...headerEvent.data, header: first } },
        { type: 'step/end', seq: nativeSession.SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
      ]
      if (later) events.push(
        { type: 'step/start', seq: nativeSession.SessionSeq(5), time: 6, data: { turn: 1, step: 2 } },
        { ...headerEvent, seq: nativeSession.SessionSeq(6), time: 7, data: { ...headerEvent.data, header: later } },
        { type: 'step/end', seq: nativeSession.SessionSeq(7), time: 8, data: { turn: 1, step: 2 } },
      )
      events.push({ type: 'turn/end', seq: nativeSession.SessionSeq(events.length), time: 9, data: { turn: 1, reason: { kind: 'completed' } } })
      return { session: nativeSession.Session.create(nativeSession.SessionId('recovery-evidence-copy'), events) }
    }
    expect(backend.hasPromptEvidence(proof(header), rpcId, route)).toBe(true)
    expect(backend.hasPromptEvidence(proof(high), rpcId, route)).toBe(false)
    expect(backend.hasPromptEvidence(proof(high, header), rpcId, route)).toBe(false)
    expect(backend.hasPromptEvidence(proof(high), rpcId, { ...route, reasoningEffort: 'high' })).toBe(true)
    const adapterDefault = { ...high, adapterDefaults: { ...adapterDefaults, reasoningEffort: true as const } }
    expect(backend.hasPromptEvidence(proof(adapterDefault), rpcId, route)).toBe(true)
    expect(backend.hasPromptEvidence(proof(adapterDefault), rpcId, { ...route, reasoningEffort: 'high' })).toBe(false)
  })

  it('holds post-enqueue flush failure unknown across journal restart and never replays a native request', async () => {
    const { ctx, controller, adapter, backend, cwd, ledger } = await setup()
    const created = await controller.create({ cwd }), agent = ctx.agents.get(created.sessionId)!
    agent.model.select(route)
    nativeSandbox.setSandboxMode(agent.session, 'danger-full-access')
    expect(await ctx.sessions.flush(agent.session)).toBe(true)
    const owner = await ledger('a', agent.id)
    const expected = { generation: owner.journal.snapshot().generation, ...await backend.modelState(owner.ref, signal()) }
    const op = owner.operation('flush-unknown-request', 'one native call only', expected)
    const realFlush = ctx.sessions.flush.bind(ctx.sessions)
    let calls = 0
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async session => { calls++; return calls === 1 ? realFlush(session) : false })
    onTestFinished(() => flush.mockRestore())
    await expect(owner.journal.execute(op, tx => backend.prompt(owner.ref, { ...op.body, requestId: tx.nativeRequestId }, tx.dispatch, signal(), owner.recovery))).rejects.toMatchObject({ code: 'outcome-unknown' })
    flush.mockRestore(); await agent.whenIdle()
    const count = adapter.requests.length
    expect(count).toBe(1)
    expect(onlyOperation(owner.journal).state).toBe('unknown')
    const reopened = await owner.reopen()
    expect(onlyOperation(reopened).state).toBe('unknown')
    await expect(reopened.execute(op, () => { throw new Error('unknown replayed') })).rejects.toMatchObject({ code: 'outcome-unknown' })
    await expect(reopened.execute({ ...op, requestId: 'different-after-unknown' }, () => { throw new Error('unknown target replayed') })).rejects.toMatchObject({ code: 'outcome-unknown' })
    expect(adapter.requests).toHaveLength(count)
  })
})
