/**
 * Plugin configuration: defaults, normalisation and validation.
 *
 * Every field is a plain JSON value so the config can live in
 * `cordis.patch.yml` (and be edited through the host's config editor).
 * @module dsh-async-compaction/config
 */

import { clamp, isFiniteNumber, numberOr } from './util.js'

/** @typedef {'fixed' | 'adaptive'} TriggerMode */
/** @typedef {'safe' | 'end-of-turn' | 'idle-only'} ApplyStrategy */

/** Default configuration, mirroring the design document. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  triggerMode: 'fixed',

  // Fixed mode
  fixedThreshold: 0.7,

  // Native compaction threshold source: 'auto' reads the mounted backend's own
  // resolved policy; a number overrides it (0 < n <= 1).
  nativeThreshold: 'auto',

  // Adaptive mode: only the clamp window and the no-data fallback are options.
  // Growth/duration prediction internals are fixed constants
  // (`src/internal-policy.js`) so the formula stays simple and predictable.
  minThreshold: 0.5,
  maxThreshold: 0.75,
  fallbackThreshold: 0.65,

  // Scheduling. Concurrency is per-session and fixed at one in-flight summary;
  // there is no process-wide cap to configure.
  minInterval: 60000,
  applyStrategy: 'safe',

  // Range selection: only the minimum-gain gate. How much of the context the
  // compaction keeps is the backend's own `retainRatio`/`retainTokens` policy.
  minShadowedTokens: 1024,

  // Manual compaction compatibility: take over the /compact path so an
  // explicit human request also summarizes off the critical path. The request
  // has no plugin-owned deadline: native compaction semantics own its lifecycle.
  hookManualCompact: true,

  // Behavior
  dryRun: false,
  autoAdjustFixedThreshold: true,
  logLevel: 'info',
  // Recent structured records kept in memory for `/precompact logs` and the
  // debug endpoint. 0 disables the buffer; console logging is unaffected.
  logBufferSize: 500,
  statusCommand: true,
})

const RATIO_KEYS = ['fixedThreshold', 'minThreshold', 'maxThreshold', 'fallbackThreshold']
const NON_NEGATIVE_KEYS = ['minInterval', 'minShadowedTokens', 'logBufferSize']
const STRING_KEYS = ['logLevel', 'applyStrategy', 'triggerMode']
const BOOLEAN_KEYS = ['enabled', 'dryRun', 'statusCommand', 'autoAdjustFixedThreshold', 'hookManualCompact']

/**
 * Validate and normalise one raw plugin config.
 * Unknown keys are kept out of the resolved object (the host's own schema, when
 * it resolves, already rejects them); invalid values fall back to the default
 * and are reported through `warnings` instead of failing the plugin.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {{ config: Record<string, any>, warnings: string[] }}
 */
export function resolveConfig(raw = {}) {
  const warnings = []
  const config = { ...DEFAULTS }
  const source = raw !== null && typeof raw === 'object' ? raw : {}

  for (const key of RATIO_KEYS) {
    if (source[key] === undefined) continue
    const value = source[key]
    if (!isFiniteNumber(value) || value <= 0 || value > 1) {
      warnings.push(`${key} must be a number in (0, 1]; using ${DEFAULTS[key]}`)
      continue
    }
    config[key] = value
  }
  for (const key of NON_NEGATIVE_KEYS) {
    if (source[key] === undefined) continue
    const value = source[key]
    if (!isFiniteNumber(value) || value < 0) {
      warnings.push(`${key} must be a non-negative number; using ${DEFAULTS[key]}`)
      continue
    }
    config[key] = Math.round(value)
  }
  for (const key of STRING_KEYS) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'string') {
      warnings.push(`${key} must be a string; using ${DEFAULTS[key]}`)
      continue
    }
    config[key] = source[key]
  }
  for (const key of BOOLEAN_KEYS) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'boolean') {
      warnings.push(`${key} must be a boolean; using ${DEFAULTS[key]}`)
      continue
    }
    config[key] = source[key]
  }

  if (config.triggerMode !== 'fixed' && config.triggerMode !== 'adaptive') {
    warnings.push(`triggerMode must be "fixed" or "adaptive"; using "${DEFAULTS.triggerMode}"`)
    config.triggerMode = DEFAULTS.triggerMode
  }
  if (!['safe', 'end-of-turn', 'idle-only'].includes(config.applyStrategy)) {
    warnings.push(`applyStrategy must be "safe", "end-of-turn" or "idle-only"; using "${DEFAULTS.applyStrategy}"`)
    config.applyStrategy = DEFAULTS.applyStrategy
  }
  if (!['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
    warnings.push(`logLevel must be one of debug/info/warn/error; using "${DEFAULTS.logLevel}"`)
    config.logLevel = DEFAULTS.logLevel
  }
  if (config.minThreshold > config.maxThreshold) {
    warnings.push(
      `minThreshold (${config.minThreshold}) is above maxThreshold (${config.maxThreshold}); swapping them`,
    )
    const min = Math.min(config.minThreshold, config.maxThreshold)
    const max = Math.max(config.minThreshold, config.maxThreshold)
    config.minThreshold = min
    config.maxThreshold = max
  }
  config.minInterval = Math.max(0, Math.round(config.minInterval))
  config.logBufferSize = Math.max(0, Math.round(config.logBufferSize))

  const native = source.nativeThreshold
  if (native === undefined || native === 'auto') {
    config.nativeThreshold = 'auto'
  } else if (isFiniteNumber(native) && native > 0 && native <= 1) {
    config.nativeThreshold = native
  } else {
    warnings.push('nativeThreshold must be "auto" or a number in (0, 1]; using "auto"')
    config.nativeThreshold = 'auto'
  }

  // Compaction semantics are not configurable here: the `retainRatio`,
  // `retainTokens`, `manualCompactRetainTokens`, `summarization*`,
  // `maxSummaryTokens`, `minReductionRatio`, `modelAllowlist` and
  // `modelDenylist` keys this plugin used to own are gone. Old profile configs
  // may still carry them; unknown keys are ignored silently.
  const legacy = new Set([
    'retainRatio',
    'retainTokens',
    'manualCompactRetainTokens',
    'summarizationProvider',
    'summarizationModel',
    'maxSummaryTokens',
    'minReductionRatio',
    'modelAllowlist',
    'modelDenylist',
    'manualCompactTimeoutSeconds',
    'safetyMarginTokens',
    'compressionTimeMultiplier',
    'defaultCompressionSeconds',
    'defaultGrowthTokensPerSecond',
    'burstGrowthFactor',
    'emaAlpha',
    'growthSamplingInterval',
    'growthWindow',
    'maxConcurrent',
  ])
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(DEFAULTS, key) || legacy.has(key)) continue
    warnings.push(`unknown config key "${key}" was ignored`)
  }

  config.fixedThreshold = clamp(config.fixedThreshold, 0.01, 1)
  return { config, warnings }
}

