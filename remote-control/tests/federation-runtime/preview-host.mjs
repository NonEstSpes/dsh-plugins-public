/** Explicit separate-GUI PREVIEW fixture: toy Workers, real HTTP/JWE/journals/BFF, NO real remote/LLM/tool execution. */
import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { createRelay } from '../../relay/server.mjs'
import { openJsonStore } from '../../lib/store.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'

export const name = 'remote-source-preview-fixture'
export const inject = ['sessionSourceController']
export const Config = Schema.object({ dataDir: Schema.string().required().description('Absolute dedicated .dsh-build/preview-* directory; never a real pairing/profile directory.') })

/** Create isolated test Workers and register their real owner-BFF providers.
 * @param {object} ctx - source-preview Host scope.
 * @param {{dataDir:string}} config - explicitly authorized dedicated preview location.
 */
export async function apply(ctx, config) {
  if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw new Error('Preview requires an explicit absolute dataDir')
  const requested = path.resolve(config.dataDir)
  if (path.basename(path.dirname(requested)) !== '.dsh-build' || !path.basename(requested).startsWith('preview-')) throw new Error('Preview writes only a dedicated .dsh-build/preview-* directory')
  await mkdir(requested, { recursive: true })
  const root = await realpath(requested)
  const resources = []
  ctx.effect(() => async () => { for (const resource of resources.reverse()) await resource.close() }, 'preview-source: owned relay, journals, stores and registrations')
  const { createUserMessage, createAssistantMessage, AssistantStreamAccumulator, assembleAssistantStream, expandAssistantStream } = await import('@deepseek-ai/dsh-llm')
  const { snapshotSessionEvent } = await import('@deepseek-ai/dsh-session')
  const tokens = await openJsonStore(path.join(root, 'preview-pairing.json'), { version: 1, pairs: ['a', 'b'].map(suffix => ({ suffix, key: randomBytes(32).toString('base64url'), controllerToken: randomBytes(32).toString('base64url'), workerToken: randomBytes(32).toString('base64url') })) })
  resources.push(tokens)
  const pairs = tokens.get().pairs
  const devices = pairs.flatMap(pair => [
    { id: `preview-controller-${pair.suffix}`, peerId: `preview-worker-${pair.suffix}`, tokenHash: createHash('sha256').update(pair.controllerToken).digest('hex') },
    { id: `preview-worker-${pair.suffix}`, peerId: `preview-controller-${pair.suffix}`, tokenHash: createHash('sha256').update(pair.workerToken).digest('hex') },
  ])
  const relay = createRelay({ directory: path.join(root, 'relay'), devices, pollMs: 50 })
  resources.push(relay)
  await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const relayUrl = `http://127.0.0.1:${relay.server.address().port}`
  const exportClasses = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
  const actions = ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select']
  // This attestation is ONLY for the deterministic toy execution model below.
  // It does not certify createNativeAdapter or any production Worker policy/recovery.
  const previewReadiness = Object.freeze({ durableJournal: 'verified', firstRouteCapture: 'verified' })
  const controllerPairs = []
  const workerRuntimes = []
  for (const credentials of pairs) {
    const suffix = credentials.suffix, label = `PREVIEW TEST Worker ${suffix.toUpperCase()} — no real host`, machineKey = `preview-machine-${suffix}`
    const projectIds = suffix === 'a' ? ['demo', 'lab'] : ['demo']
    const projects = {}
    for (const projectId of projectIds) {
      const directory = path.join(root, 'workspaces', suffix, projectId)
      await mkdir(directory, { recursive: true })
      projects[projectId] = { workspaceId: `preview-${suffix}-${projectId}`, title: projectId === 'demo' ? 'TEST Conversations' : 'TEST Laboratory' }
    }
    const provider = `preview-${suffix}`
    const initialSelection = { provider, model: 'balanced', reasoningEffort: 'moderate' }
    const modelCatalog = { default: initialSelection, routableProviders: [provider], failures: [], groups: [{ id: provider, name: `${label} models`, models: [
      { id: 'balanced', name: 'TEST Balanced (echo only)', reasoning: { efforts: [{ id: 'moderate', name: 'Moderate' }, { id: 'high', name: 'High' }], defaultEffort: 'moderate' } },
      { id: 'concise', name: 'TEST Concise (echo only)', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'moderate', name: 'Moderate' }], defaultEffort: 'low' } },
    ] }] }
    const append = (events, type, data, surfaceOp) => {
      const event = { type, seq: events.length, time: Date.now(), data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
      snapshotSessionEvent(event); events.push(event)
    }
    const addTurn = (row, question, answer, requestId) => {
      const turn = row.events.filter(event => event.type === 'turn/start').length + 1
      append(row.events, 'turn/start', { turn })
      append(row.events, 'user/message', createUserMessage({ source: { kind: 'user', ...(requestId ? { rpcId: requestId } : {}) }, content: [{ type: 'text', text: question }] }), 'append')
      append(row.events, 'step/start', { turn, step: 1 })
      const stream = new AssistantStreamAccumulator()
      stream.push({ time: Date.now(), chunk: { type: 'text-delta', index: 0, text: answer } })
      append(row.events, 'assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: row.selection.provider, model: row.selection.model }, content: [{ type: 'text', text: answer }] }), stream: [...stream.snapshot()] }, 'append')
      append(row.events, 'step/end', { turn, step: 1 })
      append(row.events, 'turn/end', { turn, reason: { kind: 'completed' } })
    }
    const newRow = (sessionId, projectId) => ({ projectId, header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false }, events: [], selection: { ...initialSelection } })
    const initial = { version: 1, sessions: {} }
    initial.sessions['session-1'] = newRow('session-1', 'demo')
    addTurn(initial.sessions['session-1'], `[TEST ${suffix.toUpperCase()}] Hello from a native-derived fixture.`, `${label}\nThis is a separate test source using real native chat rendering, not a real paired computer.`)
    if (suffix === 'a') {
      initial.sessions['session-2'] = newRow('session-2', 'demo')
      addTurn(initial.sessions['session-2'], '[TEST A] A second session', 'Worker A has two projects and more sessions than Worker B.')
      initial.sessions['session-3'] = newRow('session-3', 'lab')
      addTurn(initial.sessions['session-3'], '[TEST A] Laboratory history', 'Different projects remain separate. Both machines deliberately have native ID session-1.')
    }
    const store = await openJsonStore(path.join(root, 'state', `worker-${suffix}`, 'preview-native.json'), initial)
    resources.push(store)
    let runtime
    const requireRoute = selection => {
      const model = modelCatalog.groups[0].models.find(model => selection.provider === provider && model.id === selection.model)
      if (!model || (selection.reasoningEffort !== undefined && !model.reasoning.efforts.some(effort => effort.id === selection.reasoningEffort))) throw Object.assign(new Error('TEST route unavailable'), { code: 'action-unsupported' })
    }
    const checkExpected = (row, expected) => {
      if (!row || row.events.length - 1 !== expected.frontierSeq || !expected.selection || row.selection.provider !== expected.selection.provider || row.selection.model !== expected.selection.model || row.selection.reasoningEffort !== expected.selection.reasoningEffort) throw Object.assign(new Error('TEST frontier changed'), { code: 'selection-conflict', remoteRefusal: true })
    }
    const backend = {
      mutationReadiness: previewReadiness,
      validateNativeEvents(events) { for (const event of events) { snapshotSessionEvent(event); if (event.type === 'assistant/message') expandAssistantStream(event.data.stream) } },
      nativeAssistantBlocks(stream, interrupted) { const built = assembleAssistantStream(stream); return interrupted ? built.interruptedBlocks() : built.blocks() },
      async read(ref, signal) { signal.throwIfAborted(); const row = store.get().sessions[ref.sessionId]; if (!row || row.projectId !== ref.projectId) throw Object.assign(new Error('TEST source unavailable'), { code: 'source-unavailable' }); return { header: row.header, events: row.events, running: false } },
      async modelCatalog(signal) { signal.throwIfAborted(); return modelCatalog },
      async modelState(ref, signal) { signal.throwIfAborted(); const row = store.get().sessions[ref.sessionId]; return { frontierSeq: row.events.length - 1, selection: row.selection } },
      async create({ ref, reservedSessionId }, dispatch) {
        await dispatch()
        await store.update(state => { if (state.sessions[reservedSessionId]) throw Object.assign(new Error('TEST collision is unknown'), { code: 'outcome-unknown' }); state.sessions[reservedSessionId] = newRow(reservedSessionId, ref.projectId) })
        return { ...ref, sessionId: reservedSessionId }
      },
      async modelSelect(ref, request, dispatch) {
        requireRoute(request.selection); checkExpected(store.get().sessions[ref.sessionId], request.expected)
        await dispatch()
        let result
        await store.update(state => { const row = state.sessions[ref.sessionId]; checkExpected(row, request.expected); row.selection = { ...request.selection }; append(row.events, 'model/selection', row.selection); result = { frontierSeq: row.events.length - 1, selection: row.selection } })
        return result
      },
      async prompt(ref, request, dispatch) {
        checkExpected(store.get().sessions[ref.sessionId], request.expected)
        await dispatch()
        await store.update(state => {
          const row = state.sessions[ref.sessionId]; checkExpected(row, request.expected)
          addTurn(row, request.text, `[PREVIEW TEST — no LLM/tool execution]\n${label}\nModel: ${row.selection.model}; effort: ${row.selection.reasoningEffort ?? 'default'}\nEcho: ${request.text}`, request.requestId)
        })
        return { accepted: true }
      },
      async cancel(ref, request, dispatch) { await dispatch(); return { accepted: true } },
      restoreGuard() {}, close() {},
    }
    const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl, allowLoopback: true, sharedKey: credentials.key, requestTimeoutMs: 10000 }
    const peerId = `preview-controller-${suffix}`
    const grant = { version: 1, grantId: `preview_grant_${suffix}`, principal: { kind: 'controller', id: peerId }, machineKey, revision: 1, issuedAt: 0, projects: projectIds.map(projectId => ({ projectId, actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses, createdSessionGrant: { actions, exportClasses }, sessions: Object.entries(initial.sessions).filter(([, row]) => row.projectId === projectId).map(([sessionId]) => ({ sessionId, imported: true, actions, exportClasses })) })) }
    const settings = await parseSettingsV2({ version: 2, role: 'worker', id: `preview-logical-worker-${suffix}`, machineKey, label, projects, pairs: [{ ...common, id: `preview-worker-${suffix}`, peerId, relayToken: credentials.workerToken, stateDir: path.join(root, 'state', `worker-${suffix}`), grant }] }, path.join(root, 'preview-settings.json'), { resolveWorkspace: id => ({ path: path.join(root, 'workspaces', suffix, id.endsWith('-lab') ? 'lab' : 'demo') }) })
    runtime = await openFederationRuntime(settings, { backend })
    resources.push(runtime); workerRuntimes.push(runtime); runtime.start()
    controllerPairs.push({ ...common, id: peerId, peerId: `preview-worker-${suffix}`, label, relayToken: credentials.controllerToken, stateDir: path.join(root, 'state', `controller-${suffix}`) })
  }
  const settings = await parseSettingsV2({ version: 2, role: 'controller', id: 'preview-logical-controller', pairs: controllerPairs }, path.join(root, 'preview-controller.json'))
  const controller = await openFederationRuntime(settings)
  resources.push(controller); controller.start()
  const registry = ctx.get('sessionSourceController')
  if (!registry) throw new Error('Preview requires the real owner source BFF')
  for (const pair of settings.pairs) {
    const provider = await createHostProvider({ runtime: controller, pair })
    const dispose = registry.registerSource({ ...provider, mutationReadiness: previewReadiness })
    resources.push({ close: async () => { dispose() } })
  }
  ctx.logger?.info('PREVIEW ONLY: two isolated toy Workers registered through real HTTP/JWE, durable journals and native source BFF. No real remote computer, LLM, tool, approval or private pairing is used.')
}
