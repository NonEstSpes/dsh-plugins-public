/** Private Node relay carrier; request bodies keep the existing route and encrypted message protocols. */
export type RelaySocketRoute = 'send' | 'poll' | 'ack' | 'live/info' | 'live/send' | 'live/poll'
export interface RelaySocketSettings {
  readonly relayUrl: string
  readonly relayToken: string
  readonly allowLoopback?: boolean
  readonly relayTransport?: 'https' | 'auto'
  readonly relaySocketConnectTimeoutMs?: number
  readonly requestTimeoutMs?: number
}
export interface RelaySocketStatus {
  readonly mode: 'https' | 'auto'
  readonly connected: boolean
  readonly supported: boolean | null
  readonly backoff: boolean
  readonly closed: boolean
  readonly pending: number
  readonly requestsSent: number
  readonly framesSent: number
  readonly framesReceived: number
  readonly bytesSent: number
  readonly bytesReceived: number
}
export interface RelaySocket {
  /** Undefined permits HTTPS only before frame publication; a published failure never authorizes carrier replay. */
  request(route: RelaySocketRoute, data: Readonly<Record<string, unknown>>, signal?: AbortSignal, beforePublish?: () => void): Promise<Readonly<{ status: number; body: unknown }> | undefined>
  /** Abort and join every owned connection and request. */
  close(): Promise<void>
  /** Return counters without identifiers, addresses, headers or message contents. */
  status(): RelaySocketStatus
}
/** @param settings Validated pair connection values; auto requires explicit connection and request deadlines. @returns a local-only owner; only request opens a socket. */
export function openRelaySocket(settings: RelaySocketSettings): RelaySocket
