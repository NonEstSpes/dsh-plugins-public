/** Disposable derived-channel credit transport; Native mapping and durable publication remain with their owners. */
import type { FederationJson } from './grants.mjs'
import type { RelaySocketStatus } from '../relay-socket.mjs'

/** Root wire JSON, not SDK-branded SourceHistoryFrame; the Runtime's full frame reader owns interpretation. */
export type LiveFrameJson = Readonly<Record<string, FederationJson>>
export interface LiveStreamSpec {
  readonly ref: Readonly<{ machineKey: string; projectId: string; sessionId: string }>
  readonly authority: Readonly<{ generation: number; grantRevision: number }>
  readonly request: Readonly<{ includeAssistantStream: true; after?: string }>
}
/** Borrowed started carrier; this manager neither creates nor closes it. */
export interface LiveStreamChannel {
  /** The carrier calls beforePublish synchronously after encryption/serialization immediately before publishing; owner failures propagate unchanged. */
  send(body: unknown, signal?: AbortSignal, beforePublish?: () => void): Promise<unknown>
  status(): Readonly<{ running: boolean; closed: boolean; supported?: boolean; lastError?: unknown; transport?: RelaySocketStatus }>
  start(): Promise<boolean>
}
export interface LiveStreamsOptions {
  readonly role: 'controller' | 'worker'
  readonly channel: LiveStreamChannel
  /** Required resolved Runtime request-timeout policy; heartbeat/lease timing is derived from it and carrier security limits. */
  readonly timeoutMs: number
  /** One Native producer per admitted Worker stream. The supplied wrapper measures the exact complete outgoing DATA body. */
  readonly open?: (spec: LiveStreamSpec, signal: AbortSignal, wrapFrame: (frame: LiveFrameJson) => unknown) => AsyncIterable<LiveFrameJson>
  /** Current known authority on Controller, actual grant on Worker; absent refuses new admissions instead of granting access. */
  readonly check?: (ref: LiveStreamSpec['ref'], authority: LiveStreamSpec['authority']) => void
}
export interface LiveStreamsStatus {
  readonly active: number
  readonly tombstones: number
  readonly retainedBytes: number
  readonly pendingReads: number
  readonly pendingSends: number
  readonly timers: number
}
export interface LiveStreams {
  /**
   * Handle one authenticated, decoded body synchronously; never awaits Native reads, sends or disposal.
   * @param body - closed OPEN/PULL/DATA/STOP/END JSON from the provided derived carrier.
   */
  receive(body: unknown): void
  /**
   * Open one Controller consumer. Credit advances only when the consumer resumes after a yield; its owned heartbeat continues while paused.
   * @param spec - exact captured reference, authority and explicit Assistant request.
   * @param signal - caller cancellation; STOP is best-effort and carries no caller reason.
   * @returns detached wire frames; network credit is never a durable cursor/publication acknowledgement.
   */
  follow(spec: LiveStreamSpec, signal: AbortSignal): AsyncIterable<LiveFrameJson>
  /** @param code - known static Federation failure code; unknown values become source-unavailable. */
  failAll(code: string): void
  /** Abort synchronously, then join every owned read, iterator return, send and timer; borrowed carrier remains open. */
  close(): Promise<void>
  /** @returns numeric resource aggregates only, without source identities or payloads. */
  status(): LiveStreamsStatus
}
/**
 * Construct one bounded Controller or Worker credit manager over an already-started derived channel.
 * @param options - explicit role, Runtime timeout policy and current-authority callbacks.
 * @returns an instance-owned manager; errors contain static codes and no private callback diagnostics.
 */
export declare function createLiveStreams(options: LiveStreamsOptions): LiveStreams
