/** Worker-private registration orchestration; verified native helpers and their lifecycle remain caller-owned. */
import type { CommittedProjectOwnership, CommittedSessionOwnership, FederationPrincipal } from './grants.mjs'
import type { NativeProjectProof, ProjectAuthority, ProjectJournal, ProjectPreparation, ProjectReceipt, ProjectRegistrationRequest, PublicProjectState } from './project-journal.mjs'
export interface ProjectRegistrationContext extends ProjectAuthority {
  readonly principal: FederationPrincipal
  readonly machineKey: string
  readonly grant: unknown
  readonly now: number
  readonly remoteOwnedSessions?: readonly CommittedSessionOwnership[]
  readonly remoteOwnedProjects?: readonly CommittedProjectOwnership[]
}
export interface ProjectRegistrationNative {
  prepare(request: Readonly<{ path: string }>, signal: AbortSignal): Promise<Omit<ProjectPreparation, 'projectGrant'>>
  register(request: Readonly<{ canonicalPath: string }>, signal: AbortSignal): Promise<NativeProjectProof>
}
export interface ProjectRegistrarOptions {
  readonly journal: ProjectJournal
  readonly context: () => ProjectRegistrationContext
  /** Creation-time verified owner closures, not arbitrary SDK Services or dispatch methods. */
  readonly native: ProjectRegistrationNative
  /** Enforce the Worker's private-state exclusions on the actual native canonical target. */
  readonly checkCanonicalPath: (canonicalPath: string) => void
  /** Synchronous, owner-bounded catalog invalidation; failure never overwrites a committed result. */
  readonly onCommitted?: () => void
}
export interface ProjectRegistrar {
  /** @param request Immutable body and original authority. @param signal Caller cancellation, whose reason is never forwarded. @returns An authorized path-free committed receipt; uncertain native outcomes throw a static error. */
  register(request: ProjectRegistrationRequest, signal: AbortSignal): Promise<ProjectReceipt>
  /** @param requestId Retained original operation. @param signal Caller lifetime. @returns Current authorized public state; recovery never dispatches native registration. */
  reconcile(requestId: string, signal: AbortSignal): Promise<PublicProjectState>
}
/** @param options Private journal, current Worker authority and exact native owner callbacks. @returns No timers or borrowed-service ownership; every operation joins its own native and journal awaits. */
export declare function createProjectRegistrar(options: ProjectRegistrarOptions): ProjectRegistrar
