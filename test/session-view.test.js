/**
 * Per-session visualization series: bounded context samples and applied
 * compaction history, as exposed by `runtime.statusFor()` and
 * `/api/pre-compact/history`.
 * @module test/session-view.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/coordinator.js'
import { resolveConfig } from '../src/config.js'
import {
  FakeCtx,
  assistantMessage,
  eventsOfType,
  makeAgent,
  makeSession,
  userMessage,
  waitFor,
} from './fake-harness.js'

const HISTORY_KEYS = [
  'at',
  'boundary',
  'compactionId',
  'durationMs',
  'framedTokens',
  'manual',
  'mode',
  'reduction',
  'shadowedTokens',
  'step',
  'totalAfterEstimate',
  'trigger',
  'turn',
]

/** Build a runtime plus one tracked session/agent. @param {Record<string, any>} [overrides] */
function runtimeFixture(overrides = {}) {
  const ctx = new FakeCtx()
  const config = resolveConfig({
    triggerMode: 'fixed',
    fixedThreshold: 1,
    minInterval: 0,
    minShadowedTokens: 0,
    logLevel: 'debug',
    ...overrides,
  }).config
  const runtime = createRuntime(ctx, config)
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))
  return { ctx, config, runtime, session, agent }
}

/** Append enough fresh history for another manual compaction. @param {any} session @param {number} index */
function appendTurn(session, index) {
  session.append(
    'user/message',
    userMessage(`Follow-up ${index}: ${'more context detail '.repeat(20)}`),
    { surfaceOp: 'append' },
  )
  session.append(
    'assistant/message',
    {
      turn: 100 + index,
      step: 0,
      message: assistantMessage({
        text: `Reply ${index}: ${'work completed in detail '.repeat(20)}`,
        provider: session.provider,
        model: session.model,
      }),
    },
    { surfaceOp: 'append' },
  )
}

// ---------------------------------------------------------------------------
// samples
// ---------------------------------------------------------------------------

test('statusFor() exposes samples and history as empty arrays by default', () => {
  const { runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)
  const fresh = runtime.statusFor(session.id)
  assert.ok(fresh !== null)
  assert.equal(fresh.turn, null, 'no turn/start has been observed yet')
  assert.equal(fresh.step, null, 'no step/start has been observed yet')
  assert.deepEqual(fresh.samples, [])
  assert.deepEqual(fresh.history, [])
  assert.ok(Array.isArray(state.samples))
  assert.ok(Array.isArray(state.history))
  runtime.dispose()
})

