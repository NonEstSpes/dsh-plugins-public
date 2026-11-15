/** Fixed security bounds for disposable derived-live delivery; never a mutation channel. */
export const LIVE_CHANNEL = 'dsh-federation-live-v1'
export const LIVE_CHANNEL_LIMITS = Object.freeze({
  maxFrameBytes: 32 * 1024,
  maxPlaintextBytes: 59 * 1024,
  maxCiphertextBytes: 80 * 1024,
  maxHttpBytes: 100 * 1024,
  maxPending: 256,
  maxBufferBytes: 256 * 1024,
  maxReplayRecords: 8192,
  maxLifetimeMs: 15_000,
  clockSkewMs: 5_000,
  maxPollItems: 16,
  minEmptyPollMs: 250, // At most four idle requests per second, including a nonblocking relay.
})
export const liveRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const liveId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.exec(value)?.[0] === value
export const liveKeys = (value, keys) => liveRecord(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export const liveCiphertext = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= LIVE_CHANNEL_LIMITS.maxCiphertextBytes
  && /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(value)?.[0] === value
