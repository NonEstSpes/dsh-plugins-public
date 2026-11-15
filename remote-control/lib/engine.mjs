import { createHash, randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ACTIONS = new Set(['create', 'prompt', 'status', 'cancel']);
export const initialEngineState = () => ({ version: 1, sessions: {}, operations: {}, reports: {} });
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function requireId(value, label = 'id') {
  if (typeof value !== 'string' || value.trim() !== value || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function text(value, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16000) throw new Error('Text must contain 1–16000 UTF-8 bytes');
  return value;
}
function boundText(value, bytes = 16000) {
  const raw = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  let clipped = raw.subarray(0, bytes).toString('utf8');
  while (Buffer.byteLength(clipped) > bytes) clipped = clipped.slice(0, -1);
  return { text: clipped, truncated: raw.length > bytes };
}
function cleanError(error) {
  // Backend exception messages can contain local paths, command output, or credentials.
  return error?.publicMessage || 'Operation failed on the worker; inspect its local diagnostics';
}

/** One domain service shared by the DSH tool and the user command. */
export class RemoteEngine {
  constructor({ settings, store, backend, send, publish = async () => {} }) {
    this.settings = settings;
    this.store = store;
    this.backend = backend;
    this.send = send;
    this.publish = publish;
    this.chain = Promise.resolve();
  }
  serial(fn) {
    const promise = this.chain.then(fn);
    this.chain = promise.catch(() => {});
    return promise;
  }
  snapshot(localSessionId) {
    const state = this.store.get();
    const sessions = Object.values(state.sessions).filter(row => this.settings.role === 'worker' || row.localSessionId === localSessionId);
    return {
      configured: true, role: this.settings.role, node: this.settings.id, peer: this.settings.peerId,
      projects: Object.keys(this.settings.projects || {}),
      sessions: sessions.map(({ sessionId, projectId, status, activeOperationId, updatedAt }) => ({ sessionId, projectId, status, activeOperationId, updatedAt })),
      reports: Object.values(state.reports).filter(row => row.localSessionId === localSessionId).slice(-20).map(({ reportId, sessionId, operationId, status, finishedAt, publication }) => ({ reportId, sessionId, operationId, status, finishedAt, publication })),
      limitations: ['No remote approvals', 'No file transfer or publishing', 'Native sandbox and model setup are local to the worker'],
    };
  }
  async execute(input, localSessionId, authority = {}) {
    requireId(localSessionId, 'receiving DSH session');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected operation object');
    if (input.action === 'status' && !input.sessionId) return this.snapshot(localSessionId);
    if (input.action === 'reports') return this.snapshot(localSessionId).reports;
    if (input.action === 'report') {
      const report = this.store.get().reports[requireId(input.reportId, 'reportId')];
      if (!report || report.localSessionId !== localSessionId) throw new Error('Report is not linked to this local chat');
      return report;
    }
    if (this.settings.role !== 'controller') throw new Error('This device is a worker; remote control tools cannot issue commands');
    if (!ACTIONS.has(input.action)) throw new Error('Unsupported action');
    return this.serial(async () => {
      let sessionId = input.sessionId;
      let projectId;
      if (input.action === 'create') {
        projectId = requireId(input.projectId, 'projectId');
        if (!Object.hasOwn(this.settings.projects || {}, projectId)) throw new Error('Project is not in the controller allowlist');
        if (Object.keys(this.store.get().sessions).length >= 100) throw new Error('Session limit reached');
        sessionId = `session-${randomUUID()}`;
      } else {
        requireId(sessionId, 'sessionId');
        const owned = this.store.get().sessions[sessionId];
        if (!owned || owned.localSessionId !== localSessionId) throw new Error('Remote session is not linked to this chat');
        if (input.action === 'prompt' && (owned.activeOperationId || ['queued', 'running', 'accepted', 'cancel-requested', 'unknown'].includes(owned.status))) throw new Error('Wait for completion or reconcile the session before sending another prompt');
      }
      const operationId = randomUUID();
      const body = { operationId, action: input.action, sessionId };
      if (projectId) body.projectId = projectId;
      if (input.action === 'prompt' || input.action === 'create') body.text = text(input.text, input.action === 'create');
      if (input.action === 'cancel' || input.action === 'status') body.runOperationId = this.store.get().sessions[sessionId].activeOperationId;
      const createdAt = stamp();
      const expiresAt = new Date(Date.parse(createdAt) + 10 * 60_000).toISOString();
      await this.store.update(state => {
        state.operations[operationId] = { ...body, localSessionId, wakeOnReport: authority.userWake === true, state: 'queued', createdAt, expiresAt };
        if (input.action === 'create') state.sessions[sessionId] = { sessionId, projectId, localSessionId, createOperationId: operationId, status: 'queued', activeOperationId: body.text ? operationId : null, updatedAt: stamp() };
        else if (input.action === 'prompt') Object.assign(state.sessions[sessionId], { status: 'queued', activeOperationId: operationId, updatedAt: stamp() });
      });
      // The command's durable transport ID is the operation ID. Retries use the stored body, never a fresh mutation.
      let transport = 'saved';
      try { await this.send('command', body, { id: operationId, expiresAt }); }
      catch { transport = 'pending-retry'; }
      return { operationId, sessionId, status: 'queued', transport, meaning: 'Saved for delivery; not yet proof of remote execution. Do not repeat create to retry delivery.' };
    });
  }
  async recoverControllerOutbox() {
    if (this.settings.role !== 'controller') return;
    for (const op of Object.values(this.store.get().operations)) {
      if (op.state !== 'queued') continue;
      const expiresAt = op.expiresAt || new Date(Date.parse(op.createdAt) + 10 * 60_000).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) {
        await this.store.update(state => {
          state.operations[op.operationId].state = 'expired-or-unknown';
          const session = state.sessions[op.sessionId];
          if (session?.activeOperationId === op.operationId || op.action === 'create') session.status = 'unknown';
        });
        continue;
      }
      const { localSessionId, wakeOnReport, state, createdAt, expiresAt: storedExpiry, ...body } = op;
      await this.send('command', body, { id: op.operationId, expiresAt });
    }
  }
  async receive(envelope) {
    if (envelope.from !== this.settings.peerId || envelope.to !== this.settings.id) throw new Error('Peer mismatch');
    if (this.settings.role === 'worker') {
      if (envelope.kind !== 'command') throw new Error('Workers accept commands only');
      return this.serial(() => this.workerCommand(envelope));
    }
    if (envelope.kind === 'response') return this.serial(() => this.controllerResponse(envelope.body));
    if (envelope.kind === 'report') return this.serial(() => this.controllerReport(envelope.body));
    throw new Error('Controllers do not accept commands');
  }
  async workerCommand(envelope) {
    const body = envelope.body;
    if (!body || !ACTIONS.has(body.action)) throw new Error('Invalid command');
    requireId(body.operationId, 'operationId');
    requireId(body.sessionId, 'sessionId');
    if (body.operationId !== envelope.id) throw new Error('Operation ID does not match transport');
    const digest = hash(body);
    let previous = this.store.get().operations[body.operationId];
    if (previous && previous.digest !== digest) throw new Error('Operation ID reused with different arguments');
    if (previous?.response) {
      await this.send('response', previous.response, { id: `response-${body.operationId}` });
      await this.flushWorkerReportOutbox();
      return;
    }
    if (!previous) {
      if (Object.keys(this.store.get().operations).length >= 5000) throw new Error('Worker operation journal is full');
      await this.store.update(state => { state.operations[body.operationId] = { digest, body, phase: 'received', createdAt: stamp() }; });
      previous = this.store.get().operations[body.operationId];
    }
    let response;
    try {
      if (body.action === 'create') {
        requireId(body.projectId, 'projectId');
        if (!Object.hasOwn(this.settings.projects || {}, body.projectId)) throw new Error('Project is not allowed');
        text(body.text, true);
        const owned = this.store.get().sessions[body.sessionId];
        if (owned && (owned.projectId !== body.projectId || owned.createOperationId !== body.operationId)) throw new Error('Session ID already owned by another operation');
        if (!owned) await this.store.update(state => {
          state.sessions[body.sessionId] = { sessionId: body.sessionId, projectId: body.projectId, createOperationId: body.operationId, verifiedOwned: false, status: 'creating', activeOperationId: null, updatedAt: stamp() };
        });
        // ensureSession reconciles exactly this reserved ID. It must NEVER create a replacement ID.
        await this.backend.ensureSession({ sessionId: body.sessionId, projectId: body.projectId, allowExisting: ['native-created', 'settled'].includes(previous.phase) });
        await this.store.update(state => { state.operations[body.operationId].phase = 'native-created'; state.sessions[body.sessionId].verifiedOwned = true; });
        if (body.text) await this.admitPrompt(body);
        else await this.store.update(state => { state.sessions[body.sessionId].status = 'idle'; });
        response = { operationId: body.operationId, sessionId: body.sessionId, action: body.action, status: body.text ? 'accepted' : 'idle' };
      } else {
        const owned = this.store.get().sessions[body.sessionId];
        if (!owned?.verifiedOwned) throw new Error('Native session ownership has not been verified');
        if (body.action === 'prompt') {
          text(body.text);
          await this.admitPrompt(body);
          response = { operationId: body.operationId, sessionId: body.sessionId, action: body.action, status: 'accepted' };
        } else if (body.action === 'status') {
          const observed = await this.backend.status({ sessionId: body.sessionId });
          response = { operationId: body.operationId, sessionId: body.sessionId, action: body.action, status: observed.status, ...(observed.projection ? { projection: observed.projection } : {}) };
        } else {
          if (!body.runOperationId || body.runOperationId !== owned.activeOperationId) throw new Error('Cancellation does not name the current run');
          await this.backend.cancel({ sessionId: body.sessionId });
          response = { operationId: body.operationId, sessionId: body.sessionId, action: body.action, status: 'cancel-requested' };
        }
      }
    } catch (error) {
      response = { operationId: body.operationId, sessionId: body.sessionId, action: body.action, status: 'unknown', error: cleanError(error) };
      await this.store.update(state => {
        const session = state.sessions[body.sessionId];
        if (session && (session.activeOperationId === body.operationId || body.action === 'create')) session.status = 'unknown';
      });
    }
    await this.store.update(state => { state.operations[body.operationId].response = response; state.operations[body.operationId].phase = 'settled'; });
    await this.send('response', response, { id: `response-${body.operationId}` });
    // Completion may have raced the acceptance response. Read the native projection after admission.
    const observed = this.store.get().sessions[body.sessionId]?.verifiedOwned ? await this.backend.status({ sessionId: body.sessionId }).catch(() => null) : null;
    if (observed?.projection) await this.acceptSnapshot(body.sessionId, observed.projection);
  }
  async admitPrompt(body) {
    const session = this.store.get().sessions[body.sessionId];
    if (session.activeOperationId && session.activeOperationId !== body.operationId) throw new Error('Another run is active');
    const observed = await this.backend.status({ sessionId: body.sessionId });
    if (!session.activeOperationId) {
      if (observed.status === 'running') throw new Error('Native session is busy');
      await this.store.update(state => { Object.assign(state.sessions[body.sessionId], { activeOperationId: body.operationId, submittedAfterSeq: observed.seq ?? -1, status: 'running', updatedAt: stamp() }); });
    }
    // Native DSH requestId is this operationId, including recovery after an ambiguous acceptance.
    await this.backend.prompt({ sessionId: body.sessionId, operationId: body.operationId, text: body.text });
  }
  async controllerResponse(body) {
    const operation = this.store.get().operations[body?.operationId];
    if (!operation || operation.sessionId !== body.sessionId || operation.action !== body.action) throw new Error('Unsolicited response');
    const allowed = new Set(['accepted', 'idle', 'running', 'unknown', 'cancel-requested', 'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted']);
    if (!allowed.has(body.status)) throw new Error('Invalid response status');
    await this.store.update(state => {
      state.operations[body.operationId].state = body.status;
      const session = state.sessions[body.sessionId];
      // An acceptance arriving after the final report cannot put a finished session back into running.
      const appliesToCurrentRun = body.action === 'status' || body.action === 'cancel'
        ? session.activeOperationId === operation.runOperationId
        : session.activeOperationId === body.operationId || (body.action === 'create' && !operation.text && !session.activeOperationId && session.createOperationId === body.operationId);
      if (!state.operations[body.operationId].reportId && appliesToCurrentRun) {
        session.status = body.status;
        session.updatedAt = stamp();
      }
    });
  }
  /** Called from a native DSH incremental projection, NOT repeated event-log rescans. */
  async acceptSnapshot(sessionId, projection) {
    const session = this.store.get().sessions[sessionId];
    if (!session?.verifiedOwned || !session.activeOperationId || !projection || !['completed', 'failed', 'blocked', 'max-tokens', 'aborted', 'cancelled', 'interrupted', 'forked'].includes(projection.status) || projection.endedSeq <= (session.submittedAfterSeq ?? -1) || !projection.requestIds?.includes(session.activeOperationId)) return;
    const operationId = session.activeOperationId;
    const reportId = `report-${operationId}`;
    let report = this.store.get().reports[reportId];
    if (!report) {
      const bounded = boundText(projection.text);
      report = { sessionId, operationId, reportId, status: projection.status, text: bounded.text, truncated: Boolean(projection.truncated || bounded.truncated), finishedAt: projection.finishedAt || stamp() };
      await this.store.update(state => {
        state.reports[reportId] = report;
        Object.assign(state.sessions[sessionId], { status: report.status, activeOperationId: null, updatedAt: stamp() });
      });
    }
    await this.send('report', report, { id: reportId });
    await this.store.update(state => { (state.reportDeliveries ??= {})[reportId] = true; });
  }
  async flushWorkerReportOutbox() {
    if (this.settings.role !== 'worker') return;
    for (const report of Object.values(this.store.get().reports)) {
      if (this.store.get().reportDeliveries?.[report.reportId]) continue;
      await this.send('report', report, { id: report.reportId });
      await this.store.update(state => { (state.reportDeliveries ??= {})[report.reportId] = true; });
    }
  }
  async recoverWorkerReports() {
    if (this.settings.role !== 'worker') return;
    await this.flushWorkerReportOutbox();
    for (const session of Object.values(this.store.get().sessions)) {
      if (!session.verifiedOwned || !session.activeOperationId) continue;
      const observed = await this.backend.status({ sessionId: session.sessionId }).catch(() => null);
      if (observed?.projection) await this.acceptSnapshot(session.sessionId, observed.projection);
    }
  }
  async controllerReport(body) {
    requireId(body?.reportId, 'reportId');
    const state = this.store.get();
    const operation = state.operations[body.operationId];
    if (!operation || operation.sessionId !== body.sessionId || !['create', 'prompt'].includes(operation.action) || !operation.text) throw new Error('Report does not correlate to an issued prompt');
    if (body.reportId !== `report-${body.operationId}`) throw new Error('Invalid report identity');
    const bounded = boundText(body.text);
    if (typeof body.status !== 'string' || body.status.length > 40 || !Number.isFinite(Date.parse(body.finishedAt))) throw new Error('Invalid report');
    const prior = state.reports[body.reportId];
    if (prior && prior.digest !== hash(body)) throw new Error('Report contents changed');
    if (!prior) await this.store.update(next => {
      next.reports[body.reportId] = { ...body, text: bounded.text, truncated: Boolean(body.truncated || bounded.truncated), localSessionId: operation.localSessionId, digest: hash(body), publication: 'pending' };
      next.operations[body.operationId].state = body.status;
      next.operations[body.operationId].reportId = body.reportId;
      if (next.sessions[body.sessionId].activeOperationId === body.operationId) Object.assign(next.sessions[body.sessionId], { status: body.status, activeOperationId: null, updatedAt: stamp() });
    });
    await this.publishPending(body.reportId);
  }
  async publishPending(reportId) {
    const report = this.store.get().reports[reportId];
    if (report.publication !== 'pending') return;
    const consent = this.store.get().operations[report.operationId]?.wakeOnReport === true;
    await this.publish(report, consent && this.settings.delivery === 'wake' ? 'wake' : 'notify');
    await this.store.update(state => { state.reports[reportId].publication = this.settings.delivery === 'wake' ? 'queued-in-chat' : 'available'; });
  }
  async recoverPublications() {
    if (this.settings.role !== 'controller') return;
    for (const report of Object.values(this.store.get().reports)) if (report.publication === 'pending') await this.publishPending(report.reportId);
  }
  async close() { await this.chain; }
}
