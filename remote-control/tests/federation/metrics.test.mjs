import assert from 'node:assert/strict'
import test from 'node:test'
import { projectNativeMetrics } from '../../lib/federation/metrics.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS, jsonByteLength } from '../../lib/federation/protocol.mjs'

const CUT = 12
const ALL = ['statistics', 'usage', 'context.metrics']
const KEYS = ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown']
const GRANTS = { sessionStats: 'statistics', tokenUsage: 'usage', contextPressure: 'context.metrics', contextBreakdown: 'context.metrics' }
const SECRET = 'PRIVATE_HOST_METRICS_DIAGNOSTIC_827'
const clone = value => structuredClone(value)
const baseline = () => ({ asOfSeq: CUT, values: {
  sessionStats: { turns: 2, steps: 5, llmMs: 100.5, toolMs: 33.25, ttftMs: 20, ttftSteps: 3, decodeMs: 80.125, decodeTokens: 10.5 },
  tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 1 },
  contextPressure: { pressureTokens: 30, projectedTokens: 40, contextWindow: 4096 },
  contextBreakdown: { systemTokens: 10, toolsTokens: 12, messageTokens: 100 },
} })
const request = (exportClasses = ALL, source = baseline(), throughSeq = CUT) => ({ baseline: source, throughSeq, exportClasses })
const invalid = operation => assert.throws(operation, error => error instanceof FederationContractError
  && error.code === FAILURE_CODES.INVALID_MESSAGE && error.message === 'invalid native metrics projection'
  && !JSON.stringify(error).includes(SECRET) && error.detail === undefined && error.cause === undefined)
const unavailable = state => Object.fromEntries(KEYS.map(key => [key, state]))

function getter(target, name, read) {
  Object.defineProperty(target, name, { enumerable: true, configurable: true, get: read })
}

test('copies all four exact native views and preserves finite fractional stats measures', () => {
  const source = baseline(), original = clone(source)
  const projected = projectNativeMetrics(request(ALL, source))
  assert.deepEqual(projected, { projections: { asOfSeq: CUT, values: source.values }, availability: unavailable('available') })
  assert.deepEqual(source, original)
  assert.notEqual(projected.projections.values, source.values)
  for (const key of KEYS) assert.notEqual(projected.projections.values[key], source.values[key])
  assert.equal(projected.projections.values.sessionStats.decodeTokens, 10.5)
  assert.equal(projected.projections.values.sessionStats.toolMs, 33.25)
})

test('each explicit class grants only its named units for all permission combinations', () => {
  for (let bits = 0; bits < 8; bits++) {
    const classes = ALL.filter((_, index) => bits & (1 << index))
    const projected = projectNativeMetrics(request(classes))
    for (const key of KEYS) {
      const allowed = classes.includes(GRANTS[key])
      assert.equal(projected.availability[key], allowed ? 'available' : 'denied')
      assert.equal(Object.hasOwn(projected.projections.values, key), allowed)
    }
  }
})

test('conversation/tool classes, unknown strings and near-matching names never infer metrics permission', () => {
  const classes = ['conversation.assistant', 'conversation.user', 'tool.call', 'tool.result', 'turn', 'model.selection',
    'reasoning', 'files', 'context', 'context.metrics.extra', 'statistics ', 'Usage', 'unknown', '私密😀'.repeat(20000)]
  assert.deepEqual(projectNativeMetrics(request(classes)), {
    projections: { asOfSeq: CUT, values: {} }, availability: unavailable('denied'),
  })
  assert.deepEqual(projectNativeMetrics(request(['usage', 'usage', 'future.class'])).availability,
    { sessionStats: 'denied', tokenUsage: 'available', contextPressure: 'denied', contextBreakdown: 'denied' })
})

test('without authorized units even the baseline getter is never read', () => {
  for (const classes of [[], ['conversation.assistant'], ['tool.result']]) {
    const input = { throughSeq: CUT, exportClasses: classes }
    getter(input, 'baseline', () => { throw new Error(SECRET) })
    assert.deepEqual(projectNativeMetrics(input), { projections: { asOfSeq: CUT, values: {} }, availability: unavailable('denied') })
  }
  assert.deepEqual(projectNativeMetrics(request([], { asOfSeq: -999, values: null })), {
    projections: { asOfSeq: CUT, values: {} }, availability: unavailable('denied'),
  })
})

