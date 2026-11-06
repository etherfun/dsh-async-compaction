/**
 * Lifecycle and concurrency: state machine guards, scheduling limits, boundary
 * strategies, cancellation, disposal and skip reasons.
 * @module test/lifecycle.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentDisposed,
  agentIdle,
  agentRunning,
  createFakeCompactionBackend,
  delay,
  eventsOfType,
  makeAgent,
  makeSession,
  preStep,
  rewriteToolResult,
  sessionDisposed,
  spawnPlugin,
  statusText,
  turnStopping,
  userMessage,
  waitFor,
  waitForPhase,
} from './fake-harness.js'

const BASE_CONFIG = Object.freeze({
  triggerMode: 'fixed',
  fixedThreshold: 0.05,
  minInterval: 60_000,
  minShadowedTokens: 0,
  logLevel: 'debug',
})

/**
 * Boot a plugin plus one session/agent pair that is already above the trigger.
 * @param {Record<string, any>} [config]
 * @param {{ session?: Record<string, any>, ctxOptions?: Record<string, any> }} [options]
 */
function setup(config = {}, options = {}) {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG, ...config }, options.ctxOptions ?? {})
  const session = ctx.sessions.add(
    makeSession({
      turns: 8,
      toolPairs: 1,
      turnOpen: true,
      extraTokens: 20_000,
      ...(options.session ?? {}),
    }),
  )
  const agent = ctx.agents.add(makeAgent(session))
  return { ctx, session, agent }
}

/** @param {any} ctx @param {any} session */
function pluginEventCounts(session) {
  return {
    starts: eventsOfType(session, 'compaction/start').length,
    summaries: eventsOfType(session, 'compaction/summary').length,
    ends: eventsOfType(session, 'compaction/end').length,
  }
}

