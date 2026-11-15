/** Worker-native reads and explicitly prepared mutations; SDK owners remain Host-only. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog, ModelSelection, SessionFollowFrame, SessionFollowRequest, SourceFileStartRequest, SourceFileReadRequest, SourcePromptUpload, SourceUploadValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { NativeLiveCompactor } from './live-history.mjs'
import type { Awaitable, FederationProjectRef, FederationSessionRef } from './grants.mjs'
import type { FederationModelState, NativeCreationProof } from './journal.mjs'

export interface NativeHelperOwner {
  ownsSourceMutationHelpers?(value: unknown): boolean
  ownsSourceCatalogHelper?(value: unknown): boolean
  ownsSourceFollowHelper?(value: unknown): boolean
  ownsSourceProjectHelpers?(value: unknown): boolean
  ownsSourceFilesHelper?(value: unknown): boolean
  readonly SessionController?: typeof SessionController
  readonly default?: typeof SessionController
}
export interface NativeModules {
  readonly llm?: typeof import('@deepseek-ai/dsh-llm')
  readonly session?: typeof import('@deepseek-ai/dsh-session')
  readonly sandbox?: typeof import('@deepseek-ai/dsh-sandbox-policy')
  readonly cordis?: Pick<typeof import('@deepseek-ai/cordis'), 'symbols'>
  readonly controllerOwner?: NativeHelperOwner
}
export interface NativeAdapterSettings {
  readonly projects: Readonly<Record<string, Readonly<{ workspaceId: string }>>>
}
export interface NativeAdapterOptions {
  readonly ctx: Context
  readonly settings: NativeAdapterSettings
  readonly native?: NativeModules
  /** Explicit local provider deadline, integer 1..60000; never a wire field. */
  readonly modelCatalogProviderTimeoutMs?: number
}
export interface NativeReadSnapshot {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly running: boolean
}
export interface NativeProjectionBaseline {
  readonly asOfSeq: number
  /** Native wire views, not checkpoint/fold state; the exporter selects reviewed numeric keys. */
  readonly values: Readonly<Record<string, unknown>>
}
export interface NativeDetailsSnapshot extends NativeReadSnapshot {
  readonly cursor: number
  readonly projections: NativeProjectionBaseline | undefined
}
export interface NativeMutationReadiness {
  readonly durableJournal: 'verified'
  readonly firstRouteCapture: 'verified'
}
export interface NativeMutationRecovery {
  check(): void
  restore(agent: Agent): Awaitable<void>
}
export interface NativeCreationRecovery {
  check(): void
  created(proof: NativeCreationProof): Awaitable<void>
}
export interface NativePromptRequest {
  readonly requestId: string
  readonly uploads?: readonly SourcePromptUpload[]
  readonly text: string
  readonly expected: FederationModelState
}
export interface NativeModelSelectRequest {
  readonly requestId: string
  readonly selection: ModelSelection
  readonly expected: FederationModelState
}
export type NativeAssistantStream = Parameters<typeof import('@deepseek-ai/dsh-llm').assembleAssistantStream>[0]
export type NativeAssistantBlocks = ReturnType<ReturnType<typeof import('@deepseek-ai/dsh-llm').assembleAssistantStream>['blocks']>
export type NativeAssistantBlockAssembler = (stream: NativeAssistantStream, interrupted: boolean) => NativeAssistantBlocks
/** Existing native page policy only; the producer supplies fixed protocol retention limits. */
export type NativeFollowRequest = Pick<SessionFollowRequest, 'maxMessages' | 'turnWindow'>
export interface NativeSourceFiles {
  /** Present only when independently captured native image upload and verified-read methods exist. */
  imagesAvailable?(): boolean
  image?(ref: Pick<FederationSessionRef, 'sessionId'>, image: ImageAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array>
  canUpload(ref: Pick<FederationSessionRef, 'sessionId'>): boolean
  upload(ref: Pick<FederationSessionRef, 'sessionId'>, request: SourceFileStartRequest, data: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<SourceUploadValue>
  read(ref: Pick<FederationSessionRef, 'sessionId'>, request: SourceFileReadRequest & { readonly offset: number; readonly length: number }, signal: AbortSignal, checkPath: (canonicalPath: string) => void): ReturnType<SessionController['sourceFiles']['read']>
  attachment(ref: Pick<FederationSessionRef, 'sessionId'>, file: FileAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array>
}
export interface NativeAdapter {
  /** Independent exact Worker file owner; missing services and older SDKs omit this face. */
  readonly files?: NativeSourceFiles
  /** Optional creation-time exact Worker project owner; finite calls recheck identity and join Adapter.close(). */
  readonly prepareProject?: SessionController['sourcePrepareProject']
  readonly registerProject?: SessionController['sourceRegisterProject']
  /** Replace this machine's private committed native bindings; explicit configured project IDs always win. */
  setProjectBindings(machineKey: string, entries: ReturnType<import('./project-journal.mjs').ProjectJournal['nativeBindings']>): void
  /** Present only at creation with the exact same-SDK Worker follow owner; one outstanding next per iterator. */
  readonly followNative?: (ref: Pick<FederationSessionRef, 'sessionId'>, request: NativeFollowRequest, signal: AbortSignal) => AsyncIterable<SessionFollowFrame>
  /** Verified live-only native callbacks; each call and each created compactor method rechecks owner identity. */
  readonly nativeExpand?: typeof import('@deepseek-ai/dsh-llm').expandAssistantStream
  readonly nativeCreateCompactor?: () => NativeLiveCompactor
  readonly nativeLiveAssistantBlocks?: NativeAssistantBlockAssembler
  readonly mutationReadiness: NativeMutationReadiness | undefined
  validateNativeEvents(events: readonly unknown[]): void
  nativeAssistantBlocks: NativeAssistantBlockAssembler
  read(ref: Pick<FederationSessionRef, 'sessionId'>, signal?: AbortSignal): Promise<NativeReadSnapshot>
  readDetails(ref: Pick<FederationSessionRef, 'sessionId'>, signal?: AbortSignal): Promise<NativeDetailsSnapshot>
  modelCatalog(signal?: AbortSignal): Promise<ModelCatalog>
  modelState(ref: Pick<FederationSessionRef, 'sessionId'>, signal?: AbortSignal): Promise<FederationModelState>
  hasPromptEvidence(agent: { readonly session: Pick<Session, 'seq' | 'eventAt'> }, requestId: string, expected: ModelSelection | null): boolean
  restoreGuard(agent: Agent, requestId: string, expected: ModelSelection | null, check?: () => void): void
  create(request: { readonly ref: FederationProjectRef; readonly reservedSessionId: string }, dispatch: () => Awaitable<void>, signal: AbortSignal | undefined, recovery: NativeCreationRecovery): Promise<FederationSessionRef>
  modelSelect(ref: FederationSessionRef, request: NativeModelSelectRequest, dispatch: () => Awaitable<void>, signal: AbortSignal | undefined, recovery: NativeMutationRecovery): Promise<FederationModelState>
  prompt(ref: FederationSessionRef, request: NativePromptRequest, dispatch: () => Awaitable<void>, signal: AbortSignal | undefined, recovery: NativeMutationRecovery): Promise<Awaited<ReturnType<SessionController['guardedSourcePrompt']>>>
  cancel(ref: FederationSessionRef, request: { readonly requestId: string }, dispatch: () => Awaitable<void>, signal?: AbortSignal): Promise<Awaited<ReturnType<SessionController['cancel']>>>
  disposeAgent(agent: Agent): void
  /** Retires guard ownership, aborts every live reader and finite project call before waiting, then joins both groups; legacy adapters without either face return void. */
  close(): void | Promise<void>
}
/** @param options Serving native Host, explicit workspaces and optional verified owner/deadline. @returns One instance-owned adapter; missing helper identity stays read-only. */
export declare function createNativeAdapter(options: NativeAdapterOptions): Promise<NativeAdapter>
