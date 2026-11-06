/**
 * Pure trigger policy, growth/duration trackers and route scoping.
 * @module test/policy.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/config.js'
import {
  BURST_GROWTH_FACTOR,
  COMPRESSION_TIME_MULTIPLIER,
  DEFAULT_COMPRESSION_SECONDS,
  DEFAULT_GROWTH_TOKENS_PER_SECOND,
  EMA_ALPHA,
  GROWTH_SAMPLING_INTERVAL_MS,
  GROWTH_WINDOW_MS,
  SAFETY_MARGIN_TOKENS,
} from '../src/internal-policy.js'
import {
  createDurationTracker,
  createGrowthTracker,
  evaluateTrigger,
  routeUsable,
  usageRatio,
} from '../src/policy.js'

/** @param {Record<string, unknown>} overrides */
function config(overrides = {}) {
  return { ...DEFAULTS, ...overrides }
}

/** @param {Record<string, unknown>} overrides */
function native(overrides = {}) {
  return {
    known: true,
    source: 'backend-config',
    contextWindow: 200_000,
    thresholdTokens: 160_000,
    thresholdRatio: 0.8,
    retainTokens: 32_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// fixed mode
// ---------------------------------------------------------------------------

test('fixed mode: trigger sits exactly on the fixed ratio of the window', () => {
  const base = {
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.7, autoAdjustFixedThreshold: false }),
    native: native({ contextWindow: 100_000, thresholdTokens: 90_000 }),
  }

  const below = evaluateTrigger({ ...base, totalTokens: 69_999 })
  assert.equal(below.due, false)
  assert.equal(below.reason, 'below-threshold')
  assert.equal(below.triggerTokens, 70_000)
  assert.equal(below.triggerRatio, 0.7)
  assert.equal(below.dataComplete, true)

  const at = evaluateTrigger({ ...base, totalTokens: 70_000 })
  assert.equal(at.due, true)
  assert.equal(at.reason, 'fixed-threshold')
  assert.equal(at.derivation.requestedTriggerTokens, 70_000)
  assert.deepEqual(at.derivation.clamps, [])
})

test('fixed mode: missing context capacity yields no-capacity without a trigger', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'fixed' }),
    native: { known: false, reason: 'no-context-capacity' },
    totalTokens: 999_999,
  })
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'no-capacity')
  assert.equal(decision.contextWindow, null)
  assert.equal(decision.triggerTokens, null)
})

test('fixed mode: auto adjustment pulls a too-high threshold below the native one', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.9 }),
    native: native({ contextWindow: 100_000, thresholdTokens: 90_000 }),
    totalTokens: 86_000,
  })
  // gap = max(4096, 2% * 90000) = 4096; 90000 - 4096 = 85904
  assert.equal(decision.triggerTokens, 85_904)
  assert.equal(decision.due, true)
  assert.equal(decision.reason, 'fixed-adjusted-trigger')
  assert.equal(decision.derivation.requestedTriggerTokens, 90_000)
  assert.equal(decision.derivation.nativeThresholdTokens, 90_000)
  assert.deepEqual(decision.derivation.clamps, ['fixed-adjusted-below-native'])
})

test('fixed mode: auto adjustment keeps the 5% window floor', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.9 }),
    native: native({ contextWindow: 100_000, thresholdTokens: 4200 }),
    totalTokens: 5000,
  })
  // 4200 - max(4096, 84) = 104, floored to 5% of the window
  assert.equal(decision.triggerTokens, 5000)
  assert.equal(decision.due, true)
  assert.equal(decision.reason, 'fixed-adjusted-trigger')
})

