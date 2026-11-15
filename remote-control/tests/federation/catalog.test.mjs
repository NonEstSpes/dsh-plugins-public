import assert from 'node:assert/strict'
import test from 'node:test'

import { FederationContractError } from '../../lib/federation/identity.mjs'
import {
  buildSourceCatalog,
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseSourceCatalogPage,
  projectModelCatalog,
} from '../../lib/federation/catalog.mjs'
import { GRANT_CODES } from '../../lib/federation/grants.mjs'
import { FAILURE_CODES } from '../../lib/federation/protocol.mjs'

// Synthetic identities; not identifiers from an installed deployment.
const PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_fixture_0001' })
const MACHINE = 'worker_fixture_0001'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = 'session-22222222-2222-4222-8222-222222222222'
const REVIEWED = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']

function grant(overrides = {}) {
  const base = {
    version: 1,
    grantId: 'grant_abcdef12',
    principal: { ...PRINCIPAL },
    machineKey: MACHINE,
    revision: 3,
    issuedAt: 1000,
    projects: [{
      projectId: 'demo',
      actions: ['project.list', 'session.list', 'session.create', 'model.list'],
      exportClasses: [...REVIEWED],
      sessions: [{
        sessionId: SESSION,
        imported: true,
        actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'],
        exportClasses: [...REVIEWED],
      }],
    }],
  }
  return { ...base, ...overrides }
}

function request(overrides = {}) {
  return {
    machineKey: MACHINE,
    generation: 1,
    grantRevision: 3,
    principal: { ...PRINCIPAL },
    grant: grant(),
    now: 2000,
    projects: [
      { projectId: 'demo', title: 'Demo' },
      { projectId: 'empty', title: 'Empty' },
    ],
    sessions: [
      { sessionId: SESSION, projectId: 'demo', title: 'Calc', updatedAt: 10, running: false, blank: false },
      { sessionId: OTHER_SESSION, projectId: 'demo', title: 'Denied', updatedAt: 20, running: true, blank: false },
    ],
    ...overrides,
  }
}

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && (error.code === code || String(error.message).includes(code)))
}

test('catalog filters explicit grants and computes capabilities', () => {
  const page = buildSourceCatalog(request({
    grant: grant({
      projects: [{
        projectId: 'demo',
        actions: ['project.list', 'session.list', 'session.create', 'model.list'],
        exportClasses: [...REVIEWED],
        createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt'], exportClasses: [...REVIEWED] },
        sessions: [{
          sessionId: SESSION,
          imported: true,
          actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'],
          exportClasses: [...REVIEWED],
        }],
      }, {
        projectId: 'empty',
        actions: ['project.list'],
        exportClasses: [],
        sessions: [],
      }],
    }),
    sessions: [
      { sessionId: SESSION, projectId: 'demo', title: 'Calc', updatedAt: 10, running: false, blank: false },
      { sessionId: OTHER_SESSION, projectId: 'demo', title: 'Denied', updatedAt: 20, running: true, blank: false },
    ],
  }))
  assert.equal(page.generation, 1)
  assert.equal(page.grantRevision, 3)
  assert.deepEqual(page.projects.map(project => project.ref.projectId), ['demo', 'empty'])
  assert.equal(page.projects[0].canCreate, true)
  assert.equal(page.projects[1].canCreate, false)
  assert.equal(page.sessions.length, 1)
  assert.equal(page.sessions[0].ref.sessionId, SESSION)
  assert.equal(page.sessions[0].capabilities.history, true)
  assert.equal(page.sessions[0].capabilities.prompt, true)
  assert.equal(page.sessions[0].capabilities.cancel, true)
  assert.equal(page.sessions[0].capabilities.modelSelect, true)
  assert.equal(page.sessions[0].capabilities.create, false)
  assert.equal(page.sessions[0].capabilities.files, false)
  assert.equal(page.sessions[0].capabilities.approvals, false)
})

test('catalog omits sessions outside the explicit grants, including existing ones', () => {
  const page = buildSourceCatalog(request())
  assert.equal(page.sessions.length, 1)
  assert.equal(page.sessions[0].ref.sessionId, SESSION)
  assert.equal(JSON.stringify(page).includes('Denied'), false)
})

