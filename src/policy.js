/**
 * Trigger policy: fixed-threshold and adaptive (predictive) modes.
 *
 * The adaptive model predicts how many tokens the main agent will still consume
 * before a background summary can land, and starts the pre-compaction early
 * enough that the summary finishes before the native compaction threshold:
 *
 *   G        = V * T * K + S              (predicted growth during compression)
 *   U_trigger = C * R - G                  (predicted trigger position)
 *   P_trigger = U_trigger / C * 100%
 *
 * All functions here are pure: they take measurements and config, and return a
 * decision with the full derivation for logging.
 * @module dsh-async-compaction/policy
 */

import { clamp, round } from './util.js'
import {
  BURST_GROWTH_FACTOR,
  COMPRESSION_TIME_MULTIPLIER,
  DEFAULT_COMPRESSION_SECONDS,
  DEFAULT_GROWTH_TOKENS_PER_SECOND,
  SAFETY_MARGIN_TOKENS,
} from './internal-policy.js'

/**
 * Recent token-growth tracker: pairwise rates over a bounded window, an EMA of
 * those rates, and the window peak used as burst protection.
 * @param {{ windowMs: number, alpha: number }} options
 */
export function createGrowthTracker({ windowMs, alpha }) {
  /** @type {Array<{ t: number, tokens: number }>} */
  let samples = []
  let ema = null
  let lastRate = 0

  /** @param {number} now @param {number} tokens */
  function addSample(now, tokens) {
    const previous = samples.at(-1)
    samples.push({ t: now, tokens })
    if (samples.length > 512) samples = samples.slice(-256)
    if (previous !== undefined) {
      const dt = now - previous.t
      if (dt >= 500) {
        const rate = ((tokens - previous.tokens) / dt) * 1000
        lastRate = rate
        ema = ema === null ? rate : alpha * rate + (1 - alpha) * ema
      }
    }
    prune(now)
  }

  /** @param {number} now */
  function prune(now) {
    if (windowMs <= 0) return
    const floor = now - Math.max(windowMs, 1000)
    let cut = 0
    while (cut < samples.length && samples[cut].t < floor) cut += 1
    if (cut > 0) samples = samples.slice(cut)
  }

  /** @param {number} now */
  function read(now) {
    prune(now)
    let peak = -Infinity
    for (let i = 1; i < samples.length; i += 1) {
      const dt = samples[i].t - samples[i - 1].t
      if (dt < 500) continue
      const rate = ((samples[i].tokens - samples[i - 1].tokens) / dt) * 1000
      if (rate > peak) peak = rate
    }
    const known = samples.length >= 2 && ema !== null
    const peakRate = Number.isFinite(peak) ? Math.max(peak, 0) : 0
    return {
      known,
      sampleCount: samples.length,
      ema: ema ?? 0,
      peak: peakRate,
      /** Conservative growth used for prediction: burst peak wins over the smoothed rate. */
      rate: Math.max(ema ?? 0, peakRate),
      lastRate,
      windowMs,
    }
  }

  function reset() {
    samples = []
    ema = null
    lastRate = 0
  }

  return { addSample, read, reset }
}

/**
 * Background-compression duration tracker (one observation per finished task).
 * @param {{ alpha: number }} options
 */
export function createDurationTracker({ alpha }) {
  let ema = null
  let count = 0

  /** @param {number} seconds */
  function add(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    count += 1
    ema = count === 1 ? seconds : alpha * seconds + (1 - alpha) * ema
  }

  /** @param {number} defaultSeconds @param {number} multiplier */
  function predict(defaultSeconds, multiplier) {
    const base = count > 0 && ema !== null ? ema : defaultSeconds
    return {
      seconds: base * multiplier,
      baseSeconds: base,
      source: count > 0 ? 'history' : 'default',
      observations: count,
      multiplier,
    }
  }

  return { add, predict, get observations() { return count } }
}

