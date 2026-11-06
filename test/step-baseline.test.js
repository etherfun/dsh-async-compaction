/**
 * Manual `/compact` requested while a turn is running: the in-flight step is the
 * baseline, the result lands on the step boundary, and the current step survives.
 * @module test/step-baseline.test
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

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

/**
 * A tracked session with completed history, then a running turn and an in-flight
 * step containing two surface nodes.
 * @param {{ runningStep?: boolean }} [options]
 */
function runningStepFixture(options = {}) {
  const ctx = new FakeCtx()
  const config = resolveConfig({
    triggerMode: 'fixed',
    fixedThreshold: 1,
    minInterval: 0,
    minShadowedTokens: 0,
    logLevel: 'debug',
  }).config
  const runtime = createRuntime(ctx, config)
  const session = ctx.sessions.add(makeSession({ turns: 4, toolPairs: 1, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))

  session.append('turn/start', { turn: 5 })
  runtime.onSessionEvent(session, session.log.at(-1))
  let stepStartSeq = null
  if (options.runningStep !== false) {
    stepStartSeq = session.seq
    session.append('step/start', { turn: 5, step: 0 })
    runtime.onSessionEvent(session, session.log.at(-1))
    session.append('user/message', userMessage('Current step: keep this request and reply intact.'), {
      surfaceOp: 'append',
    })
    session.append(
      'assistant/message',
      {
        turn: 5,
        step: 0,
        message: assistantMessage({
          text: 'Current step reply that must survive the manual compaction.',
          provider: session.provider,
          model: session.model,
        }),
      },
      { surfaceOp: 'append' },
    )
  }

  agent.status = 'running'
  return { ctx, runtime, session, agent, stepStartSeq }
}

/** @param {any} session @param {Record<string, any>} [overrides] */
function appendCurrentStepMessage(session, text = 'More work in the same step.') {
  const seq = session.seq
  session.append(
    'assistant/message',
    {
      turn: 5,
      step: 0,
      message: assistantMessage({ text, provider: session.provider, model: session.model }),
    },
    { surfaceOp: 'append' },
  )
  return seq
}

test('an in-flight manual compaction keeps the current step and lands on the step boundary', async () => {
  const { ctx, runtime, session, agent, stepStartSeq } = runningStepFixture()
  assert.equal(
    runtime.statusFor(session.id).currentStepStartSeq,
    stepStartSeq,
    'step/start records the in-flight baseline on the public status',
  )

  ctx.compaction.holdSummaries = true
  const promise = runtime.tryManualCompaction(agent, {})
  await waitFor(() => ctx.compaction.pendingCount() === 1, { label: 'manual summary' })

  // The step keeps running while the summary is in flight.
  const appendedSeq = appendCurrentStepMessage(session)
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(appendedSeq > stepStartSeq, true)

  ctx.compaction.releaseAll()
  await waitFor(() => runtime.statusFor(session.id).phase === 'READY', { label: 'manual result ready' })

  session.append('step/end', { turn: 5, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  const result = await promise
  await settle()

  assert.equal(result.manual, true)
  assert.equal(result.turn, 5)
  assert.equal(runtime.statusFor(session.id).history.length, 1)
  const entry = runtime.statusFor(session.id).history[0]
  assert.equal(entry.boundary, 'step-boundary')
  assert.equal(entry.manual, true)

  // Only history before the in-flight step was shadowed.
  assert.ok(result.shadowedRange.end < stepStartSeq, 'the compaction ends before the current step')
  assert.ok(result.shadowedSeqs.every((seq) => seq < stepStartSeq))
  assert.equal(result.shadowedSeqs.includes(appendedSeq), false)

  // The current step's surface nodes are still there (the step/start event itself
  // is not a surface node; only messages appended after it are).
  assert.ok(session.surface.nodes.filter((seq) => seq >= stepStartSeq).length >= 2)
  assert.deepEqual(session.surface.nodes.filter((seq) => seq >= stepStartSeq).slice(-1), [appendedSeq])
  assert.equal(session.surface.nodes.includes(appendedSeq), true)
  assert.equal(runtime.statusFor(session.id).lastOutcome.appendedSinceSnapshot, 1)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  runtime.dispose()
})

test('a step/end that arrives before the summary is ready still lands at the next pre-step', async () => {
  const { ctx, runtime, session, agent } = runningStepFixture()
  ctx.compaction.holdSummaries = true
  const promise = runtime.tryManualCompaction(agent, {})
  await waitFor(() => ctx.compaction.pendingCount() === 1, { label: 'manual summary' })

  // The step ends while the summary is still running; the boundary is a no-op.
  session.append('step/end', { turn: 5, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  await settle()
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)

  ctx.compaction.releaseAll()
  await waitFor(() => runtime.statusFor(session.id).phase === 'READY', { label: 'manual result ready' })
  await runtime.onPreStep(agent)
  const result = await promise

  assert.equal(result.manual, true)
  assert.equal(runtime.statusFor(session.id).history[0].boundary, 'pre-step')
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  runtime.dispose()
})

test('without an in-flight step the manual compaction keeps the old retain-0 behavior', async () => {
  const { ctx, runtime, session, agent } = runningStepFixture({ runningStep: false })
  assert.equal(runtime.statusFor(session.id).currentStepStartSeq, null)
  const nodesBefore = [...session.surface.nodes]
  agent.status = 'idle'

  const result = await runtime.tryManualCompaction(agent, {})
  assert.equal(result.manual, true)
  assert.deepEqual(result.shadowedSeqs, nodesBefore.slice(1, nodesBefore.length - 1))
  assert.equal(result.shadowedRange.end, nodesBefore[nodesBefore.length - 2])
  assert.equal(runtime.statusFor(session.id).history[0].boundary, 'idle')
  runtime.dispose()
})

test('step/start, step/end and turn boundaries maintain the in-flight baseline', async () => {
  const { runtime, session } = runningStepFixture()
  const baseline = () => runtime.statusFor(session.id).currentStepStartSeq
  assert.equal(baseline(), session.log.find((event) => event.type === 'step/start').seq)

  session.append('step/end', { turn: 5, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(baseline(), null, 'step/end clears the baseline')

  session.append('step/start', { turn: 5, step: 1 })
  runtime.onSessionEvent(session, session.log.at(-1))
  const secondStepSeq = session.log.at(-1).seq
  assert.equal(baseline(), secondStepSeq)

  session.append('turn/start', { turn: 6 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(baseline(), null, 'turn/start clears the baseline')

  session.append('step/start', { turn: 6, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  const thirdStepSeq = session.log.at(-1).seq
  assert.equal(baseline(), thirdStepSeq)

  session.append('turn/end', { turn: 6 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(baseline(), null, 'turn/end clears the baseline')
  runtime.dispose()
})

test('statusFor() exposes currentStepStartSeq: null by default and the step/start seq while running', () => {
  const { runtime, session } = runningStepFixture({ runningStep: false })
  assert.equal(runtime.statusFor(session.id).currentStepStartSeq, null, 'no in-flight step -> null')

  session.append('step/start', { turn: 5, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  const stepStartSeq = session.log.at(-1).seq
  assert.equal(runtime.statusFor(session.id).currentStepStartSeq, stepStartSeq)

  session.append('step/end', { turn: 5, step: 0 })
  runtime.onSessionEvent(session, session.log.at(-1))
  assert.equal(runtime.statusFor(session.id).currentStepStartSeq, null)
  runtime.dispose()
})
