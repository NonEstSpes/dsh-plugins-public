/** Validated federation JSON and explicit grant decisions; no native object crosses this wire. */
export type FederationJson = null | boolean | number | string | readonly FederationJson[] | { readonly [key: string]: FederationJson }
export type Awaitable<Value> = Value | PromiseLike<Value>
export interface FederationProjectRef { readonly machineKey: string; readonly projectId: string }
export interface FederationSessionRef extends FederationProjectRef { readonly sessionId: string }
export interface FederationPrincipal { readonly kind: 'controller'; readonly id: string }
export declare const FEDERATION_GRANTS_VERSION: 1
export declare const PROJECT_REGISTRATION_GRANTS_VERSION: 2
export declare const MACHINE_ACTIONS: readonly ['project.register']
export type MachineAction = typeof MACHINE_ACTIONS[number]
export declare const PROJECT_ACTIONS: readonly ['project.list', 'session.list', 'session.create', 'model.list']
export declare const SESSION_ACTIONS: readonly ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select']
export type ProjectAction = typeof PROJECT_ACTIONS[number]
export type SessionAction = typeof SESSION_ACTIONS[number]
export type GrantAction = MachineAction | ProjectAction | SessionAction
export declare const GRANT_ACTIONS: readonly GrantAction[]
export declare const ACTION_SCOPES: Readonly<Record<MachineAction, 'machine'> & Record<ProjectAction, 'project'> & Record<SessionAction, 'session'>>
export declare const EXPORT_CLASSES: readonly [
  'conversation.user', 'conversation.assistant', 'conversation.system', 'conversation.developer',
  'tool.call', 'tool.result', 'reasoning', 'files', 'turn', 'model.selection', 'todo', 'goal', 'title',
  'statistics', 'context.metrics', 'usage', 'command', 'unknown',
]
export declare const REVIEWED_EXPORT_CLASSES: readonly [
  'conversation.user', 'conversation.assistant', 'tool.call', 'tool.result', 'turn', 'model.selection',
  'title', 'statistics', 'context.metrics', 'usage', 'files',
]
export type ExportClass = typeof EXPORT_CLASSES[number]
export type ReviewedExportClass = typeof REVIEWED_EXPORT_CLASSES[number]
export declare const PENDING_EXPORT_CLASSES: readonly Exclude<ExportClass, ReviewedExportClass>[]
export declare const EXPORT_CLASS_SERIALIZER: Readonly<Record<ReviewedExportClass, 'reviewed'> & Record<Exclude<ExportClass, ReviewedExportClass>, 'pending'>>
export declare const GRANT_CODES: Readonly<{
  INVALID: 'grant/invalid'; INVALID_REQUEST: 'grant/invalid-request'; INVALID_OPTIONS: 'grant/invalid-options';
  FORBIDDEN_FIELD: 'grant/forbidden-field'; INVALID_PRINCIPAL: 'grant/invalid-principal'; INVALID_MACHINE: 'grant/invalid-machine';
  INVALID_REVISION: 'grant/invalid-revision'; INVALID_TIMESTAMP: 'grant/invalid-timestamp'; INVALID_PROJECT: 'grant/invalid-project';
  INVALID_SESSION: 'grant/invalid-session'; UNKNOWN_ACTION: 'grant/unknown-action'; ACTION_SCOPE_MISMATCH: 'grant/action-scope-mismatch';
  UNKNOWN_EXPORT_CLASS: 'grant/unknown-export-class'; DUPLICATE_PROJECT: 'grant/duplicate-project'; DUPLICATE_SESSION: 'grant/duplicate-session';
  DUPLICATE_ACTION: 'grant/duplicate-action'; DUPLICATE_EXPORT_CLASS: 'grant/duplicate-export-class';
  EXPORT_CLASS_SUBSET_VIOLATION: 'grant/export-class-subset-violation'; STALE_REVISION: 'grant/stale-revision';
  EXPIRED: 'grant/expired'; REVOKED: 'grant/revoked'; PRINCIPAL_MISMATCH: 'grant/principal-mismatch'; MACHINE_MISMATCH: 'grant/machine-mismatch';
  PROJECT_NOT_GRANTED: 'grant/project-not-granted'; SESSION_NOT_GRANTED: 'grant/session-not-granted'; ACTION_NOT_GRANTED: 'grant/action-not-granted';
  EXPORT_CLASS_REQUIRED: 'grant/export-class-required'; EXPORT_CLASS_NOT_GRANTED: 'grant/export-class-not-granted';
  EXPORT_CLASS_UNEXPECTED: 'grant/export-class-unexpected'; EXPORT_CLASS_SERIALIZER_PENDING: 'grant/export-class-serializer-pending';
  PATH_ADOPTION_NOT_ALLOWED: 'grant/path-adoption-not-allowed'; REVISION_NOT_ADVANCED: 'grant/revision-not-advanced';
}>
export type GrantCode = typeof GRANT_CODES[keyof typeof GRANT_CODES]
export interface CreatedSessionGrant { readonly actions: readonly SessionAction[]; readonly exportClasses: readonly ExportClass[] }
export interface GrantSession {
  readonly sessionId: string
  readonly imported: boolean
  readonly actions: readonly SessionAction[]
  /** The parser retains this member with undefined when the project maximum applies. */
  readonly exportClasses: readonly ExportClass[] | undefined
}
export interface ProjectGrantTemplate {
  readonly actions: readonly ProjectAction[]
  readonly exportClasses: readonly ExportClass[]
  readonly createdSessionGrant?: CreatedSessionGrant
}
export interface ProjectRegistrationGrant { readonly actions: readonly ['project.register']; readonly projectGrant: ProjectGrantTemplate }
export interface GrantProject extends ProjectGrantTemplate {
  readonly projectId: string
  readonly sessions: readonly GrantSession[]
}
interface FederationGrantFields {
  readonly grantId: string
  readonly principal: FederationPrincipal
  readonly machineKey: string
  readonly revision: number
  readonly issuedAt: number
  readonly expiresAt?: number
  readonly revokedAt?: number
  readonly projects: readonly GrantProject[]
}
export interface FederationGrantV1 extends FederationGrantFields { readonly version: 1 }
export interface FederationGrantV2 extends FederationGrantFields { readonly version: 2; readonly projectRegistration?: ProjectRegistrationGrant }
export type FederationGrant = FederationGrantV1 | FederationGrantV2
/** Verified committed policy view from the private Worker journal; no native workspace/path data. */
export interface CommittedProjectOwnership extends FederationProjectRef {
  readonly state: 'committed'
  readonly principal: FederationPrincipal
  readonly registerRequestId: string
  readonly projectGrant: ProjectGrantTemplate
}
export interface CommittedSessionOwnership extends FederationSessionRef {
  readonly principal: FederationPrincipal
  readonly createRequestId: string
  readonly state: 'committed'
}
export interface GrantEvaluationOptions {
  readonly currentRevision: number
  readonly now: number
  readonly remoteOwnedSessions?: readonly CommittedSessionOwnership[]
  readonly remoteOwnedProjects?: readonly CommittedProjectOwnership[]
}
export type GrantStatus = Readonly<{ status: 'active' } | { status: 'stale' | 'expired' | 'revoked'; code: GrantCode }>
export type GrantDecision = Readonly<
  | { allowed: false; code: GrantCode; detail?: Readonly<{ status?: 'stale' | 'expired' | 'revoked'; action?: GrantAction; exportClass?: ExportClass }> }
  | { allowed: true; action: MachineAction; projectGrant: ProjectGrantTemplate }
  | { allowed: true; action: ProjectAction; projectId: string; exportClasses: readonly [] }
  | { allowed: true; action: SessionAction; projectId: string; sessionId: string; imported: boolean; exportClasses: readonly ExportClass[] }
