/**
 * Small dependency-free helpers shared by the pre-compaction plugin.
 *
 * The plugin intentionally imports nothing outside `node:` builtins and its own
 * files: a locally linked DSH bundle cannot resolve the host's `@deepseek-ai/*`
 * packages (see README "Known limitations").
 * @module dsh-async-compaction/util
 */

/** @param {number} n @param {number} lo @param {number} hi */
export function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi)
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is number} */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** @param {unknown} value @param {number} fallback */
export function numberOr(value, fallback) {
  return isFiniteNumber(value) ? value : fallback
}

/** Round to at most `digits` decimals for logs and status output. @param {number} n @param {number} [digits] */
export function round(n, digits = 3) {
  const scale = 10 ** digits
  return Math.round(n * scale) / scale
}

/** @param {readonly number[]} a @param {readonly number[]} b */
export function numberArraysEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Render an error and its causes into one diagnostic string, mirroring the
 * host's `errorChain()` behavior closely enough for `compaction/end.error`.
 * @param {unknown} value
 * @returns {string}
 */
export function errorChain(value) {
  const seen = new Set()
  /** @param {unknown} current @returns {string} */
  const render = (current) => {
    if (isRecord(current) || typeof current === 'object') {
      if (seen.has(current)) return '<circular cause>'
      seen.add(current)
    }
    try {
      if (!(current instanceof Error)) {
        if (isRecord(current) && typeof current.message === 'string') return current.message
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members =
        current instanceof AggregateError && current.errors.length > 0
          ? ` [${current.errors.map(render).join('; ')}]`
          : ''
      const cause = current.cause === undefined || current.cause === null ? '' : render(current.cause)
      return `${message}${members}${cause === '' || cause === message ? '' : `: ${cause}`}`
    } catch {
      return '<unrenderable value>'
    }
  }
  return render(value)
}

/** Current wall-clock milliseconds. */
export function nowMs() {
  return Date.now()
}

/**
 * Freeze one message-like value enough that the session snapshot cannot be
 * mutated by an accidental reference: content blocks and the source object are
 * frozen, the message object itself is frozen, arrays are copied.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function freezeMessage(value) {
  if (!isRecord(value)) return value
  if (Array.isArray(value.content)) {
    for (const block of value.content) if (isRecord(block)) Object.freeze(block)
    Object.freeze(value.content)
  }
  if (isRecord(value.source)) Object.freeze(value.source)
  return Object.freeze(value)
}

/** Monotonic token using `performance.now` when available. */
export function monotonicMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}
