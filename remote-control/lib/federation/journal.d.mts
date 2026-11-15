/** Durable pair authority, exact-operation replay, and creation/first-step evidence. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Awaitable, CommittedSessionOwnership, FederationGrant, FederationJson, FederationProjectRef, FederationSessionRef } from './grants.mjs'

export interface FederationPairBinding {
  readonly role: 'controller' | 'worker'
  readonly id: string
  readonly peerId: string
  readonly machineKey: string
  readonly pairingGeneration: number
  readonly keyFingerprint: string
}
export interface FederationJournalPair extends FederationPairBinding { readonly stateDir: string }
export interface FederationModelState { readonly frontierSeq: number; readonly selection: ModelSelection | null }
export interface FederationModelStamp extends FederationModelState { readonly generation: number }
export interface NativeCreationProof {
  readonly sessionId: string
  readonly createdAt: number
  readonly initialSelection: ModelSelection | null
  readonly frontierSeq: number
}
export type MutationAction = 'session.create' | 'session.prompt' | 'session.cancel' | 'model.select'
export interface FederationOperation {
  readonly requestId: string
  readonly principal: string
  readonly machineKey: string
  readonly action: MutationAction
  readonly target: FederationProjectRef | FederationSessionRef
  readonly body: unknown
  readonly guard?: Readonly<{ selection: ModelSelection | null }>
}
export interface FederationCreateOperation extends FederationOperation {
  readonly action: 'session.create'
  readonly target: FederationProjectRef
}
export interface NativeTransaction {
  readonly reservedSessionId: string | undefined
  readonly nativeRequestId: string
  dispatch(): Promise<void>
  /** Valid only on the Worker's create transaction; other calls reject. */
  recordNativeCreation(proof: NativeCreationProof): Promise<void>
}
export interface NativeCreateTransaction extends NativeTransaction { readonly reservedSessionId: string }
export interface OwnerCreateDisposition {
  readonly version: 1
  readonly kind: 'owner-abandoned-create'
  readonly bindingDigest: string
  readonly rowDigest: string
  readonly reservationDigest: string
  readonly acknowledgedAt: number
}
export interface JournalOperationRow {
  readonly requestId: string
  readonly nativeRequestId: string
  readonly principal: string
  readonly machineKey: string
  readonly action: MutationAction
  readonly target: FederationProjectRef | FederationSessionRef
  readonly digest: string
  readonly state: 'intent' | 'dispatched' | 'unknown' | 'committed' | 'failed'
  readonly reservedSessionId?: string
  readonly guard?: Readonly<{ selection: ModelSelection | null }>
  readonly guardCaptured?: boolean
  readonly nativeCreatedProof?: NativeCreationProof
  readonly ownerDisposition?: OwnerCreateDisposition
  readonly result?: FederationJson
  readonly code?: string
}
export interface RemoteAuthority {
  readonly generation: number
  readonly grantRevision: number | null
  readonly metadataAuthorized?: boolean
  readonly mutationsVerified?: boolean
}
export interface FederationJournalState {
  readonly version: 2
  readonly binding: FederationPairBinding
  readonly generation: number
  readonly lastGrantRevision: number | null
  readonly grantDigest: string | null
  readonly grant: FederationGrant | null
  readonly operations: Readonly<Record<string, JournalOperationRow>>
  readonly remoteOwnedSessions: Readonly<Record<string, CommittedSessionOwnership>>
  readonly remoteAuthority?: RemoteAuthority & Readonly<{ highestGrantRevision: number | null }>
}
export interface UnknownCreateTarget extends FederationProjectRef { readonly requestId: string }
export interface UnknownCreateAcknowledgement extends UnknownCreateTarget {
  readonly version: 1
  readonly operationKey: string
  readonly bindingDigest: string
  readonly rowDigest: string
  readonly reservationDigest: string
}
export interface PreviousUnknownCreate { readonly requestId: string; readonly disposition: 'owner-abandoned' }
export type FederationCreateState = (
  | { readonly state: 'idle' }
  | { readonly state: 'pending' | 'unknown'; readonly requestId: string }
  | { readonly state: 'committed'; readonly requestId: string; readonly ref: FederationSessionRef }
) & Readonly<{ previousUnknownCreate?: PreviousUnknownCreate }>
export interface JournalGuard {
  readonly requestId: string
  readonly nativeRequestId: string
  readonly expected: ModelSelection | null
  readonly projectId: string
}
export interface FederationJournal {
  readonly binding: FederationPairBinding
  snapshot(): FederationJournalState
  observeAuthority(authority: RemoteAuthority): Promise<boolean>
  installGrant(candidate: unknown): Promise<FederationJournalState>
  /** JSON-only results are cloned; an exact committed operation replays the original executor result. */
  execute<Result>(operation: FederationCreateOperation, executor: (transaction: NativeCreateTransaction) => Awaitable<Result>, reconcile?: () => Awaitable<Result>): Promise<Result>
  execute<Result>(operation: FederationOperation, executor: (transaction: NativeTransaction) => Awaitable<Result>, reconcile?: () => Awaitable<Result>): Promise<Result>
  getCreateState(target: FederationProjectRef): FederationCreateState
  guardsFor(sessionId: string): readonly JournalGuard[]
  confirmGuardEvidence(sessionId: string, requestId: string): Promise<FederationJournalState>
  close(): Promise<void>
}
/** @param value Untrusted JSON. @returns Canonical JSON, rejecting non-JSON, accessors and cycles. */
export declare function canonicalJson(value: unknown): string
/** @param state Existing journal state. @param target One exact unknown create. @returns Its immutable-identity CAS plan, or throws. */
export declare function planUnknownCreateAcknowledgement(state: FederationJournalState, target: UnknownCreateTarget): UnknownCreateAcknowledgement
/** @param filename Existing journal. @param expected Exact read-only plan. @param acknowledgedAt Owner time or undefined for current time. @param checkOffline Explicit offline lifecycle check. @returns After exclusive CAS persistence. */
export declare function acknowledgeUnknownCreate(filename: string, expected: UnknownCreateAcknowledgement, acknowledgedAt: number | undefined, checkOffline: () => Awaitable<void>): Promise<void>
/** @param pair Exact trusted pair and owned storage directory. @returns An exclusive journal after conservative crash recovery. */
export declare function openFederationJournal(pair: FederationJournalPair): Promise<FederationJournal>
