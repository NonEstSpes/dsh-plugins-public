/** Host-owned provider over one authenticated Controller runtime and registration-scoped wire codec. */
import type { SessionSourceProvider } from '@deepseek-ai/dsh-api-session-source-controller/types'
import type { FederationRuntime } from './runtime.mjs'
import type { FederationPair } from './settings.mjs'

export interface HostProviderOptions {
  readonly runtime: FederationRuntime
  readonly pair: Pick<FederationPair, 'machineKey' | 'label'>
  readonly RemoteError?: typeof import('@deepseek-ai/dsh-typert-protocol').RemoteError
}
export type HostSourceProvider = SessionSourceProvider & {
  readonly details: NonNullable<SessionSourceProvider['details']>
  readonly live: NonNullable<SessionSourceProvider['live']>
  readonly getCreateState: NonNullable<SessionSourceProvider['getCreateState']>
  readonly projectRegistration: NonNullable<SessionSourceProvider['projectRegistration']>
  readonly files: NonNullable<SessionSourceProvider['files']>
}
/** @param options Paired Controller runtime and the serving Host's RemoteError constructor. @returns The complete maintained Source provider; legacy and negotiated details stay per binding. */
export declare function createHostProvider(options: HostProviderOptions): Promise<HostSourceProvider>
