/** Host sees serialized proof observations, never the separate Client SDK object graph. */
import type { NativeLiveBridge, NativeLiveClientProofResult } from './bridge-types.d.mts'
/** @param bridge - JSON transport and explicit native provider gates. @returns JSON-only Client observations. */
export declare function proveClientSession(bridge: NativeLiveBridge): Promise<NativeLiveClientProofResult>
