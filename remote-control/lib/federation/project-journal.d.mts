/** Durable, pair-specific project operation identities and native ownership; no session admission is implied. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { CommittedProjectOwnership, FederationPrincipal, ProjectGrantTemplate } from './grants.mjs'

export type RegisteredProjectId = Branded<'FederationRegisteredProjectId'>
export interface ProjectAuthority { readonly generation: number; readonly grantRevision: number }
export interface ProjectRegistrationBody { readonly path: string }
export interface ProjectRegistrationRequest {
  readonly requestId: string
  readonly body: ProjectRegistrationBody
  readonly authority: ProjectAuthority
}
export interface ProjectPreparation {
  readonly canonicalPath: string
  readonly existingWorkspaceId?: WorkspaceId
  readonly projectGrant: ProjectGrantTemplate
}
export interface NativeProjectProof {
  readonly workspaceId: WorkspaceId
  readonly canonicalPath: string
  readonly title: string
}
export interface ProjectReceipt {
  readonly ref: { readonly machineKey: string; readonly projectId: RegisteredProjectId }
  readonly title: string
}
export type ProjectOperationState = 'intent' | 'dispatched' | 'unknown' | 'committed' | 'failed'
export type ProjectFailureCode = 'not-granted' | 'grant-changed' | 'action-unsupported' | 'source-unavailable' | 'page-too-large' | 'invalid-message' | 'request-conflict'
export interface ProjectOperation extends ProjectRegistrationRequest {
  readonly digest: string
  readonly state: ProjectOperationState
  readonly canonicalPath?: string
  readonly existingWorkspaceId?: WorkspaceId
  readonly projectGrant?: ProjectGrantTemplate
  readonly reservedProjectId?: RegisteredProjectId
  readonly reuse?: boolean
  readonly nativeProof?: NativeProjectProof
  readonly result?: ProjectReceipt
  readonly errorCode?: ProjectFailureCode
}
export type PublicProjectState = Readonly<{ state: 'absent' } | {
  state: ProjectOperationState; requestId: string; digest: string; authority: ProjectAuthority;
  result?: ProjectReceipt; errorCode?: ProjectFailureCode;
}>
export interface ProjectEnrollment extends NativeProjectProof {
  readonly projectId: RegisteredProjectId
  readonly principal: FederationPrincipal
  readonly machineKey: string
  readonly registerRequestId: string
  readonly projectGrant: ProjectGrantTemplate
  readonly bindingDigest: string
}
export interface ProjectJournalPair {
  readonly role: 'worker' | 'controller'
  readonly id: string
  readonly peerId: string
  readonly machineKey: string
  readonly pairingGeneration: number
  readonly keyFingerprint: string
  readonly stateDir: string
}
export interface ProjectJournal {
  snapshot(): Readonly<{ version: 1; binding: Omit<ProjectJournalPair, 'stateDir'>; operations: Readonly<Record<string, ProjectOperation>>; projects: Readonly<Record<string, ProjectEnrollment>> }>
  row(requestId: string): ProjectOperation | undefined
  state(requestId: string): PublicProjectState
  reserve(request: ProjectRegistrationRequest, preparation?: ProjectPreparation): Promise<ProjectOperation>
  markDispatched(requestId: string): Promise<ProjectOperation>
  markUnknown(requestId: string): Promise<ProjectOperation>
  failBeforeDispatch(requestId: string, code: ProjectFailureCode): Promise<ProjectOperation>
  recordNativeProof(requestId: string, proof: NativeProjectProof): Promise<ProjectOperation>
  commitWorker(requestId: string): Promise<ProjectOperation>
  commitController(requestId: string, receipt: ProjectReceipt): Promise<ProjectOperation>
  ownedProjects(): readonly CommittedProjectOwnership[]
  nativeBindings(): readonly (NativeProjectProof & { readonly projectId: RegisteredProjectId })[]
  close(): Promise<void>
}
/** @param pair Validated immutable pairing and exclusive state directory. @returns The new versioned project ledger; existing session-operation files are untouched. */
export declare function openProjectJournal(pair: ProjectJournalPair): Promise<ProjectJournal>
