/** JSON-only test transport between canonical native Host ownership and the separate Client realm. */
export type SourceCallMethod = 'listMachines' | 'catalog' | 'bind' | 'bindDetails' | 'bindLive' | 'historyPage' | 'status'
  | 'modelCatalog' | 'modelState' | 'modelSelect' | 'getCreateState' | 'create' | 'prompt' | 'cancel'
export type SourceStreamMethod = 'observeMachines' | 'historyFollow'
export type SourceFailureCode = 'session-source/source-unavailable' | 'session-source/action-unsupported' | 'session-source/grant-changed'
export type NativeLiveWireResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: { readonly code: SourceFailureCode; readonly message: string } }
export interface NativeLiveFinal {
  readonly cut: number
  readonly projections: { readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
  readonly settlementSeq: number
}
/** Only serialized observations, explicit external-provider gates and cancellation cross this fixture seam. */
export interface NativeLiveBridge {
  readonly machineJson: string
  readonly refJson: string
  readonly baselineJson: string
  readonly cut: number
  readonly parts: readonly string[]
  /** Record only safe authority counters and machine-registration identities for fixture diagnostics. */
  trace(phase: string, observationJson: string): void
  call(method: SourceCallMethod, argsJson: string, signal: AbortSignal): Promise<string>
  stream(method: SourceStreamMethod, argsJson: string, signal: AbortSignal): AsyncIterable<string>
  startPrompt(): Promise<void>
  releasePart(index: number): Promise<void>
  finish(): Promise<string>
  /** Hold one real native rename carrier at the local JSON transport seam before issuer withdrawal. */
  holdForWithdrawal(): Promise<void>
  /** Withdraw the real Worker journal grant and refresh authenticated Controller authority. */
  revoke(): Promise<void>
}
export interface NativeLiveClientProofResult {
  readonly bindingLive: true
  readonly transientTexts: readonly string[]
  readonly settledText: string
  readonly openingCut: number
  readonly finalCut: number
  readonly settlementSeq: number
  readonly projectedValuesJson: string
  readonly sourceRefBeforeJson: string
  readonly sourceRefAfterRevokeJson: string
  readonly sourceRefAfterDisposeJson: string
  readonly clearedProjectionKeys: readonly string[]
}