test('turn/start updates the status turn and the next sample records it', async () => {
  const { runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)

  session.append('turn/start', { turn: 3 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(runtime.statusFor(session.id).turn, 3)

  await runtime._internals.evaluate(state, 'test')
  const status = runtime.statusFor(session.id)
  assert.equal(status.samples.at(-1).turn, 3, 'a sample records the turn current at evaluation time')
  assert.equal(status.samples[0].turn, 3)

  // A later turn is picked up by the next sample; earlier samples keep their turn.
  session.append('turn/start', { turn: 4 })
  runtime.onSessionEvent(session, session.log.at(-1))
  await runtime._internals.evaluate(state, 'test')
  assert.deepEqual(runtime.statusFor(session.id).samples.map((sample) => sample.turn), [3, 4])
  assert.equal(runtime.statusFor(session.id).turn, 4)
  runtime.dispose()
})

test('step/start updates the status step and the next sample records it', async () => {
  const { runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)
  assert.equal(runtime.statusFor(session.id).step, null)

  // A step/start also carries its turn; both are tracked.
  session.append('step/start', { turn: 8, step: 2 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(runtime.statusFor(session.id).turn, 8)
  assert.equal(runtime.statusFor(session.id).step, 2)

  await runtime._internals.evaluate(state, 'test')
  const first = runtime.statusFor(session.id).samples.at(-1)
  assert.equal(first.turn, 8)
  assert.equal(first.step, 2)

  session.append('step/start', { turn: 8, step: 3 })
  runtime.onSessionEvent(session, session.log.at(-1))
  await runtime._internals.evaluate(state, 'test')
  const samples = runtime.statusFor(session.id).samples
  assert.deepEqual(samples.map((sample) => sample.step), [2, 3], 'earlier samples keep their step')
  assert.deepEqual(samples.map((sample) => sample.turn), [8, 8])
  runtime.dispose()
})

test('the context sample series is bounded to the newest 120 evaluations', async () => {
  const { ctx, runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)
  const baseTokens = ctx.get('tokenMeter').measure(session).totalTokens

  for (let index = 0; index < 125; index += 1) {
    session.extraTokens += 10
    await runtime._internals.evaluate(state, 'test')
  }

  const status = runtime.statusFor(session.id)
  assert.equal(status.samples.length, 120, 'the series is capped at 120 samples')
  // 125 evaluations -> the first five were dropped; the newest is last.
  assert.equal(status.samples[0].tokens, baseTokens + 60)
  assert.equal(status.samples.at(-1).tokens, baseTokens + 1250)
  assert.equal(status.samples.at(-1).tokens, status.currentTokens)

  for (const sample of status.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ['at', 'native', 'step', 'tokens', 'trigger', 'turn'])
    assert.equal(typeof sample.at, 'number')
    assert.equal(Number.isInteger(sample.tokens), true)
    assert.equal(typeof sample.trigger, 'number')
    assert.equal(typeof sample.native, 'number')
    assert.equal(sample.turn, null, 'no turn/start event was observed in this test')
    assert.equal(sample.step, null, 'no step/start event was observed in this test')
  }
  runtime.dispose()
})

test('steps keep one point per step, upserting repeats and staying ascending', async () => {
  const { runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)
  assert.deepEqual(runtime.statusFor(session.id).steps, [])

  session.append('step/start', { turn: 1, step: 1 })
  runtime.onSessionEvent(session, session.log.at(-1))
  await runtime._internals.evaluate(state, 'test')
  const firstTokens = runtime.statusFor(session.id).samples.at(-1).tokens

  // A second evaluation inside the same step replaces the point instead of
  // adding one.
  session.extraTokens += 100
  await runtime._internals.evaluate(state, 'test')
  let status = runtime.statusFor(session.id)
  assert.equal(status.steps.length, 1)
  assert.equal(status.steps[0].step, 1)
  assert.ok(status.steps[0].tokens > firstTokens)
  assert.equal(status.steps[0].tokens, status.samples.at(-1).tokens)

  // Out-of-order step events still produce an ascending series.
  for (const step of [3, 2]) {
    session.append('step/start', { turn: 1, step })
    runtime.onSessionEvent(session, session.log.at(-1))
    await runtime._internals.evaluate(state, 'test')
  }
  status = runtime.statusFor(session.id)
  assert.deepEqual(status.steps.map((point) => point.step), [1, 2, 3])
  assert.deepEqual(Object.keys(status.steps[0]).sort(), ['at', 'native', 'step', 'tokens', 'trigger', 'turn'])
  runtime.dispose()
})

test('the steps series keeps every step while samples stay at 120', async () => {
  const { runtime, session } = runtimeFixture()
  const state = runtime._internals.stateFor(session)
  for (let step = 1; step <= 205; step += 1) {
    session.append('step/start', { turn: 1, step })
    runtime.onSessionEvent(session, session.log.at(-1))
    await runtime._internals.evaluate(state, 'test')
  }

  const status = runtime.statusFor(session.id)
  assert.equal(status.steps.length, 205, 'the per-step series is not capped')
  assert.equal(status.steps[0].step, 1, 'the oldest step is still present')
  assert.equal(status.steps.at(-1).step, 205)
  assert.deepEqual(
    status.steps.map((point) => point.step),
    Array.from({ length: 205 }, (_, index) => index + 1),
  )
  assert.equal(status.samples.length, 120, 'raw samples keep their own 120 cap')
  runtime.dispose()
})

test('the coordinator warm-starts the adaptive target after a growth reset', async () => {
  const ctx = new FakeCtx()
  const config = resolveConfig({
    triggerMode: 'adaptive',
    minThreshold: 0.5,
    maxThreshold: 0.75,
    fallbackThreshold: 0.65,
    minInterval: 0,
    minShadowedTokens: 0,
    logLevel: 'debug',
  }).config
  const runtime = createRuntime(ctx, config)
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))
  const state = runtime._internals.stateFor(session)

  // One completed compression (duration history) and two flat growth samples:
  // the prediction clamps to the 75% maximum.
  state.duration.add(10)
  const baseTokens = ctx.get('tokenMeter').measure(session).totalTokens
  const now = Date.now()
  state.growth.addSample(now - 2000, baseTokens)
  state.growth.addSample(now - 500, baseTokens)
  await runtime._internals.evaluate(state, 'test')

  const predicted = runtime.statusFor(session.id)
  assert.equal(predicted.dataComplete, true)
  assert.equal(predicted.triggerTokens, 150_000)
  assert.equal(predicted.triggerRatio, 0.75)
  assert.ok(predicted.derivation.clamps.includes('max-threshold'))
  assert.equal(state.lastAdaptiveTarget.triggerTokens, 150_000)
  assert.equal(state.lastAdaptiveTarget.triggerRatio, 0.75)

  // The usage now reaches the target; growth is cleared as it would be right
  // after a compaction. A plain fallback would drop to 65%, the warm start keeps
  // the derived 75% target and reports the warm-start reason.
  session.extraTokens = 160_000
  state.growth.reset()
  await runtime._internals.evaluate(state, 'test')

  const warmed = runtime.statusFor(session.id)
  assert.equal(warmed.dataComplete, false)
  assert.equal(warmed.triggerReason, 'adaptive-warm-start')
  assert.equal(warmed.triggerTokens, 150_000)
  assert.equal(warmed.triggerRatio, 0.75)
  assert.equal(warmed.derivation.warmStartTokens, 150_000)
  assert.equal(warmed.derivation.warmStartRatio, 0.75)
  assert.equal(typeof warmed.derivation.warmStartAt, 'number')
  runtime.dispose()
})

test('a fresh adaptive session without history still falls back to fallbackThreshold', async () => {
  const ctx = new FakeCtx()
  const config = resolveConfig({
    triggerMode: 'adaptive',
    fallbackThreshold: 0.65,
    minInterval: 0,
    minShadowedTokens: 0,
    logLevel: 'debug',
  }).config
  const runtime = createRuntime(ctx, config)
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true }))
  session.extraTokens = 140_000
  runtime._internals.stateFor(session)

  await runtime._internals.evaluate(runtime._internals.stateFor(session), 'test')
  const decision = runtime.statusFor(session.id)
  assert.equal(decision.dataComplete, false)
  assert.equal(decision.triggerReason, 'adaptive-fallback-no-data')
  assert.equal(decision.triggerTokens, 130_000)
  runtime.dispose()
})

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('a committed manual compaction appends one history entry with the public fields', async () => {
  const { runtime, session, agent } = runtimeFixture()
  session.append('step/start', { turn: 5, step: 7 })
  runtime.onSessionEvent(session, session.log.at(-1))
  const result = await runtime.tryManualCompaction(agent, {})
  assert.equal(result.manual, true)

  const status = runtime.statusFor(session.id)
  assert.equal(status.history.length, 1)
  const entry = status.history[0]
  assert.deepEqual(Object.keys(entry).sort(), HISTORY_KEYS)
  assert.equal(entry.turn, 5, 'history records the turn the compaction belongs to')
  assert.equal(entry.step, 7, 'history records the step the compaction belongs to')
  assert.equal(entry.manual, true)
  assert.equal(entry.trigger, 'manual')
  assert.equal(entry.mode, 'manual')
  assert.equal(entry.boundary, 'idle')
  assert.equal(entry.compactionId, result.compactionId)
  assert.equal(entry.at, status.lastOutcome.at)
  assert.ok(entry.shadowedTokens > 0)
  assert.ok(entry.framedTokens > 0)
  assert.ok(entry.reduction >= 0 && entry.reduction <= 1)
  assert.ok(entry.totalAfterEstimate > 0)
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  runtime.dispose()
})

