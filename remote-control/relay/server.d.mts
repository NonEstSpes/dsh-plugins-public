/** Opaque-ciphertext HTTP relay with owned durable storage and joined shutdown. */
import type { Server } from 'node:http'

export interface RelayDevice {
  readonly id: string
  readonly peerId: string
  readonly tokenHash: string
}
export interface RelayOptions {
  readonly directory: string
  readonly devices: readonly RelayDevice[]
  readonly pollMs?: number
  readonly maxPending?: number
}
export interface Relay {
  readonly server: Server
  /** Ends held polls, destroys owned sockets, drains storage and releases the exclusive claim. */
  close(): Promise<void>
}
/** @param options Dedicated storage, pinned reciprocal devices and optional poll/queue limits. @returns An unbound HTTP server and idempotent joined disposer; invalid settings fail before serving. */
export declare function createRelay(options: RelayOptions): Relay
