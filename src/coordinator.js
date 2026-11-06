/**
 * Per-session orchestration for background pre-compaction.
 *
 * One coordinator exists per plugin instance. It owns:
 * - sampling of context usage and growth,
 * - trigger evaluation (fixed / adaptive),
 * - the background summarization task and its state machine,
 * - validation and atomic commit at safe execution boundaries,
 * - cancellation and staleness handling.
 *
 * Nothing in here awaits a model call from an agent boundary: hooks only do
 * synchronous work plus fire-and-forget sampling/starting.
 * @module dsh-async-compaction/coordinator
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from './log.js'
import { evaluateTrigger, createDurationTracker, createGrowthTracker, usageRatio } from './policy.js'
import { resolveNativePolicy, compactionServiceOf, routedTargetOf } from './native-policy.js'
import { createSnapshot, describeSnapshot } from './snapshot.js'
import { prepareCheckpoint, runSummarization } from './summarizer.js'
import { appendCompaction, validateCommit, CommitError, compactionLockActive, inspectEntryState, MIN_REDUCTION_RATIO } from './commit.js'
import { isSurfaceEventType } from './surface.js'
import { errorChain, monotonicMs, nowMs, round } from './util.js'
import {
  EMA_ALPHA,
  GROWTH_SAMPLING_INTERVAL_MS,
  GROWTH_WINDOW_MS,
  COMPRESSION_TIME_MULTIPLIER,
  DEFAULT_COMPRESSION_SECONDS,
} from './internal-policy.js'

/** Background task state machine. */
export const PHASE = Object.freeze({
  IDLE: 'IDLE',
  SNAPSHOTTING: 'SNAPSHOTTING',
  COMPRESSING: 'COMPRESSING',
  READY: 'READY',
  APPLYING: 'APPLYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  STALE: 'STALE',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
})

/** Boundaries at which a prepared result may be applied. */
const BOUNDARIES = Object.freeze({ PRE_STEP: 'pre-step', TURN_STOPPING: 'turn-stopping', IDLE: 'idle' })

