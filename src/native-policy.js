/**
 * Resolve the *actual* native compaction threshold of the mounted backend.
 *
 * The shipped backend keeps its resolved policy as the instance field
 * `config` (`@deepseek-ai/dsh-compaction-basic`), so reading it is a supported
 * side effect of the published class rather than a guessed interface. When it
 * cannot be read (a different backend, or a future version), the plugin falls
 * back to the documented defaults, and `nativeThreshold` in the plugin config
 * lets the user override the ratio explicitly.
 * @module dsh-pre-compact/native-policy
 */

import { isRecord } from './util.js'

/** Documented default pressure ratio of the shipped backend. */
export const DEFAULT_NATIVE_RATIO = 0.8
/** Documented default headroom of the shipped backend. */
export const DEFAULT_NATIVE_HEADROOM = 65536
/** Documented default retention ratio of the shipped backend's message budget. */
export const DEFAULT_NATIVE_RETAIN_RATIO = 0.16

/**
 * Locate the compaction service for one agent. Profiles may mount it on the
 * host plane, or inside an isolated preset group reachable only through the
 * preset registry.
 * @param {any} ctx
 * @param {any} [agent]
 */
export function compactionServiceOf(ctx, agent) {
  const direct = ctx.get?.('compaction')
  if (direct !== undefined && direct !== null) return direct
  const presets = ctx.get?.('agentPresets')
  if (presets !== undefined && presets !== null && agent !== undefined) {
    try {
      return presets.serviceFor?.(agent, 'compaction')
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Read the backend's resolved policy without assuming its shape.
 * `modelPolicies` (the backend's per-target overrides) is exposed so the
 * scheduler follows the backend's own thresholds and retention for the routed
 * target instead of inventing its own.
 * @param {any} engine
 * @returns {{
 *   ratio: number,
 *   headroom: number,
 *   retainRatio?: number,
 *   retainTokens?: number,
 *   auto?: boolean,
 *   modelPolicies?: Array<{ provider: string, model: string, thresholdRatio?: number, headroomTokens?: number, retainRatio?: number, retainTokens?: number }>,
 * } | undefined}
 */
export function readBackendPolicy(engine) {
  const config = engine?.config
  if (!isRecord(config)) return undefined
  const ratio = config.thresholdRatio
  const headroom = config.headroomTokens
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return undefined
  const headroomTokens = typeof headroom === 'number' && Number.isFinite(headroom) && headroom >= 0 ? headroom : DEFAULT_NATIVE_HEADROOM
  const retainRatio = typeof config.retainRatio === 'number' && config.retainRatio > 0 && config.retainRatio < 1 ? config.retainRatio : undefined
  const retainTokens = typeof config.retainTokens === 'number' && config.retainTokens >= 0 ? config.retainTokens : undefined
  return {
    ratio,
    headroom: headroomTokens,
    ...(retainRatio === undefined ? {} : { retainRatio }),
    ...(retainTokens === undefined ? {} : { retainTokens }),
    ...(typeof config.auto === 'boolean' ? { auto: config.auto } : {}),
    ...(Array.isArray(config.modelPolicies) ? { modelPolicies: config.modelPolicies.map(normalizeModelPolicy).filter((policy) => policy !== undefined) } : {}),
  }
}

/**
 * Keep only the parts of one `modelPolicies` entry the scheduler understands
 * and validates them the way the backend itself does.
 * @param {unknown} entry
 * @returns {{ provider: string, model: string, thresholdRatio?: number, headroomTokens?: number, retainRatio?: number, retainTokens?: number } | undefined}
 */
function normalizeModelPolicy(entry) {
  if (!isRecord(entry) || typeof entry.provider !== 'string' || typeof entry.model !== 'string') return undefined
  if (entry.provider.length === 0 || entry.model.length === 0) return undefined
  /** @type {{ provider: string, model: string, thresholdRatio?: number, headroomTokens?: number, retainRatio?: number, retainTokens?: number }} */
  const policy = { provider: entry.provider, model: entry.model }
  const thresholdRatio = entry.thresholdRatio
  if (typeof thresholdRatio === 'number' && Number.isFinite(thresholdRatio) && thresholdRatio > 0 && thresholdRatio <= 1) {
    policy.thresholdRatio = thresholdRatio
  }
  const headroomTokens = entry.headroomTokens
  if (typeof headroomTokens === 'number' && Number.isFinite(headroomTokens) && headroomTokens >= 0) {
    policy.headroomTokens = headroomTokens
  }
  const retainRatio = entry.retainRatio
  if (typeof retainRatio === 'number' && Number.isFinite(retainRatio) && retainRatio > 0 && retainRatio < 1) {
    policy.retainRatio = retainRatio
  }
  const retainTokens = entry.retainTokens
  if (typeof retainTokens === 'number' && Number.isFinite(retainTokens) && retainTokens >= 0) {
    policy.retainTokens = retainTokens
  }
  return policy
}

/**
 * Pick the provider/model of the session's latest routed request.
 * @param {any} session
 * @returns {{ provider: string, model: string } | undefined}
 */
export function routedTargetOf(session) {
  const context = session.requestContext?.()
  if (isRecord(context) && typeof context.provider === 'string' && typeof context.model === 'string') {
    if (context.provider.length > 0 && context.model.length > 0) return { provider: context.provider, model: context.model }
  }
  const config = session.requestHeader?.()?.config
  if (isRecord(config) && typeof config.provider === 'string' && typeof config.model === 'string') {
    if (config.provider.length > 0 && config.model.length > 0) return { provider: config.provider, model: config.model }
  }
  return undefined
}

/**
 * Resolve concrete native budgets for one session.
 *
 * @param {object} input
 * @param {any} input.ctx
 * @param {any} input.session
 * @param {any} [input.agent]
 * @param {Record<string, any>} input.config
 * @param {AbortSignal} [input.signal]
 * @param {Map<string, { at: number, value: any }>} [input.cache] - provider/model capacity cache
 * @param {number} [input.now]
 * @returns {Promise<{
 *   known: boolean, reason?: string, provider?: string, model?: string,
 *   contextWindow?: number, reservedCompletionTokens?: number, headroomTokens?: number,
 *   thresholdRatio?: number, thresholdTokens?: number, retainTokens?: number,
 *   source?: 'backend-config' | 'defaults' | 'override', at?: number,
 * }>}
 */
export async function resolveNativePolicy({ ctx, session, agent, config, signal, cache, now = Date.now() }) {
  const route = routedTargetOf(session)
  const backend = readBackendPolicy(compactionServiceOf(ctx, agent))

  // The last request/context event carries the adapter-declared capacity and is
  // refreshed only when the route changes; it costs nothing to read.
  let contextWindow
  let defaultMaxTokens
  try {
    const pressure = ctx.get?.('tokenMeter')?.contextPressure?.(session)
    if (isRecord(pressure) && typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0) {
      contextWindow = pressure.contextWindow
    }
  } catch {
    // fall through to the adapter query
  }

  if (contextWindow === undefined && route !== undefined) {
    const key = `${route.provider}/${route.model}`
    const cached = cache?.get(key)
    if (cached !== undefined && now - cached.at < 60_000) {
      contextWindow = cached.value.contextWindow
      defaultMaxTokens = cached.value.defaultMaxTokens
    } else if (typeof ctx.get?.('llm')?.resolveModelInfo === 'function') {
      try {
        const info = await ctx.get('llm').resolveModelInfo(route.provider, route.model, signal)
        const window = info?.context?.contextWindow
        if (typeof window === 'number' && window > 0) {
          contextWindow = window
          defaultMaxTokens = typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : undefined
          cache?.set(key, { at: now, value: { contextWindow, defaultMaxTokens } })
        }
      } catch {
        // capacity unknown; caller degrades to the fallback policy
      }
    }
  }

  if (contextWindow === undefined || !(contextWindow > 0)) {
    return { known: false, reason: 'no-context-capacity', ...(route === undefined ? {} : { provider: route.provider, model: route.model }) }
  }

  const headerMaxTokens = session.requestHeader?.()?.config?.maxTokens
  const reservedCompletionTokens =
    typeof headerMaxTokens === 'number' && headerMaxTokens >= 0
      ? headerMaxTokens
      : typeof defaultMaxTokens === 'number' && defaultMaxTokens >= 0
        ? defaultMaxTokens
        : 0

  const override = typeof config.nativeThreshold === 'number' ? config.nativeThreshold : undefined
  // Follow the backend's per-target policy for the routed model when it has one;
  // otherwise use its global policy. The scheduler must trigger before *that*
  // backend compacts, not before a threshold this plugin invented.
  const targetPolicy =
    route === undefined
      ? undefined
      : backend?.modelPolicies?.find((policy) => policy.provider === route.provider && policy.model === route.model)
  const ratio = override ?? targetPolicy?.thresholdRatio ?? backend?.ratio ?? DEFAULT_NATIVE_RATIO
  const headroom = override !== undefined ? 0 : targetPolicy?.headroomTokens ?? backend?.headroom ?? DEFAULT_NATIVE_HEADROOM
  const messageBudget = contextWindow - reservedCompletionTokens
  const pressureBudget = messageBudget - headroom
  const thresholdTokens = Math.floor(Math.min(contextWindow * ratio, pressureBudget > 0 ? pressureBudget : messageBudget))
  if (!(thresholdTokens > 0)) {
    return {
      known: false,
      reason: 'no-pressure-budget',
      ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
      contextWindow,
      reservedCompletionTokens,
      headroomTokens: headroom,
      thresholdRatio: ratio,
      source: override !== undefined ? 'override' : backend === undefined ? 'defaults' : 'backend-config',
    }
  }

  // Retention mirrors the mounted backend's own merge order: a per-target
  // explicit form (tokens, else ratio) overrides the backend's global explicit
  // form (tokens, else ratio), which overrides the shipped backend's defaults.
  let retainTokensRaw
  if (typeof targetPolicy?.retainTokens === 'number') {
    retainTokensRaw = targetPolicy.retainTokens
  } else if (typeof targetPolicy?.retainRatio === 'number') {
    retainTokensRaw = Math.floor(messageBudget * targetPolicy.retainRatio)
  } else if (typeof backend?.retainTokens === 'number') {
    retainTokensRaw = backend.retainTokens
  } else {
    retainTokensRaw = Math.floor(messageBudget * (backend?.retainRatio ?? DEFAULT_NATIVE_RETAIN_RATIO))
  }
  const retainTokens = Math.max(0, Math.min(retainTokensRaw, Math.floor(thresholdTokens * 0.9)))

  return {
    known: true,
    ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    contextWindow,
    reservedCompletionTokens,
    headroomTokens: headroom,
    thresholdRatio: ratio,
    thresholdTokens,
    retainTokens,
    ...(targetPolicy === undefined ? {} : { targetPolicy: { provider: targetPolicy.provider, model: targetPolicy.model } }),
    ...(backend === undefined ? {} : { backendRetainRatio: backend.retainRatio, backendRetainTokens: backend.retainTokens }),
    source: override !== undefined ? 'override' : backend === undefined ? 'defaults' : 'backend-config',
    at: now,
  }
}