test('fixed mode: auto adjustment is disabled by config and by an explicit native override', () => {
  const disabled = evaluateTrigger({
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.9, autoAdjustFixedThreshold: false }),
    native: native({ contextWindow: 100_000, thresholdTokens: 90_000 }),
    totalTokens: 95_000,
  })
  assert.equal(disabled.triggerTokens, 90_000)
  assert.equal(disabled.reason, 'fixed-threshold')
  assert.deepEqual(disabled.derivation.clamps, [])

  const noNative = evaluateTrigger({
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.9 }),
    native: native({ contextWindow: 100_000, thresholdTokens: undefined, thresholdRatio: undefined }),
    totalTokens: 95_000,
  })
  assert.equal(noNative.triggerTokens, 90_000)
  assert.equal(noNative.derivation.nativeThresholdTokens, null)
})

// ---------------------------------------------------------------------------
// adaptive mode
// ---------------------------------------------------------------------------

const growthNone = { known: false, sampleCount: 0, ema: 0, peak: 0, rate: 0 }
const growthKnown = (ema, peak, samples = 3) => ({ known: true, sampleCount: samples, ema, peak, rate: Math.max(ema, peak) })
const durationKnown = (seconds, observations = 2) => ({
  seconds,
  baseSeconds: seconds / COMPRESSION_TIME_MULTIPLIER,
  source: 'history',
  observations,
  multiplier: COMPRESSION_TIME_MULTIPLIER,
})

test('adaptive mode: without data it falls back to fallbackThreshold', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'adaptive' }),
    native: native(),
    totalTokens: 129_999,
    growth: growthNone,
    duration: { seconds: 58.5, observations: 0, source: 'default' },
  })
  assert.equal(decision.due, false)
  assert.equal(decision.reason, 'below-threshold')
  assert.equal(decision.dataComplete, false)
  assert.equal(decision.triggerTokens, 130_000) // 0.65 * 200000

  const due = evaluateTrigger({
    config: config({ triggerMode: 'adaptive' }),
    native: native(),
    totalTokens: 130_000,
    growth: growthNone,
  })
  assert.equal(due.due, true)
  assert.equal(due.reason, 'adaptive-fallback-no-data')
})

test('adaptive mode: prediction internals come from fixed internal-policy constants', () => {
  // The tuning constants are no longer config: assert the documented values …
  assert.equal(SAFETY_MARGIN_TOKENS, 4096)
  assert.equal(COMPRESSION_TIME_MULTIPLIER, 1.3)
  assert.equal(DEFAULT_COMPRESSION_SECONDS, 45)
  assert.equal(DEFAULT_GROWTH_TOKENS_PER_SECOND, 200)
  assert.equal(BURST_GROWTH_FACTOR, 2)
  assert.equal(EMA_ALPHA, 0.3)
  assert.equal(GROWTH_SAMPLING_INTERVAL_MS, 5000)
  assert.equal(GROWTH_WINDOW_MS, 60000)

  // … and that the no-data derivation uses them even when the caller supplies
  // no growth/duration samples at all.
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'adaptive' }),
    native: native(),
    totalTokens: 120_000,
  })
  assert.equal(decision.dataComplete, false)
  assert.equal(decision.triggerTokens, 130_000) // fallbackThreshold, not the prediction
  const derivation = decision.derivation
  assert.equal(derivation.growthSource, 'internal-default')
  assert.equal(derivation.growthRateTokensPerSecond, DEFAULT_GROWTH_TOKENS_PER_SECOND)
  assert.equal(derivation.predictedDurationSeconds, 58.5) // 45 * 1.3
  assert.equal(derivation.durationSource, 'default')
  assert.equal(derivation.durationObservations, 0)
  assert.equal(derivation.compressionTimeMultiplier, COMPRESSION_TIME_MULTIPLIER)
  assert.equal(derivation.predictedGrowthTokens, 200 * 58.5)
  assert.equal(derivation.safetyMarginTokens, SAFETY_MARGIN_TOKENS)
  assert.equal(derivation.predictedTotalGrowthTokens, 200 * 58.5 + 4096)
  assert.equal(derivation.burstGrowthFactor, BURST_GROWTH_FACTOR)

  // Legacy tuning knobs in a raw config are inert: identical derivation.
  const legacy = evaluateTrigger({
    config: config({
      triggerMode: 'adaptive',
      // Removed config keys, deliberately present in a legacy raw object.
      safetyMarginTokens: 1,
      compressionTimeMultiplier: 9,
      defaultCompressionSeconds: 1,
      defaultGrowthTokensPerSecond: 9999,
      burstGrowthFactor: 9,
      emaAlpha: 0.9,
      growthSamplingInterval: 1,
      growthWindow: 2,
    }),
    native: native(),
    totalTokens: 120_000,
  })
  assert.deepEqual(legacy.derivation, derivation)
  assert.equal(legacy.triggerTokens, decision.triggerTokens)
})