test('the history turn/step are captured when the task snapshot starts, not when it completes', async () => {
  const { ctx, runtime, session, agent } = runtimeFixture()
  session.append('step/start', { turn: 5, step: 3 })
  runtime.onSessionEvent(session, session.log.at(-1))

  ctx.compaction.holdSummaries = true
  const promise = runtime.tryManualCompaction(agent, {})
  await waitFor(() => ctx.compaction.pendingCount() === 1, { label: 'manual summary' })

  // A new turn/step starts while the summary is still in flight; the compaction
  // still belongs to where it was decided.
  session.append('step/start', { turn: 6, step: 4 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(runtime.statusFor(session.id).turn, 6)
  assert.equal(runtime.statusFor(session.id).step, 4)

  ctx.compaction.releaseAll()
  const result = await promise
  assert.equal(result.manual, true)

  const status = runtime.statusFor(session.id)
  assert.equal(status.history.length, 1)
  assert.equal(status.history[0].turn, 5, 'history keeps the turn the task started in')
  assert.equal(status.history[0].step, 3, 'history keeps the step the task started in')
  assert.equal(status.turn, 6, 'the live status turn advanced independently')
  assert.equal(status.step, 4, 'the live status step advanced independently')
  runtime.dispose()
})

test('a dry run does not append to the applied-compaction history', async () => {
  const { runtime, session, agent } = runtimeFixture({ dryRun: true, fixedThreshold: 0.01 })
  session.extraTokens = 20_000
  runtime.forceEvaluate(agent)
  await waitFor(() => runtime.statusFor(session.id)?.phase === 'READY')

  await runtime.onPreStep(agent)
  await waitFor(() => runtime.statusFor(session.id)?.lastOutcome?.dryRun === true)

  const status = runtime.statusFor(session.id)
  assert.deepEqual(status.history, [], 'dry runs never become applied history')
  assert.equal(status.lastOutcome.dryRun, true)
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)
  runtime.dispose()
})

test('a rejected commit does not append to the applied-compaction history', async () => {
  const { runtime, session, agent } = runtimeFixture({ fixedThreshold: 0.01 })
  session.extraTokens = 20_000
  runtime.forceEvaluate(agent)
  await waitFor(() => runtime.statusFor(session.id)?.phase === 'READY')

  // Another compaction holds the durable lock, so the commit is rejected.
  session.append('compaction/start', { compactionId: 'foreign-1', turn: 1 })
  await runtime.onPreStep(agent)
  await waitFor(() => runtime.statusFor(session.id)?.phase === 'REJECTED')

  const status = runtime.statusFor(session.id)
  assert.deepEqual(status.history, [])
  assert.equal(status.lastFailure?.code, 'locked')
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)
  runtime.dispose()
})

