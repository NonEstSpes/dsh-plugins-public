/** Explicit version-two settings after credential, workspace, and canonical-directory validation. */
import type { Awaitable, FederationGrant } from './grants.mjs'
import type { FederationJournalPair } from './journal.mjs'

export interface FederationPair extends FederationJournalPair {
  readonly protocol: 2
  readonly relayUrl: string
  readonly relayToken: string
  readonly sharedKey: string
  readonly allowLoopback?: boolean
  readonly label?: string
  readonly requestTimeoutMs?: number
  /** Omission resolves to legacy HTTPS; auto requires both explicit deadlines. */
  readonly relayTransport?: 'https' | 'auto'
  readonly relaySocketConnectTimeoutMs?: number
  readonly grant: FederationGrant | null
}
export interface FederationProject {
  readonly workspaceId: string
  readonly title?: string
  readonly root: string
}
export interface FederationSettingsBase {
  readonly version: 2
  readonly id: string
  readonly label: string
  readonly projects: Readonly<Record<string, FederationProject>>
  readonly pairs: readonly FederationPair[]
  readonly settingsFile: string
}
export type FederationSettings = FederationSettingsBase & Readonly<
  | { role: 'controller'; machineKey?: never }
  | { role: 'worker'; machineKey: string }
>
export interface ParseSettingsV2Options {
  /** Required when project entries exist; only a real native workspace path is accepted. */
  readonly resolveWorkspace?: (workspaceId: string) => Awaitable<{ readonly path: string } | null | undefined>
}
/** @param target Absolute state directory. @returns Its canonical path, including a not-yet-created suffix; no directories are created. */
export declare function canonicalStateDirectory(target: string): Promise<string>
/** @param value Untrusted explicit version-two settings JSON. @param filename Absolute settings filename. @param options Native workspace lookup. @returns Frozen validated settings; credentials remain private. */
export declare function parseSettingsV2(value: unknown, filename: string, options?: ParseSettingsV2Options): Promise<FederationSettings>