>
/** @param value Untrusted project permission template. @returns A frozen copy without native identifiers, sessions or paths. */
export declare function parseProjectGrantTemplate(value: unknown): ProjectGrantTemplate
/** @param value Untrusted JSON grant. @returns A frozen, fully validated grant. */
export declare function parseGrant(value: unknown): FederationGrant
/** @param grant Raw or validated grant. @param options Current authority and clock. @returns Its current lifecycle status. */
export declare function grantStatus(grant: unknown, options: GrantEvaluationOptions): GrantStatus
/** @param grant Raw or validated grant. @param options Current authority and clock. @returns The active grant, or throws a typed refusal. */
export declare function requireActiveGrant(grant: unknown, options: GrantEvaluationOptions): FederationGrant
/** @param next Proposed revision or grant. @param currentRevision Current revision. @returns A strictly newer revision. */
export declare function assertRevisionAdvance(next: number | Pick<FederationGrant, 'revision'>, currentRevision: number): number
/** @param grant Grant JSON. @param options Current authority and verified committed ownership. @returns Explicit projects plus captured/current template intersections; derived entries contain no sessions. */
export declare function effectiveProjectEntries(grant: unknown, options: GrantEvaluationOptions): readonly GrantProject[]
/** @param grant Grant JSON. @param projectId Exact project. @param options Current authority and committed ownership. @returns Explicit and ownership-derived entries. */
export declare function effectiveSessionEntries(grant: unknown, projectId: string, options: GrantEvaluationOptions): readonly GrantSession[]
/** @param grant Grant JSON. @param ref Exact native tuple. @param options Current authority and committed ownership. @returns Whether import/creation evidence admits the session. */
export declare function sessionAdmissionAllowed(grant: unknown, ref: Pick<FederationSessionRef, 'projectId' | 'sessionId'>, options: GrantEvaluationOptions): boolean
/** @param grant Grant JSON. @param request Untrusted exact action request. @param options Current authority and clock. @returns A frozen allow/deny decision. */
export declare function evaluateGrant(grant: unknown, request: unknown, options: GrantEvaluationOptions): GrantDecision
/** @param grant Grant JSON. @param request Untrusted action request. @param options Current authority and clock. @returns Whether evaluation allows the request. */
export declare function grantAllows(grant: unknown, request: unknown, options: GrantEvaluationOptions): boolean
/** @param grant Grant JSON. @param ref Exact grant entry. @param options Optional current authority and verified ownership for derived entries. @returns Project maximum or session narrowing. */
export declare function effectiveExportClasses(grant: unknown, ref: { readonly projectId: string; readonly sessionId?: string }, options?: GrantEvaluationOptions): readonly ExportClass[]
/** @param exportClass Untrusted class name. @returns Its fixed serializer status, or throws. */
export declare function exportClassSerializerStatus(exportClass: unknown): 'reviewed' | 'pending'
/** @param exportClass Untrusted class name. @returns A reviewed class, or throws. */
export declare function requireReviewedExportClass(exportClass: unknown): ReviewedExportClass
/** @param classes Requested class names. @returns A frozen, nonempty, duplicate-free reviewed list. */
export declare function assertReviewedExportClasses(classes: readonly string[]): readonly ReviewedExportClass[]
