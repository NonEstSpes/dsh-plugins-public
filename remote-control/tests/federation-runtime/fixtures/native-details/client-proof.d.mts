/** Host-visible declaration deliberately excludes every Client SDK and Context type. */
import type { NativeDetailsBridge, NativeDetailsClientProofResult } from './bridge-types.d.mts'
export type { NativeDetailsBridge, NativeDetailsClientProofResult } from './bridge-types.d.mts'
/** Consume real SourceBFF JSON replies with the actual browser adapter and Client Session. */
export function proveClientSession(bridge: NativeDetailsBridge): Promise<NativeDetailsClientProofResult>