/** Combine abort signals without requiring `AbortSignal.any` (Node 20.3+). @param {Array<AbortSignal | undefined>} signals */
function combineSignals(signals) {
  const valid = signals.filter((signal) => signal !== undefined && signal !== null)
  if (valid.length === 1) return valid[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid)
  const controller = new AbortController()
  for (const signal of valid) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * @param {any} ctx
 * @param {Record<string, any>} config
 * @param {string[]} [warnings]
 */
export function createRuntime(ctx, config, warnings = []) {
  const log = createLogger(ctx, config)
  const capacityCache = new Map()
  /** @type {Map<string, any>} */
  const states = new Map()
  const disposeController = new AbortController()
  let disposed = false
  // Per-session concurrency is structural: `evaluate()` returns while a task or
  // a ready result exists, so one session never runs two summaries. There is no
  // process-wide limit — different sessions may summarize at the same time.
  let timerStop
  let evaluateSequence = 0
  let manualHookState = { state: 'unknown', detail: undefined }

  for (const warning of warnings) log.warn(`configuration: ${warning}`)

  // One activation record makes it obvious from the host log whether the
  // plugin is live and which optional services it found.
  try {
    log.info('plugin active', {
      mode: config.triggerMode,
      fixed_threshold: config.fixedThreshold,
      apply_strategy: config.applyStrategy,
      dry_run: config.dryRun,
      has_token_meter: ctx.get?.('tokenMeter') !== undefined,
      has_timer: ctx.get?.('timer') !== undefined,
      has_commands: ctx.get?.('commands') !== undefined,
      has_compaction: ctx.get?.('compaction') !== undefined,
      has_agent_presets: ctx.get?.('agentPresets') !== undefined,
    })
  } catch (error) {
    log.warn('activation probe failed', { error: errorChain(error) })
  }

  // ---------------------------------------------------------------- helpers
  /** Context samples kept per session (for the visualization). */
  const SAMPLE_CAPACITY = 120
  /** Applied compactions kept per session (for the visualization). */
  const HISTORY_CAPACITY = 30

  /** @param {any} state @param {{ at: number, tokens: number, trigger: number|null, native: number|null, turn?: number|null, step?: number|null }} sample */
  function recordSample(state, sample) {
    if (!Number.isFinite(sample?.tokens)) return
    const entry = {
      at: sample.at,
      tokens: Math.round(sample.tokens),
      trigger: typeof sample.trigger === 'number' ? Math.round(sample.trigger) : null,
      native: typeof sample.native === 'number' ? Math.round(sample.native) : null,
      turn: Number.isFinite(sample.turn) ? sample.turn : null,
      step: Number.isFinite(sample.step) ? sample.step : null,
    }
    state.samples.push(entry)
    while (state.samples.length > SAMPLE_CAPACITY) state.samples.shift()
    // The chart needs one point per step, not the newest 120 raw samples which
    // a single busy step can fill. Upsert by step so older steps survive.
    if (entry.step !== null) {
      const existing = state.steps.findIndex((item) => item.step === entry.step)
      if (existing === -1) state.steps.push(entry)
      else state.steps[existing] = entry
      state.steps.sort((left, right) => left.step - right.step)
    }
  }

  /** @param {any} state @param {Record<string, any>} entry */
  function recordHistory(state, entry) {
    state.history.push(entry)
    while (state.history.length > HISTORY_CAPACITY) state.history.shift()
  }

  function sessionOf(agent) {
    return agent?.session
  }

  function stateFor(session) {
    let state = states.get(session.id)
    if (state === undefined) {
      state = {
        sessionId: session.id,
        session,
        agent: undefined,
        phase: PHASE.IDLE,
        active: null,
        ready: null,
        manual: null,
        growth: createGrowthTracker({ windowMs: GROWTH_WINDOW_MS, alpha: EMA_ALPHA }),
        duration: createDurationTracker({ alpha: EMA_ALPHA }),
        native: { known: false },
        lastMeasurement: null,
        lastMeasureError: null,
        lastMeasurementAt: 0,
        lastActivityAt: nowMs(),
        lastEvaluatedAt: 0,
        lastStartAt: 0,
        lastSkip: null,
        lastDecision: null,
        lastOutcome: null,
        lastFailure: null,
        evaluating: null,
        applying: false,
        invalidatedReason: undefined,
        retriggerFloor: 0,
        // Bounded series for the sidebar visualization.
        samples: [],
        steps: [],
        history: [],
        // Latest adaptive target, kept as a warm start while post-compaction
        // growth data is still rebuilding.
        lastAdaptiveTarget: null,
        // Latest turn/step observed on `turn/start` and `step/start`.
        turn: null,
        step: null,
        generation: 0,
        createdAt: nowMs(),
      }
      states.set(session.id, state)
      pruneStates()
    }
    return state
  }

  function pruneStates() {
    if (states.size <= 32) return
    const candidates = [...states.values()]
      .filter((state) => state.active === null && state.ready === null && state.evaluating === null && state.manual === null)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    for (const state of candidates.slice(0, states.size - 32)) {
      if (state.active === null && state.ready === null && state.manual === null) states.delete(state.sessionId)
    }
  }

  function isLive(state) {
    const sessions = ctx.get?.('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return true
    try {
      return sessions.get(state.sessionId) === state.session
    } catch {
      return false
    }
  }

  function attachedAgent(state) {
    if (state.agent !== undefined && state.agent !== null) {
      try {
        if (state.agent.session === state.session) return state.agent
      } catch {
        // fall through
      }
    }
    const agents = ctx.get?.('agents')
    try {
      return agents?.get?.(state.sessionId)
    } catch {
      return undefined
    }
  }

  function recordMeasureError(state, error) {
    state.lastMeasureError = { at: nowMs(), message: errorChain(error) }
    state.lastMeasurement = null
    state.lastMeasurementAt = 0
    log.warn('context measurement failed; skipping trigger evaluation', {
      session: state.sessionId,
      error: errorChain(error),
    })
  }

  // ------------------------------------------------------ manual /compact
  /**
   * Build an error shaped like the host's `ManualCompactionError` (stable
   * `name`/`code`), without importing the host package.
   * @param {string} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  function manualError(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause })
    error.name = 'ManualCompactionError'
    error.code = code
    return error
  }

  /** Release the manual request's abort listener. @param {any} manual */
  function clearManualBindings(manual) {
    if (manual.timerStop !== undefined) {
      try {
        manual.timerStop()
      } catch {
        // timer cleanup must never throw
      }
      manual.timerStop = undefined
    }
    if (manual.signal !== undefined && manual.onAbort !== undefined) {
      try {
        manual.signal.removeEventListener('abort', manual.onAbort)
      } catch {
        // ignore
      }
      manual.onAbort = undefined
    }
  }

  /** Settle one pending manual request exactly once. @param {any} state @param {{ kind: 'success', result: any } | { kind: 'error', error: Error }} outcome */
  function settleManual(state, outcome) {
    const manual = state.manual
    if (manual === null) return
    state.manual = null
    clearManualBindings(manual)
    if (outcome.kind === 'success') manual.resolve(outcome.result)
    else manual.reject(outcome.error)
  }

  /** @param {any} state @param {string} code @param {string} message */
  function rejectManual(state, code, message) {
    settleManual(state, { kind: 'error', error: manualError(code, message) })
  }

  /**
   * Abandon the in-flight summarization of a manual request so a late
   * completion can never land after the caller already got a cancellation.
   * @param {any} state
   * @param {string} reason
   */
  function cancelActiveManualTask(state, reason) {
    const task = state.active
    if (task === null || task.manual !== true) return
    state.generation += 1
    task.abandoned = true
    try {
      task.abort.abort(reason)
    } catch {
      // ignore
    }
    if (state.active === task) state.active = null
  }

  /** Map an internal commit/summarization failure code to the host's manual taxonomy. */
  function manualFailureOf(code, detail) {
    const suffix = detail === undefined || detail === '' ? '' : `: ${detail}`
    switch (code) {
      case 'locked':
        return { code: 'busy', message: `Compaction is unavailable because another compaction is in progress${suffix}` }
      case 'span-missing':
      case 'span-changed':
      case 'changed':
      case 'span-resized':
      case 'span-inverted':
      case 'span-unpriced':
      case 'span-repriced':
      case 'surface-rewritten':
      case 'surface-replaced':
      case 'unbalanced-start':
      case 'unbalanced-end':
        return { code: 'changed', message: `The history selected for compaction changed before it could be replaced${suffix}` }
      case 'not-smaller':
      case 'small-reduction':
      case 'empty-range':
      case 'summarization-failed':
        return { code: 'summary', message: `Compaction could not produce a useful summary${suffix}` }
      case 'session-gone':
      case 'session-mismatch':
        return { code: 'cancelled', message: `Compaction cancelled because the session went away${suffix}` }
      case 'commit-failed':
        return { code: 'commit', message: `Compaction did not finish cleanly${suffix}` }
      case 'aborted':
        return { code: 'cancelled', message: 'Compaction cancelled.' }
      case 'timeout':
        return { code: 'cancelled', message: 'Background compaction timed out before it could be applied.' }
      default:
        return { code: 'summary', message: `Compaction failed${suffix}` }
    }
  }

  /** Build the host-compatible `CompactionResult` for a landed manual request. */
  function manualResultOf(snapshot, prepared, committed) {
    return {
      compactionId: committed.compactionId,
      ...(typeof prepared.sourceCommandId === 'string' && prepared.sourceCommandId.length > 0
        ? { sourceCommandId: prepared.sourceCommandId }
        : {}),
      startSeq: committed.startSeq,
      summarySeq: committed.summarySeq,
      endSeq: committed.endSeq,
      summary: prepared.summary,
      shadowedRange: { start: snapshot.startSeq, end: snapshot.endSeq },
      shadowedSeqs: [...snapshot.shadowedSeqs],
      shadowedTokenCount: snapshot.shadowedHeuristicTokens,
      turn: committed.turn,
      manual: true,
    }
  }

  /**
   * Whether this runtime should take over the host's manual compaction entry
   * point instead of delegating to the mounted backend.
   */
  function shouldHookManual() {
    return disposed !== true && config.enabled === true && config.dryRun !== true && config.hookManualCompact !== false
  }

  /**
   * Take over one manual compaction request (`/compact`, a programmatic
   * `ctx.compaction.compactNow` call, …).
   *
   * The promise settles once the background summary has been applied at a safe
   * boundary (resolving to a `CompactionResult`, or `null` when there is no
   * compactable history), or rejects with `error.name = 'ManualCompactionError'`
   * and a host-compatible `error.code`.
   *
   * @param {any} agent
   * @param {{ signal?: AbortSignal, sourceCommandId?: string }} [options]
   * @returns {Promise<any> | undefined} `undefined` means “delegate to the
   *   mounted backend”; the caller must call the original method then.
   */
  function tryManualCompaction(agent, options = {}) {
    if (!shouldHookManual()) return undefined
    const session = sessionOf(agent)
    if (session === undefined || session === null) return undefined
    const state = stateFor(session)
    state.agent = agent
    state.lastActivityAt = nowMs()

    if (state.manual !== null) {
      return Promise.reject(manualError('busy', 'Compaction is already queued for this session.'))
    }
    const signal = options.signal
    if (signal !== undefined && signal.aborted) return Promise.reject(manualError('cancelled', 'Compaction cancelled.'))

    const deferred = Promise.withResolvers()
    const manual = {
      id: randomUUID(),
      requestedAt: nowMs(),
      sourceCommandId: typeof options.sourceCommandId === 'string' ? options.sourceCommandId : undefined,
      signal,
      onAbort: undefined,
      timerStop: undefined,
      retried: false,
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
    }
    state.manual = manual

    if (signal !== undefined) {
      manual.onAbort = () => {
        if (state.manual !== manual) return
        cancelActiveManualTask(state, 'manual-cancelled')
        const ready = state.ready
        if (ready !== null && ready.manual === true) discard(state, PHASE.CANCELLED, 'manual-cancelled')
        rejectManual(state, 'cancelled', 'Compaction cancelled.')
      }
      signal.addEventListener('abort', manual.onAbort, { once: true })
    }

    // No plugin-owned deadline: a manual `/compact` follows native compaction
    // semantics, and native owns the request's lifecycle. The request settles
    // when the background result commits, when the caller aborts, or on dispose.
    // An explicit request must not silently reuse automatic work: automatic
    // results inherited the backend's retention and may fail the automatic
    // minimum-reduction gate, while `/compact` promises the native manual
    // semantics (retain only the last surface node, only “smaller” required).
    supersedeAutomaticWork(state)

    log.info('manual compaction request accepted', {
      session: session.id,
      request: manual.id.slice(0, 8),
      command: manual.sourceCommandId,
      transport: config.dryRun ? 'dry-run' : 'async',
    })

    // state.manual now owns the session; a fresh manual task is the only work
    // allowed to settle it.
    void beginManualTask(state, agent)
    return manual.promise
  }

  /**
   * Ask the host to flush the session after a manual commit, matching the
   * native `/compact` path's durability checkpoint. This stays off the request
   * path: the command resolves on the commit, and a flush failure is logged.
   * @param {any} session
   */
  function flushSession(session) {
    try {
      const sessions = ctx.get?.('sessions')
      const flush = sessions?.flush
      if (typeof flush !== 'function') return
      void Promise.resolve(flush.call(sessions, session)).catch((error) => {
        log.warn('manual compaction flush failed', { session: session.id, error: errorChain(error) })
      })
    } catch (error) {
      log.warn('manual compaction flush failed', { session: session.id, error: errorChain(error) })
    }
  }

  /**
   * Drop automatic work (a ready result or an in-flight summary) so an explicit
   * manual request runs under its own retention semantics instead of inheriting
   * the automatic ones.
   * @param {any} state
   */
  function supersedeAutomaticWork(state) {
    let superseded = false
    if (state.ready !== null && state.ready.manual !== true) {
      discard(state, PHASE.IDLE, 'manual-request-supersedes')
      superseded = true
    }
    if (state.active !== null && state.active.manual !== true) {
      const task = state.active
      // Abandon before aborting: the task's error path must not touch manual
      // state or the session result.
      task.abandoned = true
      state.generation += 1
      state.active = null
      state.phase = PHASE.IDLE
      try {
        task.abort.abort('manual-request')
      } catch {
        // ignore
      }
      superseded = true
    }
    if (superseded) {
      log.info('manual request superseded automatic pre-compaction work', { session: state.sessionId })
    }
  }

  /** Start the manual snapshot + background summarization. @param {any} state @param {any} agent */
  async function beginManualTask(state, agent) {
    const manual = state.manual
    if (manual === null) return
    try {
      if (!isLive(state)) {
        rejectManual(state, 'cancelled', 'Compaction cancelled because the session is no longer live.')
        return
      }
      const meter = ctx.get?.('tokenMeter')
      if (meter === undefined || meter === null || typeof meter.measure !== 'function') {
        rejectManual(state, 'summary', 'No token meter is mounted, so compaction cannot measure the context.')
        return
      }
      const at = nowMs()
      let measurement
      try {
        measurement = meter.measure(state.session)
      } catch (error) {
        rejectManual(state, 'summary', `Compaction cannot measure the context: ${errorChain(error)}`)
        return
      }
      state.growth.addSample(at, measurement.totalTokens)
      state.lastMeasurement = {
        at,
        totalTokens: measurement.totalTokens,
        surfaceTokens: measurement.surfaceTokens,
        nodeCount: measurement.nodes.length,
      }
      state.lastMeasurementAt = at
      state.lastMeasureError = null
      const native = await resolveNativePolicy({ ctx, session: state.session, agent, config, cache: capacityCache, now: at })
      state.native = native
      if (state.manual !== manual || disposed) return
      if (state.active !== null || state.ready !== null) {
        // Another path produced a result while the policy was resolving; the
        // manual request settles from that result.
        if (state.ready !== null) applyReady(state, BOUNDARIES.IDLE)
        return
      }
      await startTask(state, {
        measurement,
        native,
        decision: { mode: 'manual', triggerTokens: 0, triggerRatio: null, derivation: { request: manual.id.slice(0, 8) } },
        agent,
        reason: 'manual',
        at,
        manual: true,
        sourceCommandId: manual.sourceCommandId,
      })
    } catch (error) {
      log.warn('manual compaction could not start', { session: state.sessionId, error: errorChain(error) })
      if (state.manual === manual) rejectManual(state, 'summary', `Compaction could not start: ${errorChain(error)}`)
    }
  }

  /** @param {any} state @param {any} manual @param {{ code: string, message: string }} failure */
  function failManual(state, manual, failure) {
    if (state.manual !== manual) return
    const retryable = failure.code === 'changed'
    if (retryable && manual.retried !== true && disposed !== true && isLive(state)) {
      manual.retried = true
      const agent = attachedAgent(state)
      if (agent !== undefined) {
        log.info('manual compaction retrying after the selected history changed', {
          session: state.sessionId,
          request: manual.id.slice(0, 8),
        })
        void beginManualTask(state, agent)
        return
      }
    }
    rejectManual(state, failure.code, failure.message)
  }


  // ---------------------------------------------------------- trigger + task
  /**
   * Measure, evaluate the policy and, when due, start a background task.
   * Never throws into the caller.
   * @param {any} state
   * @param {string} reason
   */
  function evaluate(state, reason) {
    if (disposed || !config.enabled) return null
    if (state.evaluating !== null) return state.evaluating
    const sequence = ++evaluateSequence
    const task = (async () => {
      try {
        const session = state.session
        if (!isLive(state)) {
          discard(state, PHASE.STALE, 'session-gone')
          return
        }
        if (state.ready !== null || state.active !== null) return
        const meter = ctx.get?.('tokenMeter')
        if (meter === undefined || typeof meter.measure !== 'function') {
          log.warn('no token meter is mounted; pre-compaction is inactive')
          config.enabled = false
          return
        }
        let measurement
        const at = nowMs()
        try {
          measurement = meter.measure(session)
        } catch (error) {
          recordMeasureError(state, error)
          return
        }
        if (!measurement || typeof measurement.totalTokens !== 'number' || !Array.isArray(measurement.nodes)) {
          recordMeasureError(state, new Error('token meter returned no measurement'))
          return
        }
        state.growth.addSample(at, measurement.totalTokens)
        state.lastMeasurement = {
          at,
          totalTokens: measurement.totalTokens,
          surfaceTokens: measurement.surfaceTokens,
          nodeCount: measurement.nodes.length,
        }
        state.lastMeasurementAt = at
        state.lastMeasureError = null
        state.lastEvaluatedAt = at

        const agent = attachedAgent(state)
        const native = await resolveNativePolicy({
          ctx,
          session,
          agent,
          config,
          cache: capacityCache,
          now: at,
        })
        state.native = native

        const decision = evaluateTrigger({
          config,
          native,
          totalTokens: measurement.totalTokens,
          growth: state.growth.read(at),
          duration: state.duration.predict(DEFAULT_COMPRESSION_SECONDS, COMPRESSION_TIME_MULTIPLIER),
          fresh: true,
          warmStart: state.lastAdaptiveTarget,
        })
        state.lastDecision = {
          at,
          due: decision.due,
          reason: decision.reason,
          mode: decision.mode,
          triggerTokens: decision.triggerTokens,
          triggerRatio: decision.triggerRatio,
          dataComplete: decision.dataComplete,
          derivation: decision.derivation,
          totalTokens: measurement.totalTokens,
          contextWindow: decision.contextWindow,
        }
        // Keep the last fully-predicted adaptive target. After a compaction the
        // growth tracker is empty, and falling straight back to the configured
        // fallback (65%) would contradict the 75% the model had just derived.
        if (decision.mode === 'adaptive' && decision.dataComplete === true && Number.isFinite(decision.triggerTokens)) {
          state.lastAdaptiveTarget = {
            at,
            triggerTokens: decision.triggerTokens,
            triggerRatio: decision.triggerRatio,
          }
        }
        recordSample(state, {
          at,
          tokens: measurement.totalTokens,
          trigger: decision.triggerTokens,
          native: native.thresholdTokens,
          turn: state.turn,
          step: state.step,
        })

        if (!decision.due) return

        // Anti-thrash floor: a compaction that could not free enough to leave
        // the trigger zone must not re-trigger immediately; require the session
        // to grow past the post-apply size first.
        if (state.retriggerFloor > 0) {
          if (measurement.totalTokens < (decision.triggerTokens ?? 0)) {
            state.retriggerFloor = 0
          } else if (measurement.totalTokens < state.retriggerFloor) {
            state.lastSkip = {
              at,
              reason: 'retrigger-floor',
              detail: `tokens ${measurement.totalTokens} < floor ${state.retriggerFloor}`,
            }
            log.debug('trigger deferred: anti-thrash floor', {
              session: state.sessionId,
              tokens: measurement.totalTokens,
              floor: state.retriggerFloor,
            })
            return
          } else {
            state.retriggerFloor = 0
          }
        }
        if (state.lastStartAt > 0 && at - state.lastStartAt < config.minInterval) {
          log.debug('trigger deferred: minimum interval not elapsed', {
            session: state.sessionId,
            min_interval_ms: config.minInterval,
          })
          return
        }
        if (agent === undefined) {
          log.debug('trigger deferred: no live agent', { session: state.sessionId })
          return
        }
        // A manual request owns this session until it settles.
        if (state.manual !== null) return
        const engine = compactionServiceOf(ctx, agent)
        if (engine === undefined) {
          log.debug('trigger deferred: no compaction backend mounted', { session: state.sessionId })
          return
        }
        let entry
        try {
          entry = inspectEntryState(session)
        } catch (error) {
          log.warn('cannot inspect the compaction entry state', { session: state.sessionId, error: errorChain(error) })
          return
        }
        if (compactionLockActive(entry)) {
          log.debug('trigger deferred: compaction lock is active', {
            session: state.sessionId,
            lock_seq: entry.unmatchedCompactionStart?.seq,
          })
          return
        }

        // Deliberately not awaited: the summarization must run in the
        // background, parallel to the agent's own work.
        void startTask(state, { measurement, native, decision, agent, reason, at })
      } catch (error) {
        log.warn(`pre-compaction evaluation failed (${reason})`, { session: state.sessionId, error: errorChain(error) })
      }
    })().finally(() => {
      // The guard covers evaluation only; an already-started background task is
      // tracked by `state.active`, which keeps later evaluations cheap.
      state.evaluating = null
    })
    state.evaluating = task
    void sequence
    return task
  }

  /**
   * Build the snapshot and run summarization in the background.
   * @param {any} state
   * @param {{ measurement: any, native: any, decision: any, agent: any, reason: string, at: number, manual?: boolean, sourceCommandId?: string }} input
   */
  async function startTask(state, { measurement, native, decision, agent, reason, at, manual = false, sourceCommandId }) {
    const session = state.session
    const pendingManual = state.manual
    state.phase = PHASE.SNAPSHOTTING
    state.lastSkip = null
    let built
    try {
      built = createSnapshot({
        session,
        measurement,
        config,
        native,
        route: routedTargetOf(session),
        triggerTokens: decision.triggerTokens ?? 0,
        now: at,
        manual,
      })
    } catch (error) {
      state.phase = PHASE.IDLE
      state.lastSkip = { at, reason: 'snapshot-failed', detail: errorChain(error) }
      log.warn('cannot build the pre-compaction snapshot', { session: session.id, error: errorChain(error) })
      if (manual) failManual(state, pendingManual, manualFailureOf('summarization-failed', errorChain(error)))
      else if (state.manual !== null) failManual(state, state.manual, manualFailureOf('summarization-failed', errorChain(error)))
      return
    }
    if (built.skip !== undefined) {
      state.phase = PHASE.IDLE
      state.lastSkip = { at, reason: built.skip, detail: built.detail }
      log.debug(`pre-compaction skipped: ${built.skip}`, { session: session.id })
      if (manual) settleManual(state, { kind: 'success', result: null })
      else if (state.manual !== null) {
        // An automatic task may refuse a range the manual (“keep almost
        // nothing”) policy would accept; retry once under manual semantics.
        const manualAgent = attachedAgent(state)
        if (manualAgent !== undefined) void beginManualTask(state, manualAgent)
        else rejectManual(state, 'summary', 'Compaction cannot start because the session has no attached agent.')
      }
      return
    }

    const snapshot = built.snapshot
    const task = {
      id: snapshot.id,
      snapshot,
      abort: new AbortController(),
      startedAt: at,
      startedAtMonotonic: monotonicMs(),
      signal: undefined,
      manual,
      sourceCommandId,
      abandoned: false,
      generation: state.generation,
      // Snapshot-time turn/step: a new turn may start while the summary is
      // running, but the applied compaction belongs to where it was decided.
      turn: state.turn ?? null,
      step: state.step ?? null,
    }
    const taskGeneration = task.generation
    try {
      task.signal = combineSignals([task.abort.signal, disposeController.signal])
      state.active = task
      state.phase = PHASE.COMPRESSING
      state.lastStartAt = at
      state.invalidatedReason = undefined
      const fields = {
        session: session.id,
        task: task.id.slice(0, 8),
        trigger: reason,
        mode: decision.mode,
        total_tokens: measurement.totalTokens,
        trigger_tokens: decision.triggerTokens,
        trigger_ratio: decision.triggerRatio,
        native_threshold: native.thresholdTokens,
        native_source: native.source,
        dry_run: config.dryRun,
        manual,
        ...describeSnapshot(snapshot),
      }
      log.info(manual ? 'manual background compaction started' : 'background pre-compaction started', fields)

      const result = await runSummarization({ ctx, config, agent, snapshot, signal: task.signal, log })
      if (task.abandoned === true || state.generation !== taskGeneration || disposed) {
        log.debug('discarding a summarization that lost its generation', {
          session: session.id,
          task: task.id.slice(0, 8),
        })
        return
      }
      const compactionId = randomUUID()
      const prepared = {
        ...result,
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        ...prepareCheckpoint(ctx.get?.('tokenMeter'), compactionId, result.summary, sourceCommandId),
      }
      if (!(prepared.framedTokens < snapshot.shadowedRouteTokens)) {
        throw new CommitError('not-smaller', 'the framed summary is not smaller than the shadowed range', {
          framedTokens: prepared.framedTokens,
          shadowedRouteTokens: snapshot.shadowedRouteTokens,
        })
      }
      const reduction = (snapshot.shadowedRouteTokens - prepared.framedTokens) / snapshot.shadowedRouteTokens
      // `/compact` semantics: the host only requires the summary to be smaller,
      // so the plugin's own extra margin does not reject a manual request.
      if (!manual && reduction < MIN_REDUCTION_RATIO) {
        throw new CommitError('small-reduction', 'the framed summary does not free enough context', {
          reduction: round(reduction, 4),
          required: MIN_REDUCTION_RATIO,
        })
      }
      const durationMs = monotonicMs() - task.startedAtMonotonic
      state.duration.add(durationMs / 1000)
      if (state.active === task) state.active = null
      state.ready = { snapshot, prepared, finishedAt: nowMs(), durationMs, mode: decision.mode, trigger: reason, manual, turn: task.turn, step: task.step }
      state.phase = PHASE.READY
      log.info(manual ? 'manual background compaction ready' : 'background pre-compaction ready', {
        session: session.id,
        task: task.id.slice(0, 8),
        duration_ms: Math.round(durationMs),
        shadowed_tokens: snapshot.shadowedRouteTokens,
        framed_tokens: prepared.framedTokens,
        reduction: round(reduction, 4),
        provider: prepared.provider,
        model: prepared.model,
        manual,
      })
      // An explicit request wants the result as soon as it is safe; an idle
      // agent can take it right now, a running one at its next step boundary.
      if (state.manual !== null) applyReady(state, BOUNDARIES.IDLE)
    } catch (error) {
      if (task.abandoned === true || state.generation !== taskGeneration || disposed) {
        // An invalidation (native compaction, surface replacement, unload) or a
        // newer task owns this session now: settle nothing and touch no state.
        if (state.active === task) state.active = null
        log.debug('abandoned summarization settled late', { session: session.id, task: task.id.slice(0, 8) })
        return
      }
      if (state.active === task) state.active = null
      const aborted = task.signal?.aborted === true || error?.name === 'AbortError'
      const invalidated = state.invalidatedReason
      let failure
      if (invalidated !== undefined) {
        state.phase = PHASE.STALE
        state.lastOutcome = { state: PHASE.STALE, at: nowMs(), reason: invalidated, task: task.id.slice(0, 8) }
        failure = manualFailureOf('changed', invalidated)
        log.info('background pre-compaction abandoned after invalidation', {
          session: session.id,
          task: task.id.slice(0, 8),
          reason: invalidated,
        })
      } else if (aborted) {
        state.phase = PHASE.CANCELLED
        state.lastOutcome = { state: PHASE.CANCELLED, at: nowMs(), reason: 'aborted', task: task.id.slice(0, 8) }
        failure = manualFailureOf('aborted')
        log.info('background pre-compaction cancelled', { session: session.id, task: task.id.slice(0, 8) })
      } else {
        state.phase = PHASE.FAILED
        const code = error instanceof CommitError ? error.code : 'summarization-failed'
        state.lastFailure = {
          at: nowMs(),
          task: task.id.slice(0, 8),
          code,
          message: errorChain(error),
        }
        failure = manualFailureOf(code, errorChain(error))
        log.warn('background pre-compaction failed; the native compaction remains the backstop', {
          session: session.id,
          task: task.id.slice(0, 8),
          error: errorChain(error),
        })
      }
      if (manual) failManual(state, pendingManual, failure)
      else if (state.manual !== null) failManual(state, state.manual, failure)
    } finally {
      state.invalidatedReason = undefined
    }
  }

  // ------------------------------------------------------------------- apply
  /**
   * @param {'safe' | 'end-of-turn' | 'idle-only'} strategy
   * @param {string} boundary
   * @returns {boolean}
   */
  function mayApplyAt(strategy, boundary) {
    if (strategy === 'idle-only') return boundary === BOUNDARIES.IDLE
    if (strategy === 'end-of-turn') return boundary === BOUNDARIES.TURN_STOPPING || boundary === BOUNDARIES.IDLE
    return true
  }

  function discard(state, phase, reason, detail) {
    const ready = state.ready
    state.ready = null
    state.phase = phase
    state.lastOutcome = {
      state: phase,
      at: nowMs(),
      reason,
      ...(detail === undefined ? {} : { detail }),
      ...(ready === undefined || ready === null ? {} : { task: ready.snapshot.id.slice(0, 8) }),
    }
    if (ready !== null) {
      log.info('pre-compaction result discarded', {
        session: state.sessionId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      })
    }
  }

  /**
   * Apply a ready result when the current boundary and strategy allow it.
   * Everything here is synchronous; commit either lands completely or not at all.
   * @param {any} state
   * @param {string} boundary
   */
  function applyReady(state, boundary) {
    if (disposed || !config.enabled) return
    if (state.ready === null) return
    const manualPending = state.manual !== null
    if (!manualPending && !mayApplyAt(config.applyStrategy, boundary)) return
    if (boundary === BOUNDARIES.IDLE) {
      const agent = state.agent
      if (agent !== undefined && agent !== null && agent.status !== 'idle') return
    }
    if (!isLive(state)) {
      discard(state, PHASE.STALE, 'session-gone')
      if (state.manual !== null) {
        failManual(state, state.manual, manualFailureOf('session-gone'))
      }
      return
    }
    const readyMeta = state.ready
    const wasManual = readyMeta.manual === true
    const { snapshot, prepared, durationMs } = readyMeta
    const session = state.session
    const appendedNodes = Math.max(0, session.surface.nodes.length - snapshot.surfaceNodeCount)

    if (config.dryRun) {
      const framed = prepared.framedTokens
      const reduction = round((snapshot.shadowedRouteTokens - framed) / snapshot.shadowedRouteTokens, 4)
      state.ready = null
      state.phase = PHASE.COMPLETED
      // A dry run still paid for one summary; require new growth before paying again.
      const contextWindow = snapshot.policy?.contextWindow
      state.retriggerFloor =
        snapshot.totalTokensAtSnapshot +
        Math.max(2048, Number.isFinite(contextWindow) ? Math.round(contextWindow * 0.01) : 0)
      state.lastOutcome = {
        state: PHASE.COMPLETED,
        dryRun: true,
        at: nowMs(),
        boundary,
        compactionId: prepared.compactionId,
        shadowedCount: snapshot.shadowedCount,
        shadowedTokens: snapshot.shadowedRouteTokens,
        framedTokens: framed,
        reduction,
        appendedSinceSnapshot: appendedNodes,
        totalBefore: session.surface.nodes.length,
      }
      log.info('dry run: pre-compaction would have been applied', {
        session: session.id,
        boundary,
        shadowed_nodes: snapshot.shadowedCount,
        shadowed_tokens: snapshot.shadowedRouteTokens,
        framed_tokens: framed,
        reduction,
        appended_since_snapshot: appendedNodes,
      })
      if (state.manual !== null) {
        rejectManual(state, 'cancelled', 'Compaction was not applied because dry-run is enabled.')
      }
      return
    }

    state.applying = true
    state.phase = PHASE.APPLYING
    let validation
    try {
      validation = validateCommit({
        session,
        snapshot,
        config,
        meter: ctx.get?.('tokenMeter'),
        framedTokens: prepared.framedTokens,
      })
    } catch (error) {
      state.applying = false
      const code = error instanceof CommitError ? error.code : 'validation-failed'
      const phase = code === 'locked' ? PHASE.REJECTED : PHASE.STALE
      discard(state, phase, code, errorChain(error))
      state.lastFailure = { at: nowMs(), code, message: errorChain(error) }
      if (state.manual !== null) failManual(state, state.manual, manualFailureOf(code, errorChain(error)))
      return
    }

    try {
      const committed = appendCompaction({
        session,
        snapshot,
        prepared,
        entryState: validation.entryState,
      })
      state.ready = null
      state.phase = PHASE.COMPLETED
      state.growth.reset()
      const contextWindow = snapshot.policy?.contextWindow
      state.retriggerFloor =
        validation.expectedTotalAfter +
        Math.max(2048, Number.isFinite(contextWindow) ? Math.round(contextWindow * 0.01) : 0)
      const manualResult = manualResultOf(snapshot, prepared, committed)
      state.lastOutcome = {
        state: PHASE.COMPLETED,
        at: nowMs(),
        boundary,
        compactionId: committed.compactionId,
        turn: committed.turn,
        shadowedCount: snapshot.shadowedCount,
        shadowedTokens: snapshot.shadowedRouteTokens,
        framedTokens: prepared.framedTokens,
        reduction: round((snapshot.shadowedRouteTokens - prepared.framedTokens) / snapshot.shadowedRouteTokens, 4),
        appendedSinceSnapshot: appendedNodes,
        totalBefore: validation.currentTotalTokens,
        totalAfterEstimate: validation.expectedTotalAfter,
        seqs: { start: committed.startSeq, summary: committed.summarySeq, end: committed.endSeq },
        durationMs: Math.round(durationMs),
      }
      recordHistory(state, {
        at: state.lastOutcome.at,
        turn: readyMeta.turn ?? state.turn ?? null,
        step: readyMeta.step ?? state.step ?? null,
        manual: readyMeta.manual === true,
        trigger: typeof readyMeta.trigger === 'string' ? readyMeta.trigger : null,
        mode: typeof readyMeta.mode === 'string' ? readyMeta.mode : null,
        boundary,
        compactionId: committed.compactionId,
        shadowedTokens: snapshot.shadowedRouteTokens,
        framedTokens: prepared.framedTokens,
        reduction: state.lastOutcome.reduction,
        totalAfterEstimate: validation.expectedTotalAfter,
        durationMs: Math.round(durationMs),
      })
      log.info('background pre-compaction applied', {
        session: session.id,
        task: snapshot.id.slice(0, 8),
        compaction: committed.compactionId.slice(0, 8),
        boundary,
        turn: committed.turn,
        shadowed_nodes: snapshot.shadowedCount,
        shadowed_tokens: snapshot.shadowedRouteTokens,
        framed_tokens: prepared.framedTokens,
        reduction: state.lastOutcome.reduction,
        appended_since_snapshot: appendedNodes,
        total_before: validation.currentTotalTokens,
        total_after_estimate: validation.expectedTotalAfter,
        seqs: `${committed.startSeq}-${committed.endSeq}`,
        ...(wasManual ? { manual: true } : {}),
      })
      if (state.manual !== null) settleManual(state, { kind: 'success', result: manualResult })
      if (wasManual) flushSession(session)
    } catch (error) {
      const code = error instanceof CommitError ? error.code : 'commit-failed'
      state.phase = PHASE.REJECTED
      state.ready = null
      state.lastFailure = { at: nowMs(), code, message: errorChain(error), detail: error?.detail }
      log.error('background pre-compaction commit failed; the original context is preserved', {
        session: session.id,
        task: snapshot.id.slice(0, 8),
        code,
        error: errorChain(error),
      })
      if (state.manual !== null) failManual(state, state.manual, manualFailureOf(code, errorChain(error)))
    } finally {
      state.applying = false
    }
  }

  // ------------------------------------------------------------------ events
  /** @param {any} session @param {any} event */
  function onSessionEvent(session, event) {
    if (disposed || !config.enabled) return
    const state = stateFor(session)
    state.lastActivityAt = nowMs()
    if (event?.type === 'turn/start' || event?.type === 'step/start') {
      const turn = Number(event?.data?.turn)
      if (Number.isFinite(turn)) state.turn = turn
      const step = Number(event?.data?.step)
      if (event?.type === 'step/start' && Number.isFinite(step)) state.step = step
    }
    if (state.applying) return
    // A replacement (native compaction, pruning, image offload rewriting a node)
    // invalidates any snapshot built before it.
    if (event?.type === 'compaction/end') {
      invalidate(state, 'native-compaction')
      return
    }
    if (isSurfaceEventType(event?.type) && event?.surfaceOp !== 'append') {
      invalidate(state, 'surface-replaced')
      return
    }
    if (!isSurfaceEventType(event?.type)) return
    const now = nowMs()
    if (now - state.lastMeasurementAt < GROWTH_SAMPLING_INTERVAL_MS) return
    void evaluate(state, `event:${event.type}`)
  }

  function invalidate(state, reason) {
    state.retriggerFloor = 0
    // Any pending result or in-flight summary was produced against the old
    // surface: bump the generation so late settlement of the old task cannot
    // touch the new state, then handle it immediately instead of waiting for the
    // (possibly uncooperative) summarization call to return.
    state.generation += 1
    if (state.active !== null) {
      const task = state.active
      log.info('background pre-compaction invalidated', { session: state.sessionId, reason })
      task.abandoned = true
      state.invalidatedReason = reason
      try {
        task.abort.abort(reason)
      } catch {
        // abort must never throw into the host
      }
      state.active = null
      state.phase = PHASE.STALE
      state.lastOutcome = { state: PHASE.STALE, at: nowMs(), reason }
      if (state.manual !== null) failManual(state, state.manual, manualFailureOf('changed', reason))
      return
    }
    if (state.ready !== null) {
      discard(state, PHASE.STALE, reason)
      if (state.manual !== null) failManual(state, state.manual, manualFailureOf('changed', reason))
    }
  }

  /** @param {any} agent */
  function attach(agent) {
    const session = sessionOf(agent)
    if (session === undefined || session === null) return undefined
    const state = stateFor(session)
    state.agent = agent
    state.lastActivityAt = nowMs()
    return state
  }

  /** @param {any} agent */
  function onPreStep(agent) {
    const state = attach(agent)
    if (state === undefined) return
    applyReady(state, BOUNDARIES.PRE_STEP)
    void evaluate(state, 'pre-step')
  }

  /** @param {any} agent */
  function onTurnStopping(agent) {
    const state = attach(agent)
    if (state === undefined) return
    applyReady(state, BOUNDARIES.TURN_STOPPING)
    void evaluate(state, 'turn-stopping')
  }

  /** @param {any} agent */
  function onIdle(agent) {
    const state = attach(agent)
    if (state === undefined) return
    applyReady(state, BOUNDARIES.IDLE)
    void evaluate(state, 'idle')
  }

  /** @param {any} agent */
  function onAgentDisposed(agent) {
    const state = attach(agent)
    if (state === undefined) return
    state.agent = undefined
    // Settle the request first so the invalidation below cannot retry it.
    if (state.manual !== null) rejectManual(state, 'cancelled', 'Compaction cancelled because the agent was disposed.')
    if (state.active !== null) invalidate(state, 'agent-disposed')
    // Never append during disposal: drop the prepared result and let the next
    // agent instance re-evaluate. The native mechanism remains the backstop.
    if (state.ready !== null) discard(state, PHASE.STALE, 'agent-disposed')
  }

  /** @param {any} session */
  function onSessionDisposed(session) {
    const state = states.get(session.id)
    if (state === undefined) return
    if (state.manual !== null) rejectManual(state, 'cancelled', 'Compaction cancelled because the session was disposed.')
    if (state.active !== null) {
      state.active.abandoned = true
      state.generation += 1
      try {
        state.active.abort.abort('session-disposed')
      } catch {
        // ignore
      }
    }
    state.active = null
    state.ready = null
    state.phase = PHASE.CANCELLED
    states.delete(session.id)
  }

  /** Sample sessions that can still change or need a result applied. @param {number} tick */
  function sampleTick(tick) {
    if (disposed || !config.enabled) return
    const now = nowMs()
    for (const state of [...states.values()]) {
      const hot = now - state.lastActivityAt < Math.max(GROWTH_WINDOW_MS, GROWTH_SAMPLING_INTERVAL_MS * 2)
      const pending = state.ready !== null
      const running = state.agent?.status === 'running' || state.active !== null
      if (pending) applyReady(state, BOUNDARIES.IDLE)
      if (pending || running || hot) void evaluate(state, `timer:${tick}`)
    }
  }

  // ---------------------------------------------------------------- lifecycle
  function startTimer() {
    const interval = Math.max(1000, Math.min(GROWTH_SAMPLING_INTERVAL_MS, 10_000))
    let tick = 0
    const callback = () => {
      tick += 1
      try {
        sampleTick(tick)
      } catch (error) {
        log.warn('sampling tick failed', { error: errorChain(error) })
      }
    }
    let timer
    try {
      timer = ctx.get?.('timer')
    } catch {
      timer = undefined
    }
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      timerStop = timer.interval(callback, interval)
    } else {
      // Fallback for a profile without the timer plugin; the plugin's own
      // dispose() clears it.
      const handle = setInterval(callback, interval)
      timerStop = () => clearInterval(handle)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    try {
      timerStop?.()
    } catch {
      // ignore
    }
    disposeController.abort('plugin-disposed')
    for (const state of states.values()) {
      if (state.active !== null) {
        const task = state.active
        task.abandoned = true
        state.generation += 1
        try {
          task.abort.abort('plugin-disposed')
        } catch {
          // ignore
        }
        log.info('background pre-compaction cancelled', {
          session: state.sessionId,
          task: task.id.slice(0, 8),
          manual: task.manual === true,
        })
      }
      state.active = null
      state.ready = null
      state.phase = PHASE.CANCELLED
      if (state.manual !== null) {
        rejectManual(state, 'cancelled', 'Compaction cancelled because the plugin was unloaded.')
      }
    }
    states.clear()
    log.debug('runtime disposed')
  }

  /** Cancel pending manual work when the feature stops accepting requests. @param {string} reason */
  function cancelPendingManual(reason) {
    for (const state of states.values()) {
      if (state.manual === null) continue
      if (state.active !== null && state.active.manual === true) {
        cancelActiveManualTask(state, reason)
      }
      if (state.ready !== null && state.ready.manual === true) discard(state, PHASE.CANCELLED, reason)
      rejectManual(state, 'cancelled', 'Compaction cancelled because background pre-compaction was paused.')
    }
  }

  /** @param {boolean} value */
  function setEnabled(value) {
    const next = value === true
    if (!next && config.enabled === true) {
      // Pausing must not let a previously accepted manual request surprise the
      // user later: cancel it (the native `/compact` path is available again).
      cancelPendingManual('paused')
    }
    config.enabled = next
    log.info(config.enabled ? 'pre-compaction enabled' : 'pre-compaction disabled')
  }

  /** @param {any} a @param {any} b */
  function sameConfigValue(a, b) {
    if (a === b) return true
    if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
    return false
  }

  /**
   * Apply a validated configuration snapshot from a volatile settings save.
   * The runtime reads `config` on every decision, so assigning the new values is
   * enough; only the enable transition needs side effects.
   * @param {Record<string, any>} next
   */
  function applyConfig(next) {
    const changed = Object.keys(next).filter((key) => !sameConfigValue(config[key], next[key]))
    if (changed.length === 0) return
    const wasEnabled = config.enabled === true
    Object.assign(config, next)
    if (wasEnabled && config.enabled !== true) {
      cancelPendingManual('configuration-disabled')
    }
    log.info('configuration updated', { changed: changed.join(',') })
    // Re-price the tracked sessions so `/precompact status` and the next trigger
    // reflect the new thresholds immediately.
    if (config.enabled === true) {
      for (const state of states.values()) void evaluate(state, 'config-update')
    }
  }

  function isEnabled() {
    return config.enabled === true
  }

  /** Force one evaluation for a session (used by the status command). @param {any} agent */
  function forceEvaluate(agent) {
    const state = attach(agent)
    if (state === undefined) return null
    return evaluate(state, 'manual')
  }

  /** Record the manual-compaction hook state for `/precompact status`. @param {string} state @param {string} [detail] */
  function setManualHookState(state, detail) {
    manualHookState = { state, detail }
    log.debug('manual compaction hook state', { state, detail })
  }

  // ------------------------------------------------------------------ status
  /** @param {any} state */
  function statusOfState(state) {
    const agent = state.agent
    const measurement = state.lastMeasurement
    const decision = state.lastDecision
    return {
      sessionId: state.sessionId,
      enabled: config.enabled,
      mode: config.triggerMode,
      turn: state.turn ?? null,
      step: state.step ?? null,
      applyStrategy: config.applyStrategy,
      phase: state.phase,
      hasActiveTask: state.active !== null,
      hasReadyResult: state.ready !== null,
      currentTokens: measurement?.totalTokens ?? null,
      surfaceNodes: measurement?.nodeCount ?? state.session.surface.nodes.length,
      contextWindow: decision?.contextWindow ?? state.native.contextWindow ?? null,
      usageRatio: measurement === null || measurement === undefined ? null : usageRatio(measurement.totalTokens, decision?.contextWindow ?? state.native.contextWindow ?? null),
      nativeThresholdTokens: state.native.thresholdTokens ?? null,
      nativeThresholdRatio: state.native.thresholdRatio ?? null,
      nativeSource: state.native.source ?? null,
      triggerTokens: decision?.triggerTokens ?? null,
      triggerRatio: decision?.triggerRatio ?? null,
      triggerReason: decision?.reason ?? null,
      dataComplete: decision?.dataComplete ?? false,
      derivation: decision?.derivation ?? null,
      growthRateTokensPerSecond: decision?.derivation?.growthRateTokensPerSecond ?? null,
      predictedDurationSeconds: decision?.derivation?.predictedDurationSeconds ?? null,
      durationObservations: state.duration.observations,
      lastMeasurementAt: state.lastMeasurementAt || null,
      lastEvaluationAt: state.lastEvaluatedAt || null,
      lastSkip: state.lastSkip,
      retriggerFloor: state.retriggerFloor,
      activeTask: state.active === null ? null : { id: state.active.id.slice(0, 8), startedAt: state.active.startedAt },
      manualRequest:
        state.manual === null
          ? null
          : {
              id: state.manual.id.slice(0, 8),
              requestedAt: state.manual.requestedAt,
              sourceCommandId: state.manual.sourceCommandId,
              retried: state.manual.retried === true,
            },
      readyResult:
        state.ready === null
          ? null
          : {
              task: state.ready.snapshot.id.slice(0, 8),
              shadowedCount: state.ready.snapshot.shadowedCount,
              shadowedTokens: state.ready.snapshot.shadowedRouteTokens,
              framedTokens: state.ready.prepared.framedTokens,
              durationMs: Math.round(state.ready.durationMs),
            },
      lastOutcome: state.lastOutcome,
      lastFailure: state.lastFailure,
      lastMeasureError: state.lastMeasureError,
      manualHook: manualHookState,
      samples: state.samples,
      steps: state.steps,
      history: state.history,
    }
  }

  /** @param {string} sessionId */
  function statusFor(sessionId) {
    const state = states.get(sessionId)
    return state === undefined ? null : statusOfState(state)
  }

  function statuses() {
    return [...states.values()].map(statusOfState)
  }

  return {
    log,
    config,
    startTimer,
    dispose,
    onSessionEvent,
    onPreStep,
    onTurnStopping,
    onIdle,
    onAgentDisposed,
    onSessionDisposed,
    statusFor,
    statuses,
    setEnabled,
    isEnabled,
    applyConfig,
    forceEvaluate,
    shouldHookManual,
    tryManualCompaction,
    setManualHookState,
    // exposed for tests
    _internals: { evaluate, applyReady, beginManualTask, stateFor, PHASE, BOUNDARIES },
  }
}
