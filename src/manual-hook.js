/**
 * Manual-compaction hook.
 *
 * The ordinary `/compact` command calls `ctx.compaction.compactNow(agent,
 * signal, commandId)`, which runs the whole summarization inside
 * `agent.runMaintenance(...)`: new input waits, and a running turn reports
 * `busy`. This module wraps that single service method (per mounted backend
 * instance) so an explicit manual request takes the same off-critical-path
 * route as the automatic pre-compaction: summarize in the background, land the
 * result at the next safe boundary, and settle the caller with a host-shaped
 * `CompactionResult` (or a `ManualCompactionError`-shaped rejection).
 *
 * The hook delegates to the original method whenever the plugin is disabled,
 * paused, in dry-run mode, or when the engine cannot be wrapped — the native
 * `/compact` behavior is never lost.
 * @module dsh-async-compaction/manual-hook
 */

import { compactionServiceOf } from './native-policy.js'
import { errorChain } from './util.js'

/**
 * @param {object} input
 * @param {any} input.ctx
 * @param {import('./coordinator.js').createRuntime extends (...args: any) => infer R ? R : any} input.runtime
 * @param {ReturnType<import('./log.js').createLogger>} input.log
 */
export function createManualHook({ ctx, runtime, log }) {
  /** @type {WeakMap<object, Function>} */
  const originals = new WeakMap()
  /** Whether the instance owned `compactNow` before the patch (vs. inheriting it from its prototype). */
  const ownMethodBefore = new WeakMap()
  /** @type {object[]} */
  const patched = []
  let active = true

  /** @param {object} engine */
  function patch(engine) {
    if (originals.has(engine)) return true
    if (typeof engine.compactNow !== 'function') return false
    const original = engine.compactNow
    const wrapper = function backgroundCompactNow(agent, signal, sourceCommandId) {
      if (active && runtime.shouldHookManual()) {
        try {
          const outcome = runtime.tryManualCompaction(agent, { signal, sourceCommandId })
          if (outcome !== undefined) {
            log.info('manual compaction delegated to the background pipeline', {
              session: agent?.session?.id,
              command: sourceCommandId,
            })
            return outcome
          }
        } catch (error) {
          log.warn('manual compaction hook failed; falling back to the mounted backend', {
            session: agent?.session?.id,
            error: errorChain(error),
          })
        }
      }
      return original.call(engine, agent, signal, sourceCommandId)
    }
    try {
      ownMethodBefore.set(engine, Object.hasOwn(engine, 'compactNow'))
      engine.compactNow = wrapper
      originals.set(engine, original)
      patched.push(engine)
      runtime.setManualHookState('active', engine.constructor?.name ?? 'compaction')
      log.info('hooked the manual compaction entry point', {
        backend: engine.constructor?.name ?? 'compaction',
      })
      return true
    } catch (error) {
      runtime.setManualHookState('patch-failed', errorChain(error))
      log.warn('cannot hook the manual compaction entry point; /compact keeps its native behavior', {
        error: errorChain(error),
      })
      return false
    }
  }

  /**
   * Patch the compaction service reachable for one agent, if any.
   * @param {any} agent
   */
  function ensure(agent) {
    if (!active) return false
    let engine
    try {
      engine = compactionServiceOf(ctx, agent)
    } catch (error) {
      log.debug('cannot resolve the compaction backend', { error: errorChain(error) })
      return false
    }
    if (engine === undefined || engine === null || typeof engine !== 'object') {
      runtime.setManualHookState('no-backend')
      return false
    }
    return patch(engine)
  }

  /** Restore every wrapped method (plugin unload). */
  function restore() {
    active = false
    for (const engine of patched.splice(0)) {
      const original = originals.get(engine)
      if (original === undefined) continue
      try {
        // Only write an own property back when the instance had one before;
        // otherwise deleting reveals the prototype method again (so a later
        // backend upgrade of the prototype is not shadowed).
        if (ownMethodBefore.get(engine) === true) engine.compactNow = original
        else delete engine.compactNow
      } catch {
        // Best effort; the wrapper also checks `active` and delegates.
      }
      originals.delete(engine)
      ownMethodBefore.delete(engine)
    }
    runtime.setManualHookState('restored')
  }

  return { ensure, restore, get hooked() { return patched.length } }
}