/** Wait until all pending microtasks of the evaluation chain have settled. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// one task per session / no global concurrency cap
// ---------------------------------------------------------------------------

test('same session never runs two background tasks at once', async () => {
  const { ctx, session, agent } = setup()
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  assert.match(await statusText(ctx, agent), /Task state: COMPRESSING/)

  for (let index = 0; index < 4; index += 1) await preStep(ctx, agent)
  await settle()
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  assert.deepEqual(pluginEventCounts(session), { starts: 0, summaries: 0, ends: 0 })

  ctx.compaction.releaseAll()
  await waitForPhase(ctx, agent, 'READY')
  await ctx.dispose()
})

test('different sessions run background tasks concurrently (no global cap)', async () => {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG })
  const sessionOne = ctx.sessions.add(makeSession({ turns: 8, toolPairs: 0, turnOpen: true, extraTokens: 20_000 }))
  const sessionTwo = ctx.sessions.add(makeSession({ turns: 8, toolPairs: 0, turnOpen: true, extraTokens: 20_000 }))
  const agentOne = ctx.agents.add(makeAgent(sessionOne))
  const agentTwo = ctx.agents.add(makeAgent(sessionTwo))
  ctx.compaction.holdSummaries = true

  await preStep(ctx, agentOne)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1, { label: 'first session summary' })

  await preStep(ctx, agentTwo)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 2, {
    label: 'second session summary starts without waiting for the first',
  })
  assert.match(await statusText(ctx, agentOne), /Task state: COMPRESSING/)
  assert.match(await statusText(ctx, agentTwo), /Task state: COMPRESSING/)

  ctx.compaction.releaseAll()
  await waitForPhase(ctx, agentOne, 'READY')
  await waitForPhase(ctx, agentTwo, 'READY')
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// minInterval / anti-thrash floor
// ---------------------------------------------------------------------------

test('minInterval defers a second task until the interval has elapsed', async () => {
  const { ctx, session, agent } = setup({ minInterval: 500, fixedThreshold: 0.01, logLevel: 'debug' }, {
    session: { turns: 24, toolPairs: 1, extraTokens: 0 },
  })
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  // Apply the result: this also kicks off a new evaluation.
  await preStep(ctx, agent)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)

  // The session dropped below the trigger, so raise it back above both the
  // trigger and the anti-thrash floor with simulated growth.
  session.extraTokens += 4000
  await preStep(ctx, agent)
  await waitFor(() => ctx.hasLog('minimum interval not elapsed'))
  assert.equal(ctx.compaction.summarizeCalls.length, 1)

  await delay(550)
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 2)
  await ctx.dispose()
})

test('the anti-thrash floor stops an immediate re-compaction after a commit', async () => {
  const { ctx, agent } = setup({ minInterval: 0 })
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  await preStep(ctx, agent)
  assert.equal(eventsOfType(agent.session, 'compaction/end').length, 1)

  await waitFor(async () => (await statusText(ctx, agent)).includes('Last skip: retrigger-floor'))
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// disposal + cancellation
// ---------------------------------------------------------------------------

test('plugin disposal aborts an in-flight summary and cleans up the timer', async () => {
  const { ctx, session, agent } = setup()
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  const call = ctx.compaction.summarizeCalls[0]
  const logLength = session.log.length

  await ctx.dispose()
  assert.equal(call.signal.aborted, true, 'the summarization signal must be aborted')
  assert.equal(ctx.intervals.every((record) => record.stopped), true, 'the sampling timer must be stopped')
  await waitFor(() => ctx.hasLog('background pre-compaction cancelled'))
  await settle()
  assert.equal(session.log.length, logLength, 'disposal must never append events')

  // Disposal runs the effect disposers, including the /precompact registration.
  assert.equal(ctx.get('commands').get('precompact'), undefined)

  // A disposed runtime ignores further boundaries.
  await preStep(ctx, agent)
  await settle()
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
})

test('session/disposed cancels its background task and forgets the state', async () => {
  const { ctx, session, agent } = setup()
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  const call = ctx.compaction.summarizeCalls[0]
  const logLength = session.log.length

  sessionDisposed(ctx, session)
  assert.equal(call.signal.aborted, true)
  assert.match(await statusText(ctx, agent), /no state for this session yet/)
  await settle()
  assert.equal(session.log.length, logLength)
})

test('agent/disposed invalidates an in-flight task (STALE, no append)', async () => {
  const { ctx, session, agent } = setup()
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  const logLength = session.log.length

  agentDisposed(ctx, agent)
  await waitForPhase(ctx, agent, 'STALE')
  await settle()
  assert.equal(session.log.length, logLength)
  assert.deepEqual(pluginEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await ctx.dispose()
})

test('agent/disposed discards a ready result instead of applying it', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  const surfaceBefore = [...session.surface.nodes]

  agentDisposed(ctx, agent)
  await waitForPhase(ctx, agent, 'STALE')
  assert.deepEqual(session.surface.nodes, surfaceBefore)
  assert.deepEqual(pluginEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await ctx.dispose()
})

test('a session removed from the store makes the prepared result stale', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  const surfaceBefore = [...session.surface.nodes]
  const logLength = session.log.length

  ctx.sessions.remove(session)
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'STALE')
  assert.equal(session.log.length, logLength)
  assert.deepEqual(session.surface.nodes, surfaceBefore)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// apply boundaries and strategies
// ---------------------------------------------------------------------------

test('pre-step applies a ready result', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  await preStep(ctx, agent)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  assert.match(await statusText(ctx, agent), /Task state: COMPLETED/)
  await ctx.dispose()
})

test('agent/status idle applies a ready result', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  agentIdle(ctx, agent)
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

test('applyStrategy idle-only never applies at pre-step or turn-stopping', async () => {
  const { ctx, session, agent } = setup({ applyStrategy: 'idle-only' })
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  await preStep(ctx, agent)
  turnStopping(ctx, agent)
  await settle()
  assert.deepEqual(pluginEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  assert.match(await statusText(ctx, agent), /Task state: READY/)

  agentIdle(ctx, agent)
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

test('applyStrategy end-of-turn applies at turn-stopping but not at pre-step', async () => {
  const { ctx, session, agent } = setup({ applyStrategy: 'end-of-turn' })
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  await preStep(ctx, agent)
  await settle()
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)

  turnStopping(ctx, agent)
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

test('the sampling timer applies only when the agent is idle', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  agentRunning(ctx, agent)
  ctx.tick()
  await settle()
  assert.equal(eventsOfType(session, 'compaction/end').length, 0, 'a running agent must not be compacted at idle')

  agentIdle(ctx, agent)
  ctx.tick()
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// invalidation by the surrounding session
// ---------------------------------------------------------------------------

test('a native compaction landing while READY invalidates the prepared result', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  const surfaceBefore = [...session.surface.nodes]

  session.append('compaction/start', { compactionId: 'native-1', turn: 1 })
  session.append('compaction/end', { compactionId: 'native-1', turn: 1 })
  await waitForPhase(ctx, agent, 'STALE')
  assert.deepEqual(session.surface.nodes, surfaceBefore)

  await preStep(ctx, agent)
  await settle()
  // Only the native pair is in the log; the plugin itself wrote nothing.
  assert.equal(eventsOfType(session, 'compaction/start').length, 1)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  await ctx.dispose()
})

test('a surface replacement during summarization invalidates the task (STALE)', async () => {
  const { ctx, session, agent } = setup()
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  const call = ctx.compaction.summarizeCalls[0]
  const target = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'tool/result')
  assert.notEqual(target, undefined)

  rewriteToolResult(session, target, 'pruned while summarizing')
  assert.equal(call.signal.aborted, true)
  await waitForPhase(ctx, agent, 'STALE')
  assert.equal(eventsOfType(session, 'compaction/start').length, 0)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// commit rejection and skip reasons
// ---------------------------------------------------------------------------

test('an active compaction lock rejects the commit (REJECTED) without touching history', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  const surfaceBefore = [...session.surface.nodes]
  const logLength = session.log.length

  // Another compaction (e.g. /compact) holds the durable lock.
  session.append('compaction/start', { compactionId: 'manual-1', turn: 1 })
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'REJECTED')
  const text = await statusText(ctx, agent)
  assert.match(text, /Last failure: locked/)
  assert.equal(session.log.length, logLength + 1, 'only the foreign lock event may exist')
  assert.deepEqual(session.surface.nodes, surfaceBefore)
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)
  await ctx.dispose()
})

test('a shadowed range below minShadowedTokens skips the task', async () => {
  const { ctx, agent } = setup(
    { minShadowedTokens: 1024 },
    { session: { turns: 3, toolPairs: 0, extraTokens: 20_000 } },
  )
  await preStep(ctx, agent)
  await waitFor(async () => (await statusText(ctx, agent)).includes('Last skip: range-too-small'))
  assert.equal(ctx.compaction.summarizeCalls.length, 0)
  assert.match(await statusText(ctx, agent), /Task state: IDLE/)
  await ctx.dispose()
})

test('a legacy model allowlist/denylist no longer scopes compaction', async () => {
  // Model scoping was removed from the plugin config: route selection belongs
  // to the installer, so a task starts no matter what any old keys say.
  const { ctx, agent } = setup({ modelAllowlist: ['some-other-model'], modelDenylist: ['fake-model'] })
  ctx.compaction.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => ctx.compaction.summarizeCalls.length === 1)
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  assert.doesNotMatch(await statusText(ctx, agent), /model-not-allowed/)
  ctx.compaction.releaseAll()
  await waitForPhase(ctx, agent, 'READY')
  await ctx.dispose()
})

test('automatic retention follows the backend policy, not legacy plugin config', async () => {
  /** @param {number} backendRetainTokens */
  async function shadowedCount(backendRetainTokens) {
    const { ctx, agent } = setup(
      // Legacy keys must be ignored; only the backend's own retainTokens counts.
      { fixedThreshold: 0.01, retainTokens: 4096, retainRatio: 0.9 },
      {
        session: { turns: 8, toolPairs: 1, turnOpen: true, extraTokens: 20_000 },
        ctxOptions: { compaction: { config: { retainTokens: backendRetainTokens } } },
      },
    )
    ctx.compaction.holdSummaries = true
    await preStep(ctx, agent)
    await waitFor(() => ctx.compaction.summarizeCalls.length === 1, { label: 'automatic summary' })
    // buildSummarizationInput = system head + one message per shadowed node.
    const shadowed = ctx.compaction.summarizeCalls[0].input.messages.length - 1
    ctx.compaction.releaseAll()
    await ctx.dispose()
    return shadowed
  }

  const aggressive = await shadowedCount(32) // keep a tiny tail -> shadow more
  const conservative = await shadowedCount(512) // keep a large tail -> shadow less
  assert.ok(aggressive > conservative, `retainTokens must drive the range (${aggressive} vs ${conservative})`)
})