/**
 * Evaluate the pre-compaction trigger for one measurement.
 *
 * @param {object} input
 * @param {Record<string, any>} input.config
 * @param {{ known: boolean, contextWindow?: number, thresholdTokens?: number, thresholdRatio?: number, retainTokens?: number, source?: string }} input.native
 * @param {number} input.totalTokens - `ctx.tokenMeter.measure(session).totalTokens`
 * @param {ReturnType<typeof createGrowthTracker>['read'] extends (now: number) => infer R ? R : never} [input.growth]
 * @param {ReturnType<typeof createDurationTracker>['predict'] extends (a: number, b: number) => infer R ? R : never} [input.duration]
 * @param {boolean} [input.fresh] - whether the measurement is fresh enough to predict from
 * @returns {{
 *   due: boolean,
 *   reason: string,
 *   mode: string,
 *   contextWindow: number | null,
 *   triggerTokens: number | null,
 *   triggerRatio: number | null,
 *   dataComplete: boolean,
 *   derivation: Record<string, any>,
 * }}
 */
export function evaluateTrigger(input) {
  const { config, native, totalTokens } = input
  const mode = config.triggerMode
  const fresh = input.fresh !== false
  const contextWindow = Number.isFinite(native?.contextWindow) && native.contextWindow > 0 ? native.contextWindow : null
  const base = {
    mode,
    contextWindow,
    triggerTokens: null,
    triggerRatio: null,
    dataComplete: false,
    derivation: {},
  }

  if (contextWindow === null) {
    return { ...base, due: false, reason: 'no-capacity' }
  }

  if (mode === 'fixed') {
    const requestedTokens = Math.round(contextWindow * config.fixedThreshold)
    const nativeThresholdTokens =
      Number.isFinite(native?.thresholdTokens) && native.thresholdTokens > 0 ? native.thresholdTokens : null
    let triggerTokens = requestedTokens
    const clamps = []
    // A fixed threshold above the native one could never start the summary
    // before the native mechanism fires. Keep the user's intent but pull the
    // trigger below the native threshold so pre-compaction remains meaningful.
    if (
      config.autoAdjustFixedThreshold !== false &&
      nativeThresholdTokens !== null &&
      requestedTokens >= nativeThresholdTokens
    ) {
      const gap = Math.max(4096, Math.round(nativeThresholdTokens * 0.02))
      triggerTokens = Math.max(Math.round(nativeThresholdTokens) - gap, Math.round(contextWindow * 0.05))
      clamps.push('fixed-adjusted-below-native')
    }
    return {
      ...base,
      due: totalTokens >= triggerTokens,
      reason: totalTokens >= triggerTokens ? (clamps.length > 0 ? 'fixed-adjusted-trigger' : 'fixed-threshold') : 'below-threshold',
      triggerTokens,
      triggerRatio: round(triggerTokens / contextWindow, 4),
      dataComplete: true,
      derivation: {
        requestedTriggerTokens: requestedTokens,
        triggerTokens,
        fixedThreshold: config.fixedThreshold,
        nativeThresholdTokens,
        nativeThresholdRatio: nativeThresholdTokens === null ? null : round(nativeThresholdTokens / contextWindow, 4),
        clamps,
      },
    }
  }

  // Adaptive mode ---------------------------------------------------------
  const growth = input.growth ?? { known: false, sampleCount: 0, ema: 0, peak: 0, rate: 0 }
  const duration = input.duration ?? {
    seconds: DEFAULT_COMPRESSION_SECONDS * COMPRESSION_TIME_MULTIPLIER,
    baseSeconds: DEFAULT_COMPRESSION_SECONDS,
    source: 'default',
    observations: 0,
    multiplier: COMPRESSION_TIME_MULTIPLIER,
  }
  const growthComplete = growth.known && growth.sampleCount >= 2
  const durationComplete = duration.observations > 0
  const nativeComplete = native?.source !== 'defaults' && native?.known === true
  const dataComplete = fresh && growthComplete && durationComplete && nativeComplete

  const growthRate = growthComplete
    ? growth.peak > growth.ema * BURST_GROWTH_FACTOR
      ? growth.peak
      : growth.ema
    : DEFAULT_GROWTH_TOKENS_PER_SECOND
  const predictedDuration = duration.seconds
  const growthTokens = growthRate * predictedDuration
  const safetyTokens = SAFETY_MARGIN_TOKENS
  const predictedGrowth = growthTokens + safetyTokens
  const nativeThresholdTokens =
    Number.isFinite(native?.thresholdTokens) && native.thresholdTokens > 0
      ? native.thresholdTokens
      : Math.round(contextWindow * (Number.isFinite(native?.thresholdRatio) ? native.thresholdRatio : 0.8))

  const clamps = []
  let dataReason = dataComplete ? 'adaptive-predicted' : 'adaptive-fallback-no-data'
  const warmStartTokens =
    Number.isFinite(input.warmStart?.triggerTokens) && input.warmStart.triggerTokens > 0
      ? Math.round(input.warmStart.triggerTokens)
      : null
  let targetTokens
  if (dataComplete) {
    targetTokens = Math.round(nativeThresholdTokens - predictedGrowth)
  } else if (warmStartTokens !== null) {
    // Immediately after an apply the growth tracker is empty. Reusing the last
    // fully-predicted target keeps the adaptive threshold (e.g. 75%) instead of
    // collapsing to the fallback (65%) for the few seconds it takes to rebuild.
    targetTokens = warmStartTokens
    dataReason = 'adaptive-warm-start'
  } else {
    targetTokens = Math.round(contextWindow * config.fallbackThreshold)
  }

  const minTokens = Math.round(contextWindow * config.minThreshold)
  const maxTokens = Math.round(contextWindow * config.maxThreshold)
  if (targetTokens < minTokens) {
    targetTokens = minTokens
    clamps.push('min-threshold')
    dataReason = 'adaptive-clamped-min'
  } else if (targetTokens > maxTokens) {
    targetTokens = maxTokens
    clamps.push('max-threshold')
    dataReason = 'adaptive-clamped-max'
  }

  const due = totalTokens >= targetTokens
  return {
    ...base,
    due,
    reason: due ? dataReason : 'below-threshold',
    triggerTokens: targetTokens,
    triggerRatio: round(targetTokens / contextWindow, 4),
    dataComplete,
    derivation: {
      contextWindow,
      nativeThresholdTokens,
      nativeThresholdRatio: round(nativeThresholdTokens / contextWindow, 4),
      nativeThresholdRatioActual: round(nativeThresholdTokens / contextWindow, 4),
      nativePolicySource: native?.source ?? 'unknown',
      growthRateTokensPerSecond: round(growthRate, 2),
      growthSource: growthComplete
        ? growth.peak > growth.ema * BURST_GROWTH_FACTOR
          ? 'burst-peak'
          : 'ema'
        : 'internal-default',
      burstGrowthFactor: BURST_GROWTH_FACTOR,
      growthEma: round(growth.ema, 2),
      growthPeak: round(growth.peak, 2),
      growthSamples: growth.sampleCount,
      predictedDurationSeconds: round(predictedDuration, 2),
      durationSource: duration.source,
      durationObservations: duration.observations,
      compressionTimeMultiplier: COMPRESSION_TIME_MULTIPLIER,
      predictedGrowthTokens: Math.round(growthTokens),
      safetyMarginTokens: safetyTokens,
      predictedTotalGrowthTokens: Math.round(predictedGrowth),
      triggerTokens: targetTokens,
      minTokens,
      maxTokens,
      clamps,
      measurementFresh: fresh,
      warmStartTokens,
      warmStartRatio: Number.isFinite(input.warmStart?.triggerRatio) ? input.warmStart.triggerRatio : null,
      warmStartAt: Number.isFinite(input.warmStart?.at) ? input.warmStart.at : null,
    },
  }
}

/** Current usage as a fraction of capacity, or null. @param {number} tokens @param {number|null} contextWindow */
export function usageRatio(tokens, contextWindow) {
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
  return clamp(tokens / contextWindow, 0, 10)
}

/**
 * Whether a valid route is present. Compaction is not scoped by model here:
 * picking which routes get compacted is a policy of the installer, not of the
 * asynchronous scheduling layer.
 * @param {{ provider?: string, model?: string } | undefined} route
 */
export function routeUsable(route) {
  return typeof route?.provider === 'string' && route.provider.length > 0 && typeof route.model === 'string' && route.model.length > 0
}
