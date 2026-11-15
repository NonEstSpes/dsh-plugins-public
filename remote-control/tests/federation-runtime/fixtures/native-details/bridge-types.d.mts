/** Data-only local transport between the native Host graph and the Client proof. */
export type SourceCallMethod = 'listMachines' | 'catalog' | 'bind' | 'bindDetails' | 'historyPage' | 'status'
  | 'modelCatalog' | 'modelState' | 'modelSelect' | 'getCreateState' | 'create' | 'prompt' | 'cancel'
export type SourceStreamMethod = 'observeMachines' | 'historyFollow'
export type SourceFailureCode = 'session-source/source-unavailable' | 'session-source/action-unsupported' | 'session-source/grant-changed'
export type NativeDetailsWireResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: { readonly code: SourceFailureCode; readonly message: string } }

/** Only serialized replies, frames and cancellation cross this fixture seam. */
export interface NativeDetailsBridge {
  readonly machineJson: string
  readonly refJson: string
  readonly baselineJson: string
  readonly cut: number
  call(method: SourceCallMethod, argsJson: string, signal: AbortSignal): Promise<string>
  stream(method: SourceStreamMethod, argsJson: string, signal: AbortSignal): AsyncIterable<string>
  /** Withdraw the actual Worker grant and observe its new authenticated authority on the Controller. */
  revoke(): Promise<void>
}

/** Assertions remain in their owning Client realm; the Host receives JSON-only evidence. */
export interface NativeDetailsClientProofResult {
  readonly legacyFormat: 'legacy'
  readonly projectedValuesJson: string
  readonly projectedCut: number
  readonly sourceRefBeforeJson: string
  readonly sourceRefAfterRevokeJson: string
  readonly sourceRefAfterDisposeJson: string
  readonly clearedProjectionKeys: readonly string[]
}
