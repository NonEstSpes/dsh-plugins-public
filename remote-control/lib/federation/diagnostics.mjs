/** Static source diagnostics: preserve operation locks without exporting remote error payloads. */

const STAGES = new Set([
  'hello', 'catalog', 'project.registration.state', 'project.register', 'session.bind', 'session.create', 'session.prompt', 'session.cancel',
  'model.state', 'session.read', 'session.follow', 'session.status', 'model.catalog',
  'model.catalog.page', 'model.select',
  'files.upload.start', 'files.upload.chunk', 'files.upload.finish', 'files.upload.cancel', 'files.read', 'files.attachment', 'files.image',
  'session.bind.details', 'session.read.details', 'session.follow.details', 'session.bind.live', 'session.follow.live',
])

const UNKNOWN = {
  endpointCode: 'session/outcome-unknown', reason: 'outcome-unknown',
  text: 'Reconcile the same request ID; do not submit a replacement.',
}
const SELECTION = {
  endpointCode: 'session/selection-conflict', reason: 'selection-conflict',
  text: 'Refresh the Worker model state before selecting again.',
}
const UNSUPPORTED = {
  endpointCode: 'session-source/action-unsupported', reason: 'action-unsupported',
  text: 'This operation is not supported by the remote source.',
}
const GRANT = {
  endpointCode: 'session-source/grant-changed', reason: 'grant-changed',
  text: 'The source authority changed; refresh the binding.',
}
const UNAVAILABLE = {
  endpointCode: 'session-source/source-unavailable', reason: 'source-unavailable',
  text: 'The remote source is unavailable.',
}
const CANCELLED = {
  endpointCode: 'session-source/source-unavailable', reason: 'cancelled',
  text: 'The request was cancelled.',
}

const DIAGNOSTICS = new Map([
  ['outcome-unknown', UNKNOWN],
  ['session/outcome-unknown', UNKNOWN],
  ['selection-conflict', SELECTION],
  ['session/selection-conflict', SELECTION],
  ['action-unsupported', UNSUPPORTED],
  ['session-source/action-unsupported', UNSUPPORTED],
  ['grant-changed', GRANT],
  ['session-source/grant-changed', GRANT],
  ['source-unavailable', UNAVAILABLE],
  ['session-source/source-unavailable', UNAVAILABLE],
  ['request-timeout', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'request-timeout',
    text: 'The remote read request exceeded its deadline.',
  }],
  ['not-granted', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'not-granted',
    text: 'The paired Controller is not authorized for this operation.',
  }],
  ['page-too-large', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'page-too-large',
    text: 'The response exceeds the permitted transfer size.',
  }],
  ['invalid-message', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'invalid-message',
    text: 'The source message does not match the supported protocol.',
  }],
  ['pairing-mismatch', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'pairing-mismatch',
    text: 'The message does not match the authenticated device pair.',
  }],
  ['cursor-stale', {
    endpointCode: GRANT.endpointCode, reason: 'cursor-stale',
    text: 'The page cursor is stale; refresh the source view.',
  }],
  ['catalog-stale', {
    endpointCode: GRANT.endpointCode, reason: 'catalog-stale',
    text: 'The source catalog changed; reload the catalog.',
  }],
  ['history-gap', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'history-gap',
    text: 'The source history is incomplete; reload its snapshot.',
  }],
  ['export-policy-unsupported', {
    endpointCode: UNAVAILABLE.endpointCode, reason: 'export-policy-unsupported',
    text: 'The source export policy is not supported.',
  }],
])

function stringField(error, field) {
  if (error === null || typeof error !== 'object') return undefined
  try {
    const value = error[field]
    return typeof value === 'string' ? value : undefined
  } catch (_error) {
    // An unreadable discriminator never authorizes exporting other error fields.
    return undefined
  }
}

/**
 * Describe a source failure using only exact allowlisted operation and error codes.
 * Unknown-outcome and selection-conflict codes take precedence over AbortError, preserving their locks.
 * `request-timeout` describes a Controller read deadline; mutation deadlines remain `outcome-unknown`.
 * No message, details, cause, arbitrary name, path, or credential is copied. Static output is under 200 UTF-8 bytes.
 * @param {unknown} error - local or remote failure; only its code and cancellation name are inspected.
 * @param {unknown} stage - a known federation operation, otherwise the static label `remote`.
 * @returns {{endpointCode: string, message: string}} existing Source BFF error class and bounded diagnostic.
 */
export function sourceDiagnostic(error, stage) {
  const operation = typeof stage === 'string' && STAGES.has(stage) ? stage : 'remote'
  const known = DIAGNOSTICS.get(stringField(error, 'code'))
  const diagnostic = known === UNKNOWN || known === SELECTION
    ? known
    : stringField(error, 'name') === 'AbortError' ? CANCELLED : known ?? UNAVAILABLE
  return {
    endpointCode: diagnostic.endpointCode,
    message: `${operation}: ${diagnostic.reason}. ${diagnostic.text}`,
  }
}