test('adaptive warm start reuses the last data-complete target when data is incomplete', () => {
  const warmStart = { at: 1234, triggerTokens: 150_000, triggerRatio: 0.75 }
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'adaptive', minThreshold: 0.5, maxThreshold: 0.75, fallbackThreshold: 0.65 }),
    native: native({ thresholdTokens: 160_000 }),
    totalTokens: 150_000,
    growth: growthNone,
    duration: { seconds: 58.5, observations: 0, source: 'default' },
    warmStart,
  })
  // The warm target is inside [min,max], so it is used verbatim instead of the 65% fallback.
  assert.equal(decision.dataComplete, false)
  assert.equal(decision.reason, 'adaptive-warm-start')
  assert.equal(decision.due, true)
  assert.equal(decision.triggerTokens, 150_000)
  assert.equal(decision.triggerRatio, 0.75)
  assert.equal(decision.derivation.warmStartTokens, 150_000)
  assert.equal(decision.derivation.warmStartRatio, 0.75)
  assert.equal(decision.derivation.warmStartAt, 1234)
})

test('without a valid warm start the adaptive fallback still applies', () => {
  for (const warmStart of [undefined, null, {}, { triggerTokens: 0 }, { triggerTokens: -1 }, { triggerTokens: '150000' }]) {
    const decision = evaluateTrigger({
      config: config({ triggerMode: 'adaptive', fallbackThreshold: 0.65 }),
      native: native(),
      totalTokens: 130_000,
      growth: growthNone,
      duration: { seconds: 58.5, observations: 0, source: 'default' },
      warmStart,
    })
    assert.equal(decision.reason, 'adaptive-fallback-no-data', JSON.stringify(warmStart))
    assert.equal(decision.triggerTokens, 130_000)
    assert.equal(decision.dataComplete, false)
    assert.equal(decision.derivation.warmStartTokens, null)
  }
})

test('a warm start never influences fixed mode', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'fixed', fixedThreshold: 0.3, autoAdjustFixedThreshold: false }),
    native: native({ contextWindow: 100_000, thresholdTokens: 90_000 }),
    totalTokens: 35_000,
    warmStart: { at: 1, triggerTokens: 150_000, triggerRatio: 0.75 },
  })
  // 30% of 100000 = 30000; 35000 is already due, and the warm target is ignored.
  assert.equal(decision.reason, 'fixed-threshold')
  assert.equal(decision.triggerTokens, 30_000)
  assert.equal(decision.derivation.warmStartTokens, undefined, 'fixed decisions carry no warm-start fields')
})

test('adaptive mode: full data predicts the trigger from growth and duration', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'adaptive', maxThreshold: 0.9 }),
    native: native({ thresholdTokens: 160_000 }),
    totalTokens: 155_000,
    growth: growthKnown(100, 100),
    duration: durationKnown(10),
  })
  // growth = 100 * 10 = 1000; + safety 4096 => 5096; 160000 - 5096 = 154904
  assert.equal(decision.dataComplete, true)
  assert.equal(decision.triggerTokens, 154_904)
  assert.equal(decision.reason, 'adaptive-predicted')
  assert.equal(decision.derivation.growthSource, 'ema')
  assert.equal(decision.derivation.growthRateTokensPerSecond, 100)
  assert.equal(decision.derivation.predictedGrowthTokens, 1000)
  assert.equal(decision.derivation.predictedTotalGrowthTokens, 5096)
  assert.equal(decision.triggerRatio, 0.7745)
})

