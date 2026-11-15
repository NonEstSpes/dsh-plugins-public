/**
 * Browser-safe domain-version ↔ native-source token adapter.
 * Tokens scope equality to one source registration; they confer no permission and
 * do not replace authenticated Worker revision/cursor checks. Instantiate once per
 * registration/authority incarnation and keep the instance across its reconnects.
 */
import { FederationContractError, parseMachineKey } from './identity.mjs'

const PREFIX = Object.freeze({ generation: 'feg1.', grantRevision: 'fgr1.' })
const LIMIT = 1024
const SCOPES = /^[A-Za-z0-9_-]{1,128}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const fail = message => { throw new FederationContractError('wire-codec/invalid', message) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const nativeNumber = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)

function encodeText(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function decodeText(body) {
  const base = body.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base + '='.repeat((4 - base.length % 4) % 4))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, value => value.charCodeAt(0)))
}

/** Mint a fresh source-registration namespace, never a grant or authority revision.
 * @returns {string} fresh random registration scope.
 */
export function createWireScope() {
  return globalThis.crypto.randomUUID()
}

/**
 * Bind the real codec to one current registration. Explicit scope is useful for a
 * retained registration and deterministic committed fixtures; production owners
 * MUST mint a fresh scope for each new registration/authority incarnation.
 * @param {{machineKey:string,scope?:string}} options - exact source and current scope.
 * @returns {Readonly<object>} scoped encode/decode and artifact mapper methods.
 */
export function createWireCodec(options) {
  if (!record(options) || Object.keys(options).some(key => !['machineKey', 'scope'].includes(key))) fail('invalid codec options')
  const machineKey = parseMachineKey(options.machineKey)
  const scope = options.scope === undefined ? createWireScope() : options.scope
  if (typeof scope !== 'string' || !SCOPES.test(scope)) fail('invalid registration scope')

  const encode = (kind, value) => {
    if (!Object.hasOwn(PREFIX, kind) || !nativeNumber(value)) fail('version must be a nonnegative safe integer without coercion')
    return PREFIX[kind] + encodeText(JSON.stringify([machineKey, scope, value]))
  }
  const decode = (kind, token) => {
    if (!Object.hasOwn(PREFIX, kind) || typeof token !== 'string' || token.length > LIMIT || !token.startsWith(PREFIX[kind])) fail('invalid version token')
    const body = token.slice(PREFIX[kind].length)
    if (!BASE64URL.test(body)) fail('invalid version token encoding')
    let text
    try { text = decodeText(body) } catch (error) { fail('invalid version token encoding') }
    if (encodeText(text) !== body) fail('noncanonical version token encoding')
    let tuple
    try { tuple = JSON.parse(text) } catch (error) { fail('invalid version token JSON') }
    if (!Array.isArray(tuple) || tuple.length !== 3 || JSON.stringify(tuple) !== text
      || tuple[0] !== machineKey || tuple[1] !== scope || !nativeNumber(tuple[2])) fail('version token belongs to another source/scope or is noncanonical')
    return tuple[2]
  }

  const map = (kind, value, direction) => {
    if (!record(value)) fail('artifact must be an object')
    const version = (name, n) => direction === 'to-wire' ? encode(name, n) : decode(name, n)
    const checkRef = ref => { if (!record(ref) || ref.machineKey !== machineKey) fail('artifact names another machine') }
    const fields = (input, required) => {
      const result = { ...input }
      for (const name of ['generation', 'grantRevision']) {
        if (required.includes(name) && !Object.hasOwn(input, name)) fail('artifact is missing its version')
        if (Object.hasOwn(input, name)) result[name] = version(name, input[name])
      }
      return result
    }
    switch (kind) {
      case 'project-registration-request': {
        if (Object.keys(value).some(key => !['requestId', 'path', 'expected'].includes(key)) || typeof value.requestId !== 'string'
          || !/^[A-Za-z0-9_-]{8,80}$/.test(value.requestId) || typeof value.path !== 'string' || !value.path || value.path.includes('\0')
          || new TextEncoder().encode(value.path).byteLength > 8192 || !record(value.expected)
          || Object.keys(value.expected).length !== 2) fail('invalid project registration request')
        return Object.freeze({ requestId: value.requestId, path: value.path, expected: Object.freeze(fields(value.expected, ['generation', 'grantRevision'])) })
      }
      case 'project-registration-state': {
        if (typeof value.canRegister !== 'boolean' || !record(value.expected)) fail('invalid project registration state')
        const retained = value.retained
        if (retained !== undefined && (!record(retained) || !record(retained.expected))) fail('invalid retained project request')
        if (retained?.result !== undefined) checkRef(retained.result)
        return Object.freeze({ canRegister: value.canRegister, expected: Object.freeze(fields(value.expected, ['generation', 'grantRevision'])),
          ...(retained === undefined ? {} : { retained: Object.freeze({ ...retained, expected: Object.freeze(fields(retained.expected, ['generation', 'grantRevision'])) }) }) })
      }
      case 'binding': {
        checkRef(value.ref)
        return Object.freeze(fields(value, ['grantRevision']))
      }
      case 'catalog': {
        if (!Array.isArray(value.projects) || !Array.isArray(value.sessions)) fail('invalid catalog rows')
        for (const row of [...value.projects, ...value.sessions]) checkRef(row.ref)
        return Object.freeze(fields(value, ['generation', 'grantRevision']))
      }
      case 'history-page':
        return Object.freeze(fields(value, ['generation', 'grantRevision']))
      case 'history-frame': {
        if (value.type === 'snapshot') return Object.freeze({ ...value, page: map('history-page', value.page, direction) })
        if (value.type !== 'records') fail('live assistant frames are not supported')
        return Object.freeze(fields(value, ['generation', 'grantRevision']))
      }
      case 'live-history-frame': {
        if (value.type === 'snapshot') return Object.freeze({ ...value, page: map('history-page', value.page, direction) })
        if (!['records', 'assistant-stream'].includes(value.type)) fail('invalid live history frame')
        return Object.freeze(fields(value, ['generation', 'grantRevision']))
      }
      case 'model-stamp':
      case 'model-ack':
        return Object.freeze(fields(value, ['generation']))
      default:
        fail('unknown source artifact kind')
    }
  }
  return Object.freeze({
    machineKey, scope,
    encodeGeneration: n => encode('generation', n),
    decodeGeneration: token => decode('generation', token),
    encodeGrantRevision: n => encode('grantRevision', n),
    decodeGrantRevision: token => decode('grantRevision', token),
    toWire: (kind, value) => map(kind, value, 'to-wire'),
    fromWire: (kind, value) => map(kind, value, 'from-wire'),
  })
}
