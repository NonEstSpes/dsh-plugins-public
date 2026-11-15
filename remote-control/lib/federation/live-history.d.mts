/** Worker-only live projection; native owners retain all compaction and content-assembly algorithms. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, TimedStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SourceHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types'

/** One fresh public native AssistantStreamAccumulator, or an exact owner-owned facade over it. */
export interface NativeLiveCompactor {
  push(member: TimedStreamChunk): void
  snapshot(): readonly AssistantStreamRecord[]
}
export interface LiveHistoryProjectorOptions {
  readonly exportClasses: readonly string[]
  /** Actual native validating expansion; called only for an authorized reconnect prefix. */
  readonly nativeExpand: (stream: readonly AssistantStreamRecord[]) => readonly TimedStreamChunk[]
  /** Actual native assembly, including its interrupted/first-close/truncation decisions. */
  readonly nativeAssistantBlocks: (stream: readonly AssistantStreamRecord[], interrupted: boolean) => readonly ContentBlock[]
  /** Returns distinct instance-owned compactors; the projector never implements their algorithm. */
  readonly nativeCreateCompactor: () => NativeLiveCompactor
  /** Must wrap the baseline in its complete actual outgoing transport envelope, not a byte estimate. */
  readonly wrapBaseline: (baseline: SessionAssistantStreamBaseline) => unknown
  /** Must wrap the frame in its complete actual outgoing transport envelope, not a byte estimate. */
  readonly wrapFrame: (frame: SessionAssistantStreamFrame) => unknown
}
/** Exact native settlement identity plus the actual already-delivered policy-filtered carrier. */
export interface LiveHistorySettlement {
  readonly eventType: 'assistant/message' | 'assistant/attempt'
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly record: SourceHistoryRecord
}
export interface LiveHistoryProjector {
  /**
   * Adopt one native follow cut. Export revision starts at zero; active nextIndex counts only projected chunks.
   * @param baseline - complete owner-native baseline; denied Assistant payloads are never read.
   * @returns a detached frozen reconnect baseline, bounded with its complete wrapper.
   */
  open(baseline: SessionAssistantStreamBaseline): SessionAssistantStreamBaseline
  /**
   * Validate original native revision/index before filtering. Committed ends require a matching delivered carrier.
   * @param frame - next unchanged owner-native frame.
   * @param settlement - required for an authorized committed end; withheld coverage abandons transient presentation.
   * @returns zero or one frozen frame, with dense exported index/revision; never advances durable history.
   */
  accept(frame: SessionAssistantStreamFrame, settlement?: LiveHistorySettlement): readonly SessionAssistantStreamFrame[]
  /** Retire every owned reference; future input fails with a static source-unavailable error. */
  close(): void
}
/**
 * Create one synchronous projector per physical follow and immutable authority decision.
 * Native expansion/assembly/snapshots run only at opening/terminal cuts, not every live chunk.
 * Mapping items and conservative cumulative retained safe-record bytes use the fixed protocol limits.
 * Unknown content, mismatched settlement, original native gaps and oversized complete wrappers retire the instance.
 * @param options - exact native owner functions and complete actual envelope wrappers.
 * @returns an isolated projector; exceptions contain no native payload or private diagnostics.
 */
export declare function createLiveHistoryProjector(options: LiveHistoryProjectorOptions): LiveHistoryProjector