test('denied and unrelated values and raw-state getters are never inspected or enumerated into output', () => {
  const source = baseline()
  getter(source.values, 'tokenUsage', () => { throw new Error(SECRET) })
  getter(source.values, 'contextPressure', () => { throw new Error(SECRET) })
  getter(source.values, 'contextBreakdown', () => { throw new Error(SECRET) })
  getter(source.values, 'privateCheckpoint', () => { throw new Error(SECRET) })
  getter(source, 'checkpoint', () => { throw new Error(SECRET) })
  const projected = projectNativeMetrics(request(['statistics'], source))
  assert.deepEqual(Object.keys(projected.projections.values), ['sessionStats'])
  assert.deepEqual(projected.projections.values.sessionStats, source.values.sessionStats)
  assert.deepEqual(projected.availability, { sessionStats: 'available', tokenUsage: 'denied', contextPressure: 'denied', contextBreakdown: 'denied' })
})

test('huge multibyte private/unrelated fields are not serialized or charged against the emitted result', () => {
  const source = baseline(), ordinary = projectNativeMetrics(request(['statistics'], clone(source)))
  source.values.tokenUsage = { private: '私密😀'.repeat(PROTOCOL_LIMITS.maxPageBytes) }
  source.values.contextPressure = { rawState: SECRET.repeat(PROTOCOL_LIMITS.maxPageBytes) }
  source.values.privateToolOutput = { reasoning: SECRET.repeat(PROTOCOL_LIMITS.maxPageBytes) }
  source.checkpoint = { events: [SECRET], schema: 'private' }
  const projected = projectNativeMetrics(request(['statistics'], source))
  assert.deepEqual(projected, ordinary)
  assert.equal(jsonByteLength(projected), jsonByteLength(ordinary))
  assert.equal(JSON.stringify(projected).includes(SECRET), false)
})

test('a missing baseline means unsupported only for authorized units, never default zero data', () => {
  for (const input of [
    { throughSeq: CUT, exportClasses: ALL },
    { throughSeq: CUT, exportClasses: ALL, baseline: undefined },
    { throughSeq: CUT, exportClasses: ALL, baseline: null },
  ]) assert.deepEqual(projectNativeMetrics(input), { projections: { asOfSeq: CUT, values: {} }, availability: unavailable('unsupported') })
  assert.deepEqual(projectNativeMetrics({ throughSeq: CUT, exportClasses: ['usage'] }), {
    projections: { asOfSeq: CUT, values: {} },
    availability: { sessionStats: 'denied', tokenUsage: 'unsupported', contextPressure: 'denied', contextBreakdown: 'denied' },
  })
})

test('missing units have independent unsupported status and do not borrow another unit or checkpoint', () => {
  const source = baseline()
  delete source.values.sessionStats
  delete source.values.contextBreakdown
  source.checkpoint = { sessionStats: { turns: 500 }, contextBreakdown: { systemTokens: 500 } }
  const projected = projectNativeMetrics(request(ALL, source))
  assert.deepEqual(projected.availability, { sessionStats: 'unsupported', tokenUsage: 'available', contextPressure: 'available', contextBreakdown: 'unsupported' })
  assert.deepEqual(Object.keys(projected.projections.values), ['tokenUsage', 'contextPressure'])
  assert.deepEqual(projectNativeMetrics(request(ALL, { asOfSeq: CUT, values: {} })).availability, unavailable('unsupported'))
})

test('optional pressure members remain absent, while an empty supported view stays available', () => {
  for (const pressure of [{}, { pressureTokens: 0 }, { projectedTokens: 0 }, { contextWindow: 1 }, { pressureTokens: 7, contextWindow: 4096 }]) {
    const source = baseline(); source.values.contextPressure = pressure
    const projected = projectNativeMetrics(request(['context.metrics'], source))
    assert.deepEqual(projected.projections.values.contextPressure, pressure)
    assert.deepEqual(Object.keys(projected.projections.values.contextPressure), Object.keys(pressure))
    assert.equal(projected.availability.contextPressure, 'available')
  }
})

