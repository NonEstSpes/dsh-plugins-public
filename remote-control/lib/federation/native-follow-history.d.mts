/** One native follow cut projected into Root numeric-authority source frames; SDK assembly remains owner-owned. */
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FederationSessionRef } from './grants.mjs'
import type { FederationHistoryRecord, FederationHistoryRecords, FederationHistorySnapshot, HistoryPageRequest } from './history.mjs'
import type { NativeAdapter } from './native-adapter.mjs'

/** Runtime-owned current authority, never copied from incoming transport arguments. */
export type NativeFollowHistoryContext = Pick<HistoryPageRequest,
  'generation' | 'grantRevision' | 'principal' | 'grant' | 'now' | 'remoteOwnedSessions' | 'remoteOwnedProjects' | 'exportClasses' | 'nativeImages'>
/** Native objects remain Worker-local; only these reviewed numeric-authority frames leave the mapper. */
export type NativeFollowHistoryFrame =
  | (FederationHistorySnapshot<SessionWireEvent> & { readonly assistantStream: SessionAssistantStreamBaseline })
  | FederationHistoryRecords<FederationHistoryRecord<SessionWireEvent>>
  | { readonly type: 'assistant-stream'; readonly generation: number; readonly grantRevision: number; readonly frame: SessionAssistantStreamFrame }
/** All live callbacks must be supplied by the exact current native Worker owner. */
export type NativeFollowHistoryBackend = Required<Pick<NativeAdapter,
  'readDetails' | 'validateNativeEvents' | 'nativeExpand' | 'nativeCreateCompactor' | 'nativeLiveAssistantBlocks'>>
export interface NativeFollowHistoryOptions {
  readonly frames: AsyncIterable<SessionFollowFrame>
  readonly ref: FederationSessionRef
  readonly backend: NativeFollowHistoryBackend
  readonly historyContext: () => NativeFollowHistoryContext
  /** Rechecks the physical owner, immutable ref, grant, and visibility generation. */
  readonly check: () => void
  readonly signal: AbortSignal
  /** Complete actual outgoing source/transport envelope, including current transport index. */
  readonly wrapFrame: (frame: NativeFollowHistoryFrame) => unknown
}
/**
 * Project one physical native iterator without activating an Agent or mirroring its journal.
 * The first frame preserves the native opening cut; readDetails supplies only older durable context.
 * Later context reads occur only for durable events. Future numeric metrics are omitted, never retagged.
 * Native settlement coverage is emitted before the corresponding Assistant terminal.
 * @param options - native producer, current Runtime authority, exact owner callbacks and full-envelope wrapper.
 * @returns one consumer-owned iterable; overlapping next is refused and cancellation/return join native iterator work.
 */
export declare function projectNativeFollow(options: NativeFollowHistoryOptions): AsyncIterable<NativeFollowHistoryFrame>