test('the sampling interval comes from the internal constant, not legacy config', async () => {
  // growthSamplingInterval/growthWindow/emaAlpha are no longer config; the
  // coordinator uses GROWTH_SAMPLING_INTERVAL_MS (5000, clamped to [1000,10000]).
  const { ctx } = setup({ growthSamplingInterval: 1, growthWindow: 2, emaAlpha: 0.9 })
  assert.equal(ctx.intervals.length, 1)
  assert.equal(ctx.intervals[0].ms, 5000)
  await ctx.dispose()
})

test('a summary that is not smaller than the shadowed span fails closed without committing', async () => {
  const { ctx, session, agent } = setup()
  // A framed checkpoint far larger than the shadowed range must be refused.
  ctx.compaction.summaryText = 'x'.repeat(50_000)
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'FAILED')
  assert.match(await statusText(ctx, agent), /Last failure: not-smaller/)
  assert.deepEqual(pluginEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  assert.equal(session.surface.replaceGeneration, 0)
  assert.ok(ctx.hasLog('background pre-compaction failed'))
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// alternative service resolution
// ---------------------------------------------------------------------------

test('a preset-scoped compaction backend is found through agentPresets', async () => {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG }, { withoutCompaction: true })
  const presetBackend = createFakeCompactionBackend()
  ctx.agentPresets.serviceFor = (agent, name) => (name === 'compaction' ? presetBackend : undefined)
  const session = ctx.sessions.add(makeSession({ turns: 8, toolPairs: 1, turnOpen: true, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))

  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  assert.equal(presetBackend.summarizeCalls.length, 1)
  await ctx.dispose()
})

test('context capacity can come from llm.resolveModelInfo when the meter has none', async () => {
  const { ctx, agent } = setup(
    {},
    { session: { turns: 8, toolPairs: 1, turnOpen: true, extraTokens: 20_000, contextWindow: null } },
  )
  ctx.llm.setModel(agent.session.provider, agent.session.model, {
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 1024,
  })

  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  assert.equal(ctx.llm.resolveModelInfoCalls.length, 1)
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// degraded profiles
// ---------------------------------------------------------------------------

test('without a token meter the plugin stays inert instead of failing', async () => {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG }, { withoutTokenMeter: true })
  const session = ctx.sessions.add(makeSession({ turns: 4, toolPairs: 1, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))
  await preStep(ctx, agent)
  await waitFor(() => ctx.hasLog('no token meter is mounted'))
  await settle()
  assert.equal(ctx.compaction.summarizeCalls.length, 0)
  await ctx.dispose()
})

test('without a compaction backend the trigger is deferred, not failed', async () => {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG }, { withoutCompaction: true })
  const session = ctx.sessions.add(makeSession({ turns: 4, toolPairs: 1, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))
  await preStep(ctx, agent)
  await waitFor(() => ctx.hasLog('no compaction backend mounted'))
  await settle()
  assert.equal(ctx.compaction.summarizeCalls.length, 0)
  await ctx.dispose()
})

test('without a live agent the trigger is deferred', async () => {
  const { ctx } = spawnPlugin({ ...BASE_CONFIG })
  const session = ctx.sessions.add(makeSession({ turns: 4, toolPairs: 1, extraTokens: 20_000 }))
  // Deliberately no agent registered for this session; sampling is event-driven.
  session.append('user/message', userMessage('trigger without an agent'), { surfaceOp: 'append' })
  await waitFor(() => ctx.hasLog('no live agent'))
  await settle()
  assert.equal(ctx.compaction.summarizeCalls.length, 0)
  await ctx.dispose()
})
