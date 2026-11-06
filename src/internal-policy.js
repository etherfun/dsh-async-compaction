/**
 * Internal tuning constants of the adaptive trigger.
 *
 * These used to be plugin config. They are deliberately not exposed any more:
 * the adaptive trigger's job is to predict *when* the backend will need to
 * compact, and every extra knob made that prediction harder to reason about
 * without changing the outcome much. The three remaining adaptive settings are
 * `minThreshold`, `maxThreshold` and `fallbackThreshold` (the clamp window and
 * the no-data fallback); everything else is a fixed, documented default.
 * @module dsh-pre-compact/internal-policy
 */

/** Safety padding added to the predicted context growth (tokens). */
export const SAFETY_MARGIN_TOKENS = 4096

/** Multiplier applied to the observed compression duration to predict the next one. */
export const COMPRESSION_TIME_MULTIPLIER = 1.3

/** Compression duration assumed before any observation exists (seconds). */
export const DEFAULT_COMPRESSION_SECONDS = 45

/** Context growth assumed before enough samples exist (tokens/second). */
export const DEFAULT_GROWTH_TOKENS_PER_SECOND = 200

/** A peak above `ema * BURST_GROWTH_FACTOR` is treated as a burst. */
export const BURST_GROWTH_FACTOR = 2

/** EMA smoothing factor for growth and duration samples. */
export const EMA_ALPHA = 0.3

/** Context growth is sampled at most this often (ms). */
export const GROWTH_SAMPLING_INTERVAL_MS = 5000

/** Sampling window used to keep growth/duration estimates current (ms). */
export const GROWTH_WINDOW_MS = 60000