test('catalog pages are cursor-continued and generation-bound', () => {
  const twoSessions = grant()
  twoSessions.projects[0].sessions.push({
    sessionId: OTHER_SESSION,
    imported: true,
    actions: ['session.status', 'session.read'],
    exportClasses: ['conversation.user'],
  })
  const first = buildSourceCatalog(request({ grant: twoSessions, maxItems: 1 }))
  assert.equal(first.sessions.length, 1)
  assert.equal(typeof first.nextCursor, 'string')
  const second = buildSourceCatalog(request({ grant: twoSessions, maxItems: 1, cursor: first.nextCursor }))
  assert.equal(second.sessions.length, 1)
  assert.deepEqual(second.projects, [])
  assert.equal(second.nextCursor, undefined)
  assert.notEqual(second.sessions[0].ref.sessionId, first.sessions[0].ref.sessionId)

  const decoded = decodeCatalogCursor(first.nextCursor, { machineKey: MACHINE, generation: 1, grantRevision: 3 })
  assert.equal(decoded.offset, 1)
  rejects(() => decodeCatalogCursor(first.nextCursor, { machineKey: MACHINE, generation: 2, grantRevision: 3 }), FAILURE_CODES.CATALOG_STALE)
  rejects(() => encodeCatalogCursor({ machineKey: MACHINE, generation: 1, grantRevision: 3, offset: -1 }), FAILURE_CODES.INVALID_MESSAGE)
})

test('catalog refuses a mismatched machine grant and oversized single rows', () => {
  rejects(() => buildSourceCatalog(request({ grant: grant({ machineKey: 'worker_aaaaaaaaaaaaaaaa' }) })), FAILURE_CODES.NOT_GRANTED)
  rejects(() => buildSourceCatalog(request({ maxBytes: 30 })), FAILURE_CODES.PAGE_TOO_LARGE)
  rejects(() => buildSourceCatalog(request({ maxItems: 0 })), FAILURE_CODES.INVALID_MESSAGE)
})

test('catalog page parser is strict', () => {
  const page = buildSourceCatalog(request())
  assert.deepEqual(parseSourceCatalogPage(page), page)
  rejects(() => parseSourceCatalogPage({ ...page, sessions: [{ ...page.sessions[0], capabilities: { history: true } }] }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parseSourceCatalogPage({ ...page, nextCursor: 'bad' }), FAILURE_CODES.INVALID_MESSAGE)
})

test('model catalog projection keeps every effort and drops unsafe metadata', () => {
  const nativeCatalog = {
    default: { provider: 'deepseek-account', model: 'deepseek-chat', reasoningEffort: 'high' },
    routableProviders: ['deepseek-account'],
    groups: [{
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [{
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'secret model description',
        badge: { text: 'secret badge', tone: 'info' },
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low', description: 'secret effort description' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      }],
    }],
    failures: [{ id: 'other', name: 'Other', message: 'secret provider failure' }],
  }
  const projected = projectModelCatalog({
    modelCatalog: nativeCatalog,
    grant: grant(),
    machineKey: MACHINE,
    principal: PRINCIPAL,
    projectId: 'demo',
    grantRevision: 3,
    now: 2000,
  })
  assert.deepEqual(projected.default, nativeCatalog.default)
  assert.deepEqual(projected.groups[0].models[0], {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      defaultEffort: 'high',
    },
  })
  const serialized = JSON.stringify(projected)
  assert.equal(serialized.includes('secret'), false)
  assert.equal(serialized.includes('description'), false)
  assert.equal(serialized.includes('badge'), false)
  assert.deepEqual(projected.routableProviders, ['deepseek-account'])
  assert.deepEqual(projected.failures, [{ id: 'other', name: 'Other', message: 'Provider model catalogue is unavailable on the Worker.' }])
})

test('catalog status metadata is absent without session.status; no false flag defaults', () => {
  const restricted = grant()
  restricted.projects[0].sessions[0].actions = ['session.read', 'session.follow']
  const page = buildSourceCatalog(request({ grant: restricted }))
  assert.equal(page.sessions.length, 1)
  assert.equal(Object.hasOwn(page.sessions[0], 'running'), false)
  assert.equal(Object.hasOwn(page.sessions[0], 'blank'), false)
  assert.deepEqual(parseSourceCatalogPage(page), page)
  rejects(() => parseSourceCatalogPage({ ...page, sessions: [{ ...page.sessions[0], running: false }] }), FAILURE_CODES.INVALID_MESSAGE)
})

test('model catalog obeys the explicit model-list grant', () => {
  const noModelGrant = grant()
  noModelGrant.projects[0].actions = ['project.list']
  rejects(() => projectModelCatalog({
    modelCatalog: { default: { provider: 'p', model: 'm' }, groups: [] },
    grant: noModelGrant,
    machineKey: MACHINE,
    principal: PRINCIPAL,
    projectId: 'demo',
    grantRevision: 3,
    now: 2000,
  }), FAILURE_CODES.NOT_GRANTED)
  rejects(() => projectModelCatalog({
    modelCatalog: { default: { provider: 'p', model: 'm' }, groups: [{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M', reasoning: { efforts: [] } }] }] },
    grant: grant(),
    machineKey: MACHINE,
    principal: PRINCIPAL,
    projectId: 'demo',
    grantRevision: 2,
    now: 2000,
  }), FAILURE_CODES.NOT_GRANTED)
})
