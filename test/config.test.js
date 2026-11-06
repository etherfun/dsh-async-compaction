/**
 * Config resolution: defaults, per-key validation, warnings, and the reduced
 * configuration surface (only asynchronous-scheduling options survive; adaptive
 * prediction internals are fixed constants in `src/internal-policy.js`).
 * @module test/config.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as preCompact from '../index.js'
import { apply, name, Config } from '../index.js'
import { DEFAULTS, resolveConfig, unwrapConfigRefs } from '../src/config.js'

/** Every key of the reduced configuration surface (16). */
const CONFIG_KEYS = Object.freeze([
  'enabled',
  'triggerMode',
  'fixedThreshold',
  'nativeThreshold',
  'minThreshold',
  'maxThreshold',
  'fallbackThreshold',
  'minInterval',
  'applyStrategy',
  'minShadowedTokens',
  'logBufferSize',
  'hookManualCompact',
  'dryRun',
  'autoAdjustFixedThreshold',
  'logLevel',
  'statusCommand',
])

/**
 * Keys the plugin used to own and now delegates to the mounted backend or to
 * internal constants. Old profile configs may still carry them: they are
 * silently ignored (no warning, not part of the resolved object).
 */
const REMOVED_KEYS = Object.freeze([
  // compaction semantics -> mounted backend
  'retainRatio',
  'retainTokens',
  'manualCompactRetainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxSummaryTokens',
  'minReductionRatio',
  'modelAllowlist',
  'modelDenylist',
  // manual deadline -> native compaction lifecycle
  'manualCompactTimeoutSeconds',
  // adaptive prediction internals -> src/internal-policy.js constants
  'safetyMarginTokens',
  'compressionTimeMultiplier',
  'defaultCompressionSeconds',
  'defaultGrowthTokensPerSecond',
  'burstGrowthFactor',
  'emaAlpha',
  'growthSamplingInterval',
  'growthWindow',
  // scheduling: the per-session limit is fixed at 1, different sessions no longer queue
  'maxConcurrent',
])

/** @param {Record<string, unknown>} raw */
function resolve(raw) {
  return resolveConfig(raw)
}

/** @param {string[]} warnings @param {RegExp} pattern */
function hasWarning(warnings, pattern) {
  return warnings.some((warning) => pattern.test(warning))
}

test('plugin entry exports the host contract', () => {
  assert.equal(name, 'pre-compact')
  assert.equal(typeof apply, 'function')
  assert.equal(preCompact.name, 'pre-compact')
  // Locally linked checkouts cannot resolve the host schemastery package, so the
  // declarative Config may be undefined; when it resolves it is a schema object
  // or a callable schema factory.
  assert.ok(Config === undefined || Config === null || typeof Config === 'object' || typeof Config === 'function')
})

test('resolveConfig() returns every documented default', () => {
  const { config, warnings } = resolve({})
  assert.deepEqual(warnings, [])
  assert.deepEqual(config, DEFAULTS)
  assert.deepEqual(Object.keys(config).sort(), [...CONFIG_KEYS].sort())
  assert.equal(Object.keys(config).length, 16)

  // Spot-check the scheduling/adaptive-window defaults.
  assert.equal(config.triggerMode, 'fixed')
  assert.equal(config.fixedThreshold, 0.7)
  assert.equal(config.minThreshold, 0.5)
  assert.equal(config.maxThreshold, 0.75)
  assert.equal(config.fallbackThreshold, 0.65)
  assert.equal(config.minInterval, 60_000)
  assert.equal(config.applyStrategy, 'safe')
  assert.equal(config.minShadowedTokens, 1024)
  assert.equal(config.logBufferSize, 500)
  assert.equal(config.hookManualCompact, true)
  assert.equal(config.autoAdjustFixedThreshold, true)
  assert.equal(config.logLevel, 'info')
  assert.equal(config.statusCommand, true)
})

test('resolveConfig() tolerates undefined and null raw config', () => {
  assert.deepEqual(resolveConfig().config, DEFAULTS)
  assert.deepEqual(resolveConfig(null).config, DEFAULTS)
  assert.deepEqual(resolveConfig(undefined).config, DEFAULTS)
})

test('ratio keys reject out-of-range values with a warning and keep the default', () => {
  for (const key of ['fixedThreshold', 'minThreshold', 'maxThreshold', 'fallbackThreshold']) {
    for (const invalid of [0, -0.5, 1.5, Number.NaN, '0.5']) {
      const { config, warnings } = resolve({ [key]: invalid })
      assert.equal(config[key], DEFAULTS[key], `${key}=${String(invalid)} must fall back to the default`)
      assert.ok(hasWarning(warnings, new RegExp(`${key} must be a number in \\(0, 1\\]`)), `missing warning for ${key}`)
    }
  }
})

test('ratio keys accept values in (0, 1]', () => {
  const { config, warnings } = resolve({
    fixedThreshold: 0.42,
    minThreshold: 0.3,
    maxThreshold: 0.6,
    fallbackThreshold: 0.33,
  })
  assert.deepEqual(warnings, [])
  assert.equal(config.fixedThreshold, 0.42)
  assert.equal(config.minThreshold, 0.3)
  assert.equal(config.maxThreshold, 0.6)
  assert.equal(config.fallbackThreshold, 0.33)
})

