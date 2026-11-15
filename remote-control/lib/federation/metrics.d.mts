/** Reviewed numeric wire views copied at one exact native history cut. */
export interface SessionStatsView {
  readonly turns: number; readonly steps: number; readonly llmMs: number; readonly toolMs: number
  readonly ttftMs: number; readonly ttftSteps: number; readonly decodeMs: number; readonly decodeTokens: number
}
export interface TokenUsageView {
  readonly uncachedInputTokens: number; readonly outputTokens: number
  readonly cacheReadTokens: number; readonly cacheWriteTokens: number
}
export interface ContextPressureView {
  readonly pressureTokens?: number; readonly projectedTokens?: number; readonly contextWindow?: number
}
export interface ContextBreakdownView {
  readonly systemTokens: number; readonly toolsTokens: number; readonly messageTokens: number
}
export interface ReviewedMetricsValues {
  readonly sessionStats?: SessionStatsView
  readonly tokenUsage?: TokenUsageView
  readonly contextPressure?: ContextPressureView
  readonly contextBreakdown?: ContextBreakdownView
}
export interface ReviewedMetricsBaseline { readonly asOfSeq: number; readonly values: ReviewedMetricsValues }
export type MetricsUnit = keyof ReviewedMetricsValues
export type MetricsAvailability = Readonly<Record<MetricsUnit, 'available' | 'denied' | 'unsupported'>>
export interface ProjectNativeMetricsRequest {
  readonly baseline?: unknown
  readonly throughSeq: number
  readonly exportClasses: readonly string[]
}
export interface ProjectedNativeMetrics {
  readonly projections: ReviewedMetricsBaseline
  readonly availability: MetricsAvailability
}
/** @param request Exact cut, raw native wire views and explicit grant classes. @returns Frozen reviewed finite nonnegative values and per-unit availability; absent stays unknown. */
export declare function projectNativeMetrics(request: ProjectNativeMetricsRequest): ProjectedNativeMetrics
/** @param baseline Untrusted selected numeric views. @param throughSeq Exact delivered cut. @returns A detached reviewed baseline, or throws a static refusal. */
export declare function parseMetricsProjection(baseline: unknown, throughSeq: number): ReviewedMetricsBaseline