test('a cancelled manual request does not append to the applied-compaction history', async () => {
  const { runtime, session, agent } = runtimeFixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runtime.tryManualCompaction(agent, { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'cancelled')
    return true
  })
  assert.deepEqual(runtime.statusFor(session.id).history, [])
  runtime.dispose()
})

test('the applied-compaction history is bounded to the newest 30 commits', async () => {
  const { runtime, session, agent } = runtimeFixture()
  let firstCompactionId
  let lastResult
  for (let index = 0; index < 31; index += 1) {
    if (index === 0) appendTurn(session, index)
    else appendTurn(session, index)
    lastResult = await runtime.tryManualCompaction(agent, {})
    assert.equal(lastResult.manual, true, `manual commit ${index} must succeed`)
    if (index === 0) firstCompactionId = lastResult.compactionId
  }

  const history = runtime.statusFor(session.id).history
  assert.equal(history.length, 30, 'history is capped at 30 entries')
  assert.equal(history.at(-1).compactionId, lastResult.compactionId)
  assert.equal(history.some((entry) => entry.compactionId === firstCompactionId), false, 'the oldest entry is dropped')
  for (const entry of history) {
    assert.equal(entry.manual, true)
    assert.deepEqual(Object.keys(entry).sort(), HISTORY_KEYS)
  }
  runtime.dispose()
})