test('genuine zero views and empty-log cuts are preserved as available, not invented for missing data', () => {
  const source = baseline(); source.asOfSeq = -1
  for (const key of ['sessionStats', 'tokenUsage', 'contextBreakdown']) {
    for (const field of Object.keys(source.values[key])) source.values[key][field] = 0
  }
  source.values.contextPressure = { pressureTokens: 0, projectedTokens: 0 }
  const projected = projectNativeMetrics(request(ALL, source, -1))
  assert.deepEqual(projected.projections, source)
  assert.deepEqual(projected.availability, unavailable('available'))
})

test('context units retain independent native observations without re-estimation or synthetic totals', () => {
  const source = baseline()
  source.values.contextPressure = { pressureTokens: 100000, projectedTokens: 2, contextWindow: 1 }
  source.values.contextBreakdown = { systemTokens: 500, toolsTokens: 10, messageTokens: 800 }
  const projected = projectNativeMetrics(request(['context.metrics'], source))
  assert.deepEqual(projected.projections.values.contextPressure, source.values.contextPressure)
  assert.deepEqual(projected.projections.values.contextBreakdown, source.values.contextBreakdown)
  assert.equal(Object.hasOwn(projected.projections.values, 'totalTokens'), false)
  assert.equal(Object.hasOwn(projected.projections.values.contextPressure, 'percentage'), false)
})

test('an older or newer observed cut cannot be relabeled for a different event batch', () => {
  for (const observed of [CUT - 1, CUT + 1, -1, 0]) {
    const source = baseline(); source.asOfSeq = observed
    invalid(() => projectNativeMetrics(request(ALL, source)))
  }
  const source = baseline(); source.asOfSeq = Number.MAX_SAFE_INTEGER
  assert.equal(projectNativeMetrics(request(ALL, source, Number.MAX_SAFE_INTEGER)).projections.asOfSeq, Number.MAX_SAFE_INTEGER)
})

test('malformed cut and authorized baseline envelopes fail with a static diagnostic', () => {
  for (const throughSeq of [-2, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '12', null, undefined]) {
    invalid(() => projectNativeMetrics({ baseline: baseline(), exportClasses: [], throughSeq }))
  }
  for (const source of [
    {}, [], 42, 'baseline', { asOfSeq: CUT }, { values: {} },
    { asOfSeq: CUT, values: null }, { asOfSeq: CUT, values: [] },
    { asOfSeq: NaN, values: {} }, { asOfSeq: -0, values: {} },
  ]) invalid(() => projectNativeMetrics(request(['usage'], source)))
})

test('required numeric fields are exact; no scalar coercion, unsafe counts or negative values are accepted', () => {
  const source = baseline()
  for (const key of KEYS) {
    for (const field of Object.keys(source.values[key])) {
      const isMeasure = key === 'sessionStats' && ['llmMs', 'toolMs', 'ttftMs', 'decodeMs', 'decodeTokens'].includes(field)
      const bad = [NaN, Infinity, -Infinity, -1, -0, '0', null, true, undefined]
      if (!isMeasure) bad.push(0.5, Number.MAX_SAFE_INTEGER + 1)
      if (field === 'contextWindow') bad.push(0)
      for (const value of bad) {
        const changed = baseline(); changed.values[key][field] = value
        invalid(() => projectNativeMetrics(request([GRANTS[key]], changed)))
      }
    }
  }
})

test('missing required fields and unknown numeric-view properties fail closed without key echo', () => {
  for (const key of ['sessionStats', 'tokenUsage', 'contextBreakdown']) {
    for (const field of Object.keys(baseline().values[key])) {
      const source = baseline(); delete source.values[key][field]
      invalid(() => projectNativeMetrics(request([GRANTS[key]], source)))
    }
  }
  for (const key of KEYS) {
    const source = baseline(); source.values[key][`私密-${SECRET}`] = 1
    invalid(() => projectNativeMetrics(request([GRANTS[key]], source)))
  }
})

