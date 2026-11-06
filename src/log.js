/**
 * Structured logging for the pre-compaction runtime.
 *
 * Every message goes to two places:
 *
 * 1. the host logger, as one `[pre-compact] message key=value` line (honouring
 *    the configured `logLevel`), and
 * 2. an in-memory ring buffer that keeps the most recent records regardless of
 *    the console level, so `/precompact logs` and
 *    `GET /api/pre-compact/logs` can show what happened before a problem was
 *    noticed without re-enabling debug logging and reproducing it.
 *
 * Message content is never logged. Field values are truncated so a pathological
 * error string cannot grow the buffer without bound.
 * @module dsh-pre-compact/log
 */

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 }

/** Default number of records kept in memory. */
export const DEFAULT_LOG_BUFFER_SIZE = 500

const MAX_STRING_LENGTH = 300
const MAX_ARRAY_ITEMS = 20
const MAX_DEPTH = 3

/** @param {Record<string, any>} fields */
export function formatFields(fields) {
  const parts = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value === null) {
      parts.push(`${key}=null`)
      continue
    }
    if (Array.isArray(value)) {
      parts.push(`${key}=[${value.join(',')}]`)
      continue
    }
    if (typeof value === 'string') {
      const rendered = /[\s"=]/.test(value) ? JSON.stringify(value) : value
      parts.push(`${key}=${rendered}`)
      continue
    }
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join(' ')
}

/**
 * Copy a log field value into an inert, bounded structure.
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function sanitizeValue(value, depth, seen) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value === undefined) return undefined
  if (depth >= MAX_DEPTH) return '[depth]'
  const object = /** @type {object} */ (value)
  if (seen.has(object)) return '[cyclic]'
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen))
      if (value.length > MAX_ARRAY_ITEMS) items.push(`…${value.length - MAX_ARRAY_ITEMS} more`)
      return items
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeValue(value.message, depth + 1, seen),
        ...(typeof value.code === 'string' || typeof value.code === 'number' ? { code: value.code } : {}),
      }
    }
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const sanitized = sanitizeValue(item, depth + 1, seen)
      if (sanitized !== undefined) out[key] = sanitized
    }
    return out
  } finally {
    seen.delete(object)
  }
}

/**
 * @param {Record<string, any> | undefined} fields
 * @returns {Record<string, any>}
 */
export function sanitizeFields(fields) {
  if (fields === null || typeof fields !== 'object') return {}
  /** @type {Record<string, any>} */
  const out = {}
  const seen = new WeakSet()
  for (const [key, value] of Object.entries(fields)) {
    const sanitized = sanitizeValue(value, 0, seen)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

/**
 * @param {any} ctx
 * @param {{ logLevel?: string, logBufferSize?: number }} config
 */
export function createLogger(ctx, config) {
  /** Current capacity, so a volatile settings change applies without a reload. */
  function capacity() {
    return Number.isFinite(config?.logBufferSize) ? Math.max(0, Math.round(config.logBufferSize)) : DEFAULT_LOG_BUFFER_SIZE
  }
  /** @type {Array<{ seq: number, at: number, level: string, event: string, fields: Record<string, any> }>} */
  const records = []
  let seq = 0

  /** @param {'debug'|'info'|'warn'|'error'} level @param {string} message @param {Record<string, any>} [fields] */
  function emit(level, message, fields) {
    // Read the level per call: `logLevel` is a volatile option, so the settings
    // page can change it on the running plugin.
    const threshold = LEVEL_ORDER[config?.logLevel] ?? LEVEL_ORDER.info
    if ((LEVEL_ORDER[level] ?? 20) >= threshold) {
      let line = `[pre-compact] ${message}`
      if (fields !== undefined) {
        const rendered = formatFields(fields)
        if (rendered.length > 0) line += ` ${rendered}`
      }
      const logger = ctx.logger
      try {
        const method = logger?.[level] ?? logger?.info
        if (typeof method === 'function') method.call(logger, line)
        else console[level === 'debug' ? 'log' : level](line)
      } catch {
        // Logging must never disturb the agent.
      }
    }
    // The ring buffer keeps every level: a debug trail recorded before the
    // problem is the whole point of `/precompact logs`.
    const size = capacity()
    if (size === 0) {
      if (records.length > 0) records.length = 0
      return
    }
    seq += 1
    records.push({ seq, at: Date.now(), level, event: String(message), fields: sanitizeFields(fields) })
    while (records.length > size) records.shift()
  }

  /**
   * Newest records, filtered and bounded.
   * @param {{ limit?: number, level?: string, sessionId?: string, sinceSeq?: number }} [options]
   * @returns {Array<Record<string, any>>}
   */
  function snapshot(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.round(options.limit))) : 100
    const minLevel = LEVEL_ORDER[options.level] ?? 0
    const sinceSeq = Number.isFinite(options.sinceSeq) ? options.sinceSeq : 0
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const selected = []
    for (let index = records.length - 1; index >= 0 && selected.length < limit; index -= 1) {
      const record = records[index]
      if (record.seq <= sinceSeq) break
      if ((LEVEL_ORDER[record.level] ?? 20) < minLevel) continue
      if (sessionId !== undefined && record.fields.session !== sessionId) continue
      selected.push(record)
    }
    return selected.reverse()
  }

  function clear() {
    records.length = 0
  }

  function stats() {
    return { capacity: capacity(), count: records.length, lastSeq: seq }
  }

  return {
    debug: (/** @type {string} */ message, /** @type {Record<string, any>} */ fields) => emit('debug', message, fields),
    info: (/** @type {string} */ message, /** @type {Record<string, any>} */ fields) => emit('info', message, fields),
    warn: (/** @type {string} */ message, /** @type {Record<string, any>} */ fields) => emit('warn', message, fields),
    error: (/** @type {string} */ message, /** @type {Record<string, any>} */ fields) => emit('error', message, fields),
    snapshot,
    clear,
    stats,
  }
}
