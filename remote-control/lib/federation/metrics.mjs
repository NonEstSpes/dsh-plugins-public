/**
 * Passive, explicitly authorized copies of native client-visible projection views.
 * No events, checkpoints, raw fold state, pricing, or model defaults are read here.
 * The Worker caller supplies one exact coherent cut; a newer cached observation must
 * be omitted for an older batch, never relabeled with that batch's throughSeq.
 * @module dsh-remote-control/federation/metrics
 */
import { FederationContractError } from './identity.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS, jsonByteLength } from './protocol.mjs'

const UNIT_GRANTS = Object.freeze({
  sessionStats: 'statistics', tokenUsage: 'usage',
  contextPressure: 'context.metrics', contextBreakdown: 'context.metrics',
})
const STATS_FIELDS = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens']
const STATS_MEASURES = ['llmMs', 'toolMs', 'ttftMs', 'decodeMs', 'decodeTokens']
const USAGE_FIELDS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const PRESSURE_FIELDS = ['pressureTokens', 'projectedTokens', 'contextWindow']
const BREAKDOWN_FIELDS = ['systemTokens', 'toolsTokens', 'messageTokens']
const own = (value, key) => Object.hasOwn(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const cursor = value => Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const measure = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0)
const invalid = () => { throw new FederationContractError(FAILURE_CODES.INVALID_MESSAGE, 'invalid native metrics projection') }

function exact(value, required, optional = []) {
  if (!record(value) || required.some(key => !own(value, key))) invalid()
  for (const key in value) if (own(value, key) && !required.includes(key) && !optional.includes(key)) invalid()
}

function numericView(value, required, optional = [], measures = []) {
  exact(value, required, optional)
  const projected = {}
  for (const key of [...required, ...optional]) {
    if (!own(value, key)) continue
    const numeric = value[key]
    if (!(measures.includes(key) ? measure(numeric) : count(numeric)) || (key === 'contextWindow' && numeric === 0)) invalid()
    projected[key] = numeric
  }
  return projected
}

function projectView(key, value) {
  switch (key) {
    case 'sessionStats': return numericView(value, STATS_FIELDS, [], STATS_MEASURES)
    case 'tokenUsage': return numericView(value, USAGE_FIELDS)
    case 'contextPressure': return numericView(value, [], PRESSURE_FIELDS)
    case 'contextBreakdown': return numericView(value, BREAKDOWN_FIELDS)
  }
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

/**
 * Copy only granted, present native wire views at the requested log cut.
 * @param {{baseline?:{asOfSeq:number,values:object}|null,throughSeq:number,exportClasses:readonly string[]}} request - original native ProjectionSnapshot (not checkpoint/state), exact batch cut, and explicitly granted classes; unrelated class strings do not grant metrics.
 * @returns {Readonly<{projections:{asOfSeq:number,values:object},availability:object}>} detached immutable views and per-unit available/denied/unsupported status; absent pressure members stay absent.
 * @throws {FederationContractError} static invalid-message for malformed authorized views or a mismatched cut; page-too-large if the complete projection/status result exceeds 32 KiB.
 */
export function projectNativeMetrics(request) {
  let projected
  try {
    exact(request, ['throughSeq', 'exportClasses'], ['baseline'])
    const throughSeq = request.throughSeq, exportClasses = request.exportClasses
    if (!cursor(throughSeq) || !Array.isArray(exportClasses)) invalid()
    const granted = new Set()
    for (const name of exportClasses) {
      if (typeof name !== 'string') invalid()
      if (name === 'statistics' || name === 'usage' || name === 'context.metrics') granted.add(name)
    }
    let sourceValues
    // Authorization precedes even reading a baseline getter or enumerating its contents.
    if (granted.size > 0) {
      const baseline = request.baseline
      if (baseline !== undefined && baseline !== null) {
        if (!record(baseline) || !own(baseline, 'asOfSeq') || !own(baseline, 'values')) invalid()
        const observed = baseline.asOfSeq
        if (!cursor(observed) || observed !== throughSeq) invalid()
        sourceValues = baseline.values
        if (!record(sourceValues)) invalid()
      }
    }
    const values = {}, availability = {}
    for (const key of Object.keys(UNIT_GRANTS)) {
      if (!granted.has(UNIT_GRANTS[key])) { availability[key] = 'denied'; continue }
      availability[key] = 'unsupported'
      // No access to denied or unrelated view values, even when they are malformed.
      if (sourceValues === undefined || !own(sourceValues, key)) continue
      values[key] = projectView(key, sourceValues[key])
      availability[key] = 'available'
    }
    projected = { projections: { asOfSeq: throughSeq, values }, availability }
  } catch (_error) {
    // Native access errors, even typed ones, may include private diagnostics; never forward them.
    invalid()
  }
  if (jsonByteLength(projected) > PROTOCOL_LIMITS.maxPageBytes) {
    throw new FederationContractError(FAILURE_CODES.PAGE_TOO_LARGE, 'native metrics projection exceeds its byte budget')
  }
  return freezeDeep(projected)
}

/**
 * Validate a received reviewed metrics baseline without accepting raw registry values.
 * @param {object} baseline - JSON-only selected wire views, never a native checkpoint.
 * @param {number} throughSeq - exact history delivery cut.
 * @returns {Readonly<object>} detached baseline containing only the four reviewed numeric views.
 */
export function parseMetricsProjection(baseline, throughSeq) {
  try {
    exact(baseline, ['asOfSeq', 'values'])
    exact(baseline.values, [], Object.keys(UNIT_GRANTS))
  } catch (_error) { invalid() }
  return projectNativeMetrics({ baseline, throughSeq, exportClasses: [...new Set(Object.values(UNIT_GRANTS))] }).projections
}