/**
 * Unwrap Cordis volatile config references.
 *
 * A field declared `.volatile()` in the schema reaches `apply()` as a frozen
 * reference `{ get() }` instead of a value: the Loader updates it in place for a
 * volatile-only settings change. Every consumer wants the current value, so the
 * raw config is unwrapped before validation (and again after each update).
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function unwrapConfigRefs(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      out[key] = value.get()
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Resolve the host's schemastery package. A locally linked checkout cannot
 * resolve `@deepseek-ai/*` from its own directory, so the profile directory
 * (whose `node_modules` holds the shared packages) is tried through
 * `createRequire` as a second chance.
 * @returns {Promise<any | undefined>}
 */
async function importSchemastery() {
  try {
    return await import('@deepseek-ai/schemastery')
  } catch {
    // fall through to the profile-based resolver
  }
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { join } = await import('node:path')
  const roots = [process.env.DSH_PROFILE_DIR, process.env.DSH_HOME].filter((dir) => typeof dir === 'string' && dir.length > 0)
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'noop.cjs'))
      const resolved = require.resolve('@deepseek-ai/schemastery')
      return await import(pathToFileURL(resolved).href)
    } catch {
      // try the next root
    }
  }
  return undefined
}

/**
 * Build an optional schemastery Config schema when the host can resolve the
 * package (a copied install, or a linked checkout inside a profile).
 * @returns {Promise<any | undefined>}
 */
export async function loadConfigSchema() {
  try {
    const schemaPackage = await importSchemastery()
    if (schemaPackage === undefined) return undefined
    const z = schemaPackage.default ?? schemaPackage
    const ratio = () => z.number().min(0.01).max(1)
    // Every behavioral option is `.volatile()`: saving it from the Plugins page
    // updates the running plugin in place (no restart, no lost background task).
    // `statusCommand` changes command registration, so it restarts on change.
    return z.object({
      enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
      triggerMode: z.union([z.const('fixed'), z.const('adaptive')]).default(DEFAULTS.triggerMode).volatile(),
      fixedThreshold: ratio().default(DEFAULTS.fixedThreshold).volatile(),
      nativeThreshold: z.union([z.const('auto'), ratio()]).default(DEFAULTS.nativeThreshold).volatile(),
      minThreshold: ratio().default(DEFAULTS.minThreshold).volatile(),
      maxThreshold: ratio().default(DEFAULTS.maxThreshold).volatile(),
      fallbackThreshold: ratio().default(DEFAULTS.fallbackThreshold).volatile(),
      minInterval: z.number().min(0).default(DEFAULTS.minInterval).volatile(),
      applyStrategy: z
        .union([z.const('safe'), z.const('end-of-turn'), z.const('idle-only')])
        .default(DEFAULTS.applyStrategy)
        .volatile(),
      minShadowedTokens: z.number().min(0).step(1).default(DEFAULTS.minShadowedTokens).volatile(),
      logBufferSize: z.number().min(0).step(1).default(DEFAULTS.logBufferSize).volatile(),
      hookManualCompact: z.boolean().default(DEFAULTS.hookManualCompact).volatile(),
      dryRun: z.boolean().default(DEFAULTS.dryRun).volatile(),
      autoAdjustFixedThreshold: z.boolean().default(DEFAULTS.autoAdjustFixedThreshold).volatile(),
      logLevel: z
        .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
        .default(DEFAULTS.logLevel)
        .volatile(),
      statusCommand: z.boolean().default(DEFAULTS.statusCommand),
    })
  } catch {
    return undefined
  }
}

/** @param {unknown} value */
export function summarizeConfigForLog(config) {
  return {
    enabled: config.enabled,
    triggerMode: config.triggerMode,
    fixedThreshold: config.fixedThreshold,
    nativeThreshold: config.nativeThreshold,
    minThreshold: config.minThreshold,
    maxThreshold: config.maxThreshold,
    applyStrategy: config.applyStrategy,
    dryRun: config.dryRun,
  }
}

export { numberOr }
