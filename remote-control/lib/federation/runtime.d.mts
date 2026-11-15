/** Instance-owned authenticated federation transport, authority, and operation lifecycle. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RelaySocketStatus } from '../relay-socket.mjs'
import type { Awaitable, FederationJson } from './grants.mjs'
import type { FederationCreateState, FederationJournal, RemoteAuthority } from './journal.mjs'
import type { NativeAdapter, NativeMutationReadiness } from './native-adapter.mjs'
import type { FederationPair, FederationSettings } from './settings.mjs'
import type { LiveStreamChannel, LiveStreams, LiveStreamSpec } from './live-stream.mjs'
import type { ProjectAuthority, ProjectJournal } from './project-journal.mjs'
import type { ProjectRegistrar } from './project-registration.mjs'
import type { FileTransfers } from './file-transfer.mjs'
import type { FederationProjectRef } from './grants.mjs'

export type FederationOperationName =
  | 'hello' | 'catalog' | 'session.bind' | 'session.bind.details' | 'session.bind.live' | 'session.read.details' | 'session.follow.details'
  | 'session.create' | 'session.prompt' | 'session.cancel' | 'model.state' | 'session.read' | 'session.follow'
  | 'session.status' | 'model.catalog' | 'model.catalog.page' | 'model.select' | 'project.registration.state' | 'project.register'
  | 'files.upload.start' | 'files.upload.chunk' | 'files.upload.finish' | 'files.upload.cancel' | 'files.read' | 'files.attachment' | 'files.image'
export type FederationChangeReason = 'authority' | 'catalog'
/** Read-only Workers may omit mutation/details/catalog helpers; each unsupported operation refuses. */
export type FederationBackend = Pick<NativeAdapter, 'read' | 'validateNativeEvents'> & Partial<Omit<NativeAdapter, 'read' | 'validateNativeEvents'>>
export interface FederationEnvelope {
  readonly version: 1
  readonly id: string
  readonly from: string
  readonly to: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly kind: 'federation'
  readonly body: Readonly<Record<string, FederationJson>>
}
export interface EndpointDiagnostic {
  readonly code: string; readonly at: string; readonly httpStatus?: number; readonly route?: 'send' | 'poll' | 'ack'
}
export interface FederationEndpointStatus {
  readonly role: 'controller' | 'worker'; readonly id: string; readonly peerId: string; readonly relayOrigin: string
  readonly connection: 'stopped' | 'retrying' | 'connected' | 'connecting'
  readonly lastSuccessfulPollAt: string | null
  readonly lastPollError: EndpointDiagnostic | null
  readonly running: boolean; readonly closed: boolean; readonly failed: boolean
  readonly lastError: EndpointDiagnostic | null
  readonly outbox?: Readonly<{ pending: number; sent: number; expired: number }>
  readonly inbox?: Readonly<{ pending: number; done: number; quarantined: number }>
  readonly pendingAcks?: number
  readonly quarantineCount?: number
  readonly transport?: RelaySocketStatus
}
export interface FederationEndpoint {
  send(kind: 'federation', body: unknown, options?: { readonly id?: string; readonly expiresAt?: string }): Promise<{ readonly id: string }>
  start(): void
  close(): Promise<void>
  status(): FederationEndpointStatus
}
export interface FederationEndpointOptions {
  readonly onMessage: (envelope: FederationEnvelope) => Awaitable<void>
  readonly onError: (error: unknown) => void
}
export interface FederationPendingRequest {
  readonly op: FederationOperationName
  resolve(value: unknown): void
  reject(error: unknown): void
}
export interface FederationPeer {
  readonly pair: FederationPair
  readonly journal: FederationJournal
  readonly endpoint: FederationEndpoint
  readonly liveChannel: LiveStreamChannel | null
  readonly liveStreams: LiveStreams | null
  readonly pending: ReadonlyMap<string, FederationPendingRequest>
  readonly listeners: ReadonlySet<(reason: FederationChangeReason) => void>
  readonly revision: number
  readonly notification: string | null
  readonly dirty: boolean
  readonly mutationsVerified: boolean
  readonly projectJournal: ProjectJournal | null
  readonly projectOpening: Promise<ProjectJournal> | null
  readonly projectRegistrar: ProjectRegistrar | null
  readonly projectRequestId: string | null
  readonly projectRegistrationSupported: boolean
  readonly fileTransfers: FileTransfers | null
  readonly projectAdmissions: ReadonlyMap<string, Readonly<{ generation: number; grantRevision: number }>>
}
export interface FederationRuntimeOptions {
  readonly backend?: FederationBackend
  readonly onError?: (code: string) => void
  readonly endpointFactory?: (pair: FederationPair, options: FederationEndpointOptions) => Awaitable<FederationEndpoint>
}
export interface FederationProjectRegistrationState {
  readonly canRegister: boolean
  readonly expected: ProjectAuthority
  readonly retained?: Readonly<{ requestId: string; path: string; expected: ProjectAuthority;
    state: 'intent' | 'dispatched' | 'unknown' | 'committed' | 'failed'; result?: FederationProjectRef }>
}
export interface FederationRuntime {
  readonly settings: FederationSettings
  readonly peers: ReadonlyMap<string, FederationPeer>
  readonly mutationReadiness: NativeMutationReadiness | undefined
  start(): void
  subscribe(machineKey: string, listener: (reason: FederationChangeReason) => void): () => boolean
  revision(machineKey: string): number
  authority(machineKey: string): (RemoteAuthority & Readonly<{ highestGrantRevision: number | null }>) | null
  mutationsReady(machineKey: string): boolean
  getCreateState(machineKey: string, ref: unknown, signal?: AbortSignal): FederationCreateState
  /** Read current Worker permission and the exact retained Controller request; never redispatches a mutation. */
  getProjectRegistrationState(machineKey: string, signal?: AbortSignal): Promise<FederationProjectRegistrationState>
  /** @returns whether this instance owns a currently running, supported derived-live carrier. */
  liveReady(machineKey: string): boolean
  /** @param machineKey paired Controller machine. @param signal caller lifetime, independent of another caller's shared probe. @returns explicit relay support without changing binding modes. */
  prepareLive(machineKey: string, signal: AbortSignal): Promise<boolean>
  /** @param machineKey paired machine. @param ref captured source identity. @param request explicit live request. @param expectedAuthority captured native numeric authority. @param signal caller lifetime. @returns authenticated live values requiring the operation-specific JSON reader; credit does not acknowledge durable publication. */
  followLive(machineKey: string, ref: LiveStreamSpec['ref'], request: LiveStreamSpec['request'], expectedAuthority: LiveStreamSpec['authority'], signal: AbortSignal): AsyncIterable<unknown>
  /** The authenticated response value still needs its operation-specific JSON reader. */
  call(machineKey: string, operation: FederationOperationName, args: unknown, signal?: AbortSignal, requestId?: string): Promise<unknown>
  committed(sessionId: string): Promise<void>
  restoreAgent(agent: Agent): Promise<void>
  disposeAgent(agent: Agent): void
  close(): Promise<void>
}
/** @param settings Validated explicit v2 settings. @param options Native Worker methods or an owned endpoint factory. @returns All pair journals/endpoints opened, but not started; close joins owned work. */
export declare function openFederationRuntime(settings: FederationSettings, options?: FederationRuntimeOptions): Promise<FederationRuntime>