test('adaptive mode: burst peak wins over the smoothed EMA', () => {
  const decision = evaluateTrigger({
    config: config({ triggerMode: 'adaptive', maxThreshold: 0.95 }),
    native: native({ thresholdTokens: 180_000 }),
    totalTokens: 100_000,
    growth: growthKnown(100, 500),
    duration: durationKnown(10),
  })
  // burst: 500 > 100 * 2 -> growthRate 500, growth 5000 + 4096
  assert.equal(decision.derivation.growthSource, 'burst-peak')
  assert.equal(decision.derivation.growthRateTokensPerSecond, 500)
  assert.equal(decision.triggerTokens, 180_000 - 9096)
})

test('adaptive mode: target is clamped to min/max thresholds', () => {
  const clampedMin = evaluateTrigger({
    config: config({ triggerMode: 'adaptive', minThreshold: 0.5, maxThreshold: 0.75 }),
    native: native({ thresholdTokens: 100_000 }),
    totalTokens: 100_000,
    growth: growthKnown(5000, 5000),
    duration: durationKnown(20),
  })
  assert.equal(clampedMin.dataComplete, true)
  assert.equal(clampedMin.reason, 'adaptive-clamped-min')
  assert.equal(clampedMin.triggerTokens, 100_000) // 0.5 * 200000
  assert.deepEqual(clampedMin.derivation.clamps, ['min-threshold'])

  const clampedMax = evaluateTrigger({
    config: config({ triggerMode: 'adaptive', minThreshold: 0.5, maxThreshold: 0.6 }),
    native: native({ thresholdTokens: 160_000 }),
    totalTokens: 130_000,
    growth: growthKnown(100, 100),
    duration: durationKnown(10),
  })
  assert.equal(clampedMax.reason, 'adaptive-clamped-max')
  assert.equal(clampedMax.triggerTokens, 120_000) // 0.6 * 200000
  assert.deepEqual(clampedMax.derivation.clamps, ['max-threshold'])
})

test('adaptive mode: data complete requires fresh samples, duration history and a real native policy', () => {
  const cases = [
    { fresh: false },
    { growth: { known: true, sampleCount: 1, ema: 10, peak: 10, rate: 10 } },
    { duration: { seconds: 10, observations: 0, source: 'default' } },
    { native: native({ source: 'defaults' }) },
    { native: native({ known: false }) },
  ]
  for (const overrides of cases) {
    const decision = evaluateTrigger({
      config: config({ triggerMode: 'adaptive' }),
      native: overrides.native ?? native(),
      totalTokens: 100_000,
      growth: overrides.growth ?? growthKnown(100, 100),
      duration: overrides.duration ?? durationKnown(10),
      fresh: overrides.fresh,
    })
    assert.equal(decision.dataComplete, false, JSON.stringify(overrides))
    assert.equal(decision.reason, 'below-threshold') // 100k < fallback 130k
  }
})

// ---------------------------------------------------------------------------
// growth tracker
// ---------------------------------------------------------------------------

test('growth tracker: EMA and peak over pairwise rates', () => {
  const tracker = createGrowthTracker({ windowMs: 60_000, alpha: 0.3 })
  tracker.addSample(1000, 1000)
  tracker.addSample(2000, 2000)
  const first = tracker.read(2000)
  assert.equal(first.known, true)
  assert.equal(first.sampleCount, 2)
  assert.equal(first.ema, 1000)
  assert.equal(first.peak, 1000)
  assert.equal(first.rate, 1000)

  tracker.addSample(3000, 4000) // rate 2000/s
  const second = tracker.read(3000)
  assert.equal(second.ema, 1300) // 0.3*2000 + 0.7*1000
  assert.equal(second.peak, 2000)
  assert.equal(second.rate, 2000)
  assert.equal(second.lastRate, 2000)
})