test('raw projection checkpoint/state rows are never folded or treated as wire views', () => {
  for (const key of KEYS) {
    const source = baseline(), original = clone(source.values[key])
    source.values[key] = { ver: 99, seq: CUT, val: original }
    invalid(() => projectNativeMetrics(request([GRANTS[key]], source)))
    source.values[key] = { ...original, pendingCalls: {}, rawState: SECRET }
    invalid(() => projectNativeMetrics(request([GRANTS[key]], source)))
  }
})

test('malformed present units cannot masquerade as missing unsupported units', () => {
  for (const key of KEYS) {
    for (const value of [undefined, null, [], 'private', 0]) {
      const source = baseline(); source.values[key] = value
      invalid(() => projectNativeMetrics(request([GRANTS[key]], source)))
    }
  }
})

test('native accessor exceptions, including typed ones, never export their private messages', () => {
  for (const failure of [new Error(SECRET), new FederationContractError('outcome-unknown', SECRET, { cause: SECRET })]) {
    const source = baseline()
    getter(source.values, 'tokenUsage', () => { throw failure })
    invalid(() => projectNativeMetrics(request(['usage'], source)))
  }
  const source = baseline()
  getter(source.values.sessionStats, 'turns', () => { throw new Error(SECRET) })
  invalid(() => projectNativeMetrics(request(['statistics'], source)))
})

test('request classes are a JSON string array; unrecognized strings are ignored, not interpreted', () => {
  for (const exportClasses of [null, 'usage', {}, [1], ['usage', false], [new String('usage')]]) {
    invalid(() => projectNativeMetrics({ throughSeq: CUT, baseline: baseline(), exportClasses }))
  }
  invalid(() => projectNativeMetrics({ throughSeq: CUT, baseline: baseline() }))
  invalid(() => projectNativeMetrics({ throughSeq: CUT, baseline: baseline(), exportClasses: ALL, [SECRET]: true }))
})

test('maximum finite numeric views have a complete bounded result without artificial budget knobs', () => {
  const source = baseline()
  for (const key of KEYS) {
    for (const field of Object.keys(source.values[key])) source.values[key][field] = Number.MAX_SAFE_INTEGER
  }
  for (const field of ['llmMs', 'toolMs', 'ttftMs', 'decodeMs', 'decodeTokens']) source.values.sessionStats[field] = Number.MAX_VALUE
  const projected = projectNativeMetrics(request(ALL, source))
  assert.deepEqual(projected.projections.values, source.values)
  assert.ok(jsonByteLength(projected) < 2048)
  assert.ok(jsonByteLength(projected) <= PROTOCOL_LIMITS.maxPageBytes)
  assert.ok(jsonByteLength(projected) > jsonByteLength(projected.projections.values))
  source.values.sessionStats.decodeMs = Number.MIN_VALUE
  assert.equal(projectNativeMetrics(request(ALL, source)).projections.values.sessionStats.decodeMs, Number.MIN_VALUE)
})

test('null-prototype JSON views are copied into detached normal objects', () => {
  const source = baseline()
  source.values = Object.assign(Object.create(null), source.values)
  for (const key of KEYS) source.values[key] = Object.assign(Object.create(null), source.values[key])
  const projected = projectNativeMetrics(request(ALL, source))
  for (const key of KEYS) {
    assert.equal(Object.getPrototypeOf(projected.projections.values[key]), Object.prototype)
    assert.deepEqual({ ...projected.projections.values[key] }, { ...source.values[key] })
  }
})

test('deep immutability never freezes or mutates the caller baseline, classes or observation', () => {
  const source = baseline(), classes = [...ALL], original = clone(source)
  const projected = projectNativeMetrics(request(classes, source))
  assert.deepEqual(source, original)
  assert.equal(Object.isFrozen(source.values.sessionStats), false)
  for (const value of [projected, projected.projections, projected.projections.values, projected.availability,
    ...Object.values(projected.projections.values)]) assert.equal(Object.isFrozen(value), true)
  source.asOfSeq = 99; source.values.sessionStats.turns = 99; classes.length = 0
  assert.equal(projected.projections.asOfSeq, CUT)
  assert.equal(projected.projections.values.sessionStats.turns, original.values.sessionStats.turns)
  assert.throws(() => { projected.projections.values.tokenUsage.outputTokens = 0 }, TypeError)
  assert.throws(() => { projected.availability.sessionStats = 'denied' }, TypeError)
})