test('non-negative integer keys reject negatives and round decimals', () => {
  const negative = resolve({ minInterval: -6, minShadowedTokens: -9, logBufferSize: -1 })
  assert.equal(negative.config.minInterval, DEFAULTS.minInterval)
  assert.equal(negative.config.minShadowedTokens, DEFAULTS.minShadowedTokens)
  assert.equal(negative.config.logBufferSize, DEFAULTS.logBufferSize)
  assert.equal(negative.warnings.length, 3)
  for (const warning of negative.warnings) assert.match(warning, /must be a non-negative number/)
  assert.ok(hasWarning(negative.warnings, /logBufferSize must be a non-negative number/))

  const rounded = resolve({ minInterval: 60_000.7, minShadowedTokens: 1023.6, logBufferSize: 1023.6 })
  assert.equal(rounded.config.minInterval, 60_001)
  assert.equal(rounded.config.minShadowedTokens, 1024)
  assert.equal(rounded.config.logBufferSize, 1024)
})

test('logBufferSize accepts 0 and positive integers, rejects non-numbers with a warning', () => {
  // 0 is meaningful: it disables the in-memory ring buffer.
  assert.equal(resolve({ logBufferSize: 0 }).config.logBufferSize, 0)
  assert.deepEqual(resolve({ logBufferSize: 0 }).warnings, [])

  assert.equal(resolve({ logBufferSize: 250 }).config.logBufferSize, 250)
  assert.equal(resolve({ logBufferSize: 499.4 }).config.logBufferSize, 499)

  for (const invalid of ['500', null, true, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const { config, warnings } = resolve({ logBufferSize: invalid })
    assert.equal(config.logBufferSize, DEFAULTS.logBufferSize, `logBufferSize=${String(invalid)} must fall back`)
    assert.ok(hasWarning(warnings, /logBufferSize must be a non-negative number/))
  }
})

test('the declarative schema exposes logBufferSize as a volatile non-negative integer', () => {
  // `src/config-schema.js` ships the host schema; the volatile flag is what lets
  // the settings page change the buffer size without a plugin reload.
  assert.ok(Config !== undefined, 'the packaged config schema must be available')
  const field = Config.dict?.logBufferSize
  assert.ok(field !== undefined, 'logBufferSize must be part of the host schema')
  assert.equal(field.type, 'number')
  assert.equal(field.meta.min, 0)
  assert.equal(field.meta.step, 1)
  assert.equal(field.meta.default, DEFAULTS.logBufferSize)
  assert.equal(field.meta.volatile, true)
  // Every behavioural key except statusCommand is volatile (statusCommand
  // restarts on change because it registers a command).
  for (const key of CONFIG_KEYS) {
    if (key === 'statusCommand') continue
    assert.equal(Config.dict[key].meta.volatile, true, `${key} must be volatile`)
  }
})

test('the removed maxConcurrent key is silently ignored', () => {
  // The per-session limit is now fixed at 1; different sessions no longer queue.
  const { config, warnings } = resolve({ maxConcurrent: 4 })
  assert.deepEqual(warnings, [])
  assert.equal(Object.hasOwn(config, 'maxConcurrent'), false)
  assert.equal(Object.hasOwn(Config.dict, 'maxConcurrent'), false, 'the host schema no longer offers the key')
})

test('string and boolean keys fall back with a warning on wrong types', () => {
  const { config, warnings } = resolve({
    triggerMode: 5,
    applyStrategy: null,
    logLevel: true,
    enabled: 'yes',
    dryRun: 1,
    statusCommand: 'true',
    autoAdjustFixedThreshold: 'no',
  })
  assert.equal(config.triggerMode, DEFAULTS.triggerMode)
  assert.equal(config.applyStrategy, DEFAULTS.applyStrategy)
  assert.equal(config.logLevel, DEFAULTS.logLevel)
  assert.equal(config.enabled, DEFAULTS.enabled)
  assert.equal(config.dryRun, DEFAULTS.dryRun)
  assert.equal(config.statusCommand, DEFAULTS.statusCommand)
  assert.equal(config.autoAdjustFixedThreshold, DEFAULTS.autoAdjustFixedThreshold)
  assert.equal(warnings.length, 7)
})

test('closed enum strings are validated after type checks', () => {
  const bad = resolve({ triggerMode: 'sometimes', applyStrategy: 'never', logLevel: 'verbose' })
  assert.equal(bad.config.triggerMode, 'fixed')
  assert.equal(bad.config.applyStrategy, 'safe')
  assert.equal(bad.config.logLevel, 'info')
  assert.ok(hasWarning(bad.warnings, /triggerMode must be "fixed" or "adaptive"/))
  assert.ok(hasWarning(bad.warnings, /applyStrategy must be "safe", "end-of-turn" or "idle-only"/))
  assert.ok(hasWarning(bad.warnings, /logLevel must be one of debug\/info\/warn\/error/))

  const good = resolve({ triggerMode: 'adaptive', applyStrategy: 'idle-only', logLevel: 'debug' })
  assert.equal(good.config.triggerMode, 'adaptive')
  assert.equal(good.config.applyStrategy, 'idle-only')
  assert.equal(good.config.logLevel, 'debug')
  assert.deepEqual(good.warnings, [])
})

test('minThreshold above maxThreshold is swapped with a warning', () => {
  const { config, warnings } = resolve({ minThreshold: 0.9, maxThreshold: 0.4 })
  assert.equal(config.minThreshold, 0.4)
  assert.equal(config.maxThreshold, 0.9)
  assert.ok(hasWarning(warnings, /minThreshold \(0\.9\) is above maxThreshold \(0\.4\); swapping them/))
})

test('derived clamps: fixed threshold bounds', () => {
  assert.equal(resolve({ fixedThreshold: 0.001 }).config.fixedThreshold, 0.01)
  assert.equal(resolve({ fixedThreshold: 0.999 }).config.fixedThreshold, 0.999)
})

test('nativeThreshold accepts "auto" or a ratio and warns otherwise', () => {
  assert.equal(resolve({ nativeThreshold: 'auto' }).config.nativeThreshold, 'auto')
  assert.equal(resolve({ nativeThreshold: 0.5 }).config.nativeThreshold, 0.5)
  assert.deepEqual(resolve({ nativeThreshold: 'auto' }).warnings, [])

  for (const invalid of [0, 1.5, '0.8', true, Number.NaN]) {
    const { config, warnings } = resolve({ nativeThreshold: invalid })
    assert.equal(config.nativeThreshold, 'auto')
    assert.ok(hasWarning(warnings, /nativeThreshold must be "auto" or a number/))
  }
})

test('unknown keys are dropped from the resolved config and diagnosed', () => {
  const { config, warnings } = resolve({ totallyUnknown: 1, another: 2 })
  assert.equal(Object.hasOwn(config, 'totallyUnknown'), false)
  assert.equal(Object.hasOwn(config, 'another'), false)
  assert.deepEqual(Object.keys(config).sort(), [...CONFIG_KEYS].sort())
  assert.equal(warnings.length, 2, 'each non-legacy unknown key produces one warning')
  assert.ok(hasWarning(warnings, /unknown config key "totallyUnknown" was ignored/))
  assert.ok(hasWarning(warnings, /unknown config key "another" was ignored/))
})

test('every removed key is silently ignored (no warning, not resolved)', () => {
  assert.equal(REMOVED_KEYS.length, 19)
  const raw = Object.fromEntries(REMOVED_KEYS.map((key, index) => [key, index % 2 === 0 ? 0.25 : 4096]))
  // Also includes badly typed values and the former pairing/route lists.
  raw.modelAllowlist = 'gpt'
  raw.modelDenylist = 42
  raw.summarizationProvider = 'openai'

  const { config, warnings } = resolve(raw)
  assert.deepEqual(warnings, [], 'removed keys must not produce warnings')
  assert.deepEqual(Object.keys(config).sort(), [...CONFIG_KEYS].sort())
  for (const key of REMOVED_KEYS) {
    assert.equal(Object.hasOwn(config, key), false, `${key} must be ignored`)
    assert.equal(Object.hasOwn(DEFAULTS, key), false, `${key} must not be a default`)
  }

  // A legacy adaptive/timeout configuration cannot change any resolved value.
  const legacy = resolve({
    safetyMarginTokens: 1,
    compressionTimeMultiplier: 9,
    defaultCompressionSeconds: 1,
    defaultGrowthTokensPerSecond: 9999,
    burstGrowthFactor: 9,
    emaAlpha: 0.9,
    growthSamplingInterval: 1,
    growthWindow: 2,
    manualCompactTimeoutSeconds: 1,
  })
  assert.deepEqual(legacy.warnings, [])
  assert.deepEqual(legacy.config, DEFAULTS)
})

test('manual compaction compatibility keys validate', () => {
  const badHook = resolve({ hookManualCompact: 'yes' })
  assert.equal(badHook.config.hookManualCompact, true)
  assert.ok(hasWarning(badHook.warnings, /hookManualCompact must be a boolean/))

  const explicit = resolve({ hookManualCompact: false })
  assert.equal(explicit.config.hookManualCompact, false)
  assert.deepEqual(explicit.warnings, [])
})

test('DEFAULTS is frozen and contains exactly the reduced surface', () => {
  assert.ok(Object.isFrozen(DEFAULTS))
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [...CONFIG_KEYS].sort())
  assert.equal(Object.keys(DEFAULTS).length, 16)
  for (const key of CONFIG_KEYS) assert.ok(Object.hasOwn(DEFAULTS, key), `missing default ${key}`)
})

test('unwrapConfigRefs unwraps volatile references before validation', () => {
  assert.deepEqual(unwrapConfigRefs({ plain: 1, volatile: { get: () => 2 } }), { plain: 1, volatile: 2 })
  assert.deepEqual(unwrapConfigRefs(null), {})
  assert.deepEqual(unwrapConfigRefs(undefined), {})
  assert.deepEqual(unwrapConfigRefs('nope'), {})
})