test('growth tracker: intervals below 500ms are ignored', () => {
  const tracker = createGrowthTracker({ windowMs: 60_000, alpha: 0.3 })
  tracker.addSample(1000, 1000)
  tracker.addSample(1400, 999_999) // dt 400 < 500 -> no rate
  const reading = tracker.read(1400)
  assert.equal(reading.sampleCount, 2)
  assert.equal(reading.ema, 0)
  assert.equal(reading.known, false)
  assert.equal(reading.peak, 0)
})

test('growth tracker: samples outside the window are pruned and reset clears state', () => {
  const tracker = createGrowthTracker({ windowMs: 1000, alpha: 0.3 })
  tracker.addSample(3000, 1000)
  tracker.addSample(4000, 2000)
  tracker.addSample(5000, 4000)
  const reading = tracker.read(5000) // floor 4000 -> t=3000 is pruned
  assert.equal(reading.sampleCount, 2)
  assert.equal(reading.known, true)
  assert.equal(reading.ema, 1300)
  assert.equal(reading.peak, 2000)

  tracker.reset()
  const reset = tracker.read(5000)
  assert.equal(reset.sampleCount, 0)
  assert.equal(reset.known, false)
  assert.equal(reset.ema, 0)
})

// ---------------------------------------------------------------------------
// duration tracker
// ---------------------------------------------------------------------------

test('duration tracker: default prediction before history, EMA afterwards', () => {
  const tracker = createDurationTracker({ alpha: 0.3 })
  const initial = tracker.predict(45, 1.3)
  assert.equal(initial.source, 'default')
  assert.equal(initial.seconds, 58.5)
  assert.equal(tracker.observations, 0)

  tracker.add(10)
  const one = tracker.predict(45, 1.3)
  assert.equal(one.source, 'history')
  assert.equal(one.seconds, 13)
  assert.equal(one.observations, 1)

  tracker.add(20)
  const two = tracker.predict(45, 1.3)
  assert.ok(Math.abs(two.seconds - 16.9) < 1e-9) // (0.3*20 + 0.7*10) * 1.3
  assert.equal(tracker.observations, 2)
})

test('duration tracker: non-positive and non-finite observations are ignored', () => {
  const tracker = createDurationTracker({ alpha: 0.3 })
  tracker.add(0)
  tracker.add(-5)
  tracker.add(Number.NaN)
  assert.equal(tracker.observations, 0)
  assert.equal(tracker.predict(45, 1.3).source, 'default')
})

// ---------------------------------------------------------------------------
// usage ratio + route usability
// ---------------------------------------------------------------------------

test('usageRatio is bounded and null without capacity', () => {
  assert.equal(usageRatio(50_000, 100_000), 0.5)
  assert.equal(usageRatio(200_000, 100_000), 2)
  assert.equal(usageRatio(5_000_000, 100_000), 10)
  assert.equal(usageRatio(0, 100_000), 0)
  assert.equal(usageRatio(Number.NaN, 100_000), null)
  assert.equal(usageRatio(50_000, 0), null)
  assert.equal(usageRatio(50_000, null), null)
  assert.equal(usageRatio(50_000, undefined), null)
})

test('routeUsable only requires a non-empty provider/model pair', () => {
  // Compaction is not scoped by model here: route selection belongs to the
  // installer, not to the asynchronous scheduling layer (model allow/deny keys
  // were removed from the plugin config).
  assert.equal(routeUsable({ provider: 'p', model: 'm' }), true)
  assert.equal(routeUsable({ provider: 'any-provider', model: 'any-model' }), true)
  assert.equal(routeUsable({ provider: '', model: 'm' }), false)
  assert.equal(routeUsable({ provider: 'p', model: '' }), false)
  assert.equal(routeUsable({ provider: 'p' }), false)
  assert.equal(routeUsable({ model: 'm' }), false)
  assert.equal(routeUsable({}), false)
  assert.equal(routeUsable(undefined), false)
  assert.equal(routeUsable(null), false)
})
