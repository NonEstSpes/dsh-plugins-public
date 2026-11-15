/** Grant-filtered native history with numeric federation authority and opaque delivery cursors. */
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CommittedProjectOwnership, CommittedSessionOwnership, ExportClass, FederationPrincipal, FederationSessionRef, ReviewedExportClass } from './grants.mjs'
import type { NativeAssistantBlockAssembler } from './native-adapter.mjs'
import type { ReviewedMetricsBaseline } from './metrics.mjs'

export type NativeHistoryFormat = 'legacy' | 'native-details-v1'
export declare const HISTORY_REVIEWED_CLASSES: readonly ReviewedExportClass[]
export type ProjectedEvent = Readonly<
  | { withheld: true; seq: number; class: ExportClass }
  | { withheld: false; event: SessionWireEvent; redacted?: true }
>
export interface EventProjectionOptions {
  readonly exportClasses: readonly string[]
  readonly nativeAssistantBlocks?: NativeAssistantBlockAssembler
  readonly format?: NativeHistoryFormat
  readonly toolName?: string
  /** Worker-owned private image capability; absent on file-only SDKs, never taken from a wire request. */
  readonly nativeImages?: true
}
export type FederationHistoryRecord<Event = SessionWireEvent> = Readonly<
  | { type: 'event'; event: Event; redacted?: true }
  | { type: 'withheld'; firstSeq: number; lastSeq: number; reason: 'policy' }
>
export interface FederationHistoryPage<Event = SessionWireEvent> {
  readonly generation: number
  readonly grantRevision: number
  readonly exportCursor: string
  readonly throughSeq: number
  readonly coveredFromSeq: number | null
  readonly coveredThroughSeq: number | null
  readonly records: readonly FederationHistoryRecord<Event>[]
  readonly hasMore: boolean
}
export interface HistoryPageRequest extends FederationSessionRef, EventProjectionOptions {
  readonly generation: number
  readonly grantRevision: number
  readonly principal: FederationPrincipal
  readonly grant: unknown
  readonly now: number
  readonly events: readonly unknown[]
  readonly validateNativeEvents: (events: readonly unknown[]) => void
  readonly remoteOwnedSessions?: readonly CommittedSessionOwnership[]
  readonly remoteOwnedProjects?: readonly CommittedProjectOwnership[]
  readonly throughSeq?: number
  readonly beforeSeq?: number
  readonly fromSeq?: number
  readonly maxMessages?: number
  readonly maxBytes?: number
}
export interface ExpectedHistoryAuthority extends FederationSessionRef {
  readonly generation: number
  readonly grantRevision: number
}
/** Page parsing validates coverage, not native event payload recognition. */
export interface CoveredEvent { readonly seq: number }
export interface FederationSnapshotHeader {
  readonly version: number; readonly id: string; readonly createdAt: number; readonly isSeeded: boolean
}
export interface FederationHistorySnapshot<Event = CoveredEvent> {
  readonly type: 'snapshot'
  readonly page: FederationHistoryPage<Event>
  readonly header: FederationSnapshotHeader
  readonly projections: ReviewedMetricsBaseline
}
export interface FederationHistoryRecords<Record = FederationHistoryRecord> {
  readonly type: 'records'
  readonly generation: number
  readonly grantRevision: number
  readonly exportCursor: string
  readonly records: readonly Record[]
  readonly projections?: ReviewedMetricsBaseline
}
/** @param eventType Native event name. @returns Its fixed export class, including unknown. */
export declare function classOf(eventType: string): ExportClass
/** @param event Already native-validated event. @param options Worker-owned grants, format and native assembler. @returns A withheld decision or a frozen reviewed wire event. */
export declare function projectEvent(event: unknown, options: EventProjectionOptions): ProjectedEvent
/** @param request Worker-owned authority, native validator, events and byte/item limits. @returns A bounded contiguous policy-filtered history page. */
export declare function buildHistoryPage(request: HistoryPageRequest): FederationHistoryPage
/** @param value Untrusted history page. @param expected Optional exact cursor authority. @returns Frozen carriers with validated coverage; consumers still validate event payloads. */
export declare function parseHistoryPage(value: unknown, expected?: ExpectedHistoryAuthority): FederationHistoryPage<CoveredEvent>
/** @param value Untrusted snapshot parts. @returns A same-cut snapshot with reviewed metrics and validated coverage. */
export declare function createHistorySnapshotFrame(value: { readonly page: unknown; readonly header: unknown; readonly projections: unknown }): FederationHistorySnapshot
/** @param value Already grant-checked carriers plus their pinned authority. @returns A frozen frame; supplied metrics are validated against its details cursor. */
export declare function createHistoryRecordsFrame<Record>(value: {
  readonly generation: number; readonly grantRevision: number; readonly exportCursor: string
  readonly records: readonly Record[]; readonly projections?: unknown
}): FederationHistoryRecords<Record>
