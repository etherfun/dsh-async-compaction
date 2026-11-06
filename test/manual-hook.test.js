/**
 * Manual `/compact` hook: installation/restore, delegation, async background
 * semantics (including superseding automatic work), cancellation, the command
 * surface, and the independent-review regressions.
 * @module test/manual-hook.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { createRuntime } from '../src/coordinator.js'
import { resolveConfig } from '../src/config.js'
import {
  DEFAULT_SUMMARY_TEXT,
  FakeCtx,
  agentDisposed,
  delay,
  deferred,
  eventsOfType,
  makeAgent,
  makeSession,
  preStep,
  rewriteToolResult,
  runCommand,
  sessionDisposed,
  statusText,
  waitFor,
  waitForPhase,
} from './fake-harness.js'

const MANUAL_CONFIG = Object.freeze({
  triggerMode: 'fixed',
  // The automatic path must stay quiet unless a test opts into it.
  fixedThreshold: 1,
  minInterval: 60_000,
  minShadowedTokens: 0,
  logLevel: 'debug',
})

/**
 * Create a fake ctx with a native-style backend, capture the original
 * `compactNow`, boot the plugin, then add one session/agent pair.
 * @param {Record<string, any>} [config]
 * @param {{ session?: Record<string, any>, compaction?: Record<string, any>, install?: boolean }} [options]
 */
function setupManual(config = {}, options = {}) {
  const ctx = new FakeCtx({ compaction: { summaryText: DEFAULT_SUMMARY_TEXT, ...(options.compaction ?? {}) } })
  const backend = ctx.compaction
  const originalCompactNow = backend.compactNow
  apply(ctx, { ...MANUAL_CONFIG, ...config })
  const session = ctx.sessions.add(
    makeSession({ turns: 10, toolPairs: 1, turnOpen: true, ...(options.session ?? {}) }),
  )
  const agent = ctx.agents.add(makeAgent(session))
  if (options.install !== false) ctx.emit('agent/created', { agent })
  return { ctx, backend, originalCompactNow, session, agent }
}

/** Wait until all pending microtasks of the evaluation chain have settled. */
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

/** @param {any} promise @param {string} code */
function expectManualError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.name, 'ManualCompactionError', `expected ManualCompactionError, got ${error?.name}`)
    assert.equal(error.code, code, `expected code "${code}", got "${error.code}" (${error.message})`)
    assert.equal(typeof error.message, 'string')
    return true
  })
}

/** @param {any} session */
function compactionEventCounts(session) {
  return {
    starts: eventsOfType(session, 'compaction/start').length,
    summaries: eventsOfType(session, 'compaction/summary').length,
    ends: eventsOfType(session, 'compaction/end').length,
  }
}

/** A manually driven Promise whose settlement is observable. */
function watchPromise(promise) {
  const state = { settled: false, ok: undefined, value: undefined, error: undefined }
  promise.then(
    (value) => {
      state.settled = true
      state.ok = true
      state.value = value
    },
    (error) => {
      state.settled = true
      state.ok = false
      state.error = error
    },
  )
  return state
}

// ---------------------------------------------------------------------------
// installation, takeover and restore
// ---------------------------------------------------------------------------

test('agent/created installs the hook and a manual request resolves a host-shaped result', async () => {
  const { ctx, backend, originalCompactNow, session, agent } = setupManual()
  assert.notEqual(backend.compactNow, originalCompactNow, 'compactNow must be wrapped')
  assert.equal(typeof backend.compactNow, 'function')
  assert.equal(backend.manualCalls.length, 0)
  assert.ok(ctx.hasLog('hooked the manual compaction entry point'))

  backend.holdSummaries = true
  const controller = new AbortController()
  const promise = backend.compactNow(agent, controller.signal, 'cmd-manual-1')
  assert.ok(promise instanceof Promise)
  assert.equal(backend.manualCalls.length, 0, 'the wrapper must not call the original backend')
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary to start' })
  assert.ok(ctx.hasLog('manual compaction request accepted'))
  assert.match(await statusText(ctx, agent), /Manual request: queued /)
  assert.match(await statusText(ctx, agent), /Task state: COMPRESSING/)

  backend.releaseAll()
  const result = await promise

  assert.equal(result.manual, true)
  assert.equal(typeof result.compactionId, 'string')
  assert.equal(typeof result.startSeq, 'number')
  assert.equal(result.summarySeq, result.startSeq + 1)
  assert.equal(result.endSeq, result.startSeq + 3)
  assert.deepEqual(result.summary, [{ type: 'text', text: DEFAULT_SUMMARY_TEXT }])
  assert.ok(Array.isArray(result.shadowedSeqs) && result.shadowedSeqs.length > 0)
  assert.equal(typeof result.shadowedTokenCount, 'number')
  assert.equal(result.turn, 1)
  assert.equal(result.sourceCommandId, 'cmd-manual-1')

  const tail = session.log.slice(-4)
  assert.deepEqual(tail.map((event) => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ])
  assert.deepEqual(result.shadowedRange, tail[1].data.shadowedRange)
  assert.deepEqual(result.shadowedSeqs, tail[1].data.shadowedSeqs)
  assert.equal(result.startSeq, tail[0].seq)
  assert.equal(result.summarySeq, tail[1].seq)
  assert.equal(result.endSeq, tail[3].seq)
  assert.equal(tail[2].data.source.kind, 'compact-checkpoint')

  assert.ok(ctx.hasLog('manual background compaction started'))
  assert.ok(ctx.hasLog('manual background compaction ready'))
  assert.ok(ctx.hasLog(/background pre-compaction applied .*manual=true/))
  assert.doesNotMatch(await statusText(ctx, agent), /Manual request:/)
  await ctx.dispose()
})

test('agent/pre-step installs the hook as a fallback and dispose restores the original', async () => {
  const { ctx, backend, originalCompactNow, agent } = setupManual({}, { install: false })
  assert.equal(backend.compactNow, originalCompactNow, 'nothing installed before an agent event')

  await preStep(ctx, agent)
  assert.notEqual(backend.compactNow, originalCompactNow)
  assert.ok(ctx.hasLog('hooked the manual compaction entry point'))

  await ctx.dispose()
  assert.equal(backend.compactNow, originalCompactNow, 'dispose must restore the original method')
  // The restored entry point is the native one again.
  const result = await backend.compactNow(agent, new AbortController().signal, 'cmd-after-restore')
  assert.equal(backend.manualCalls.length, 1)
  assert.equal(result.manual, undefined)
})

test('restore deletes the own property when compactNow was inherited from the prototype', async () => {
  let prototypeCalls = 0
  const prototype = {
    async compactNow() {
      prototypeCalls += 1
      return { via: 'prototype' }
    },
  }
  const engine = Object.create(prototype)
  const ctx = new FakeCtx()
  ctx.provide('compaction', engine)
  apply(ctx, MANUAL_CONFIG)
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))
  ctx.emit('agent/created', { agent })

  assert.equal(Object.hasOwn(engine, 'compactNow'), true, 'the wrapper is an own property while patched')
  await ctx.dispose()
  assert.equal(Object.hasOwn(engine, 'compactNow'), false, 'restore must remove the wrapper instead of shadowing the prototype')

  const result = await engine.compactNow(agent, new AbortController().signal)
  assert.deepEqual(result, { via: 'prototype' })
  assert.equal(prototypeCalls, 1, 'the restored call goes through the prototype method')
})

// ---------------------------------------------------------------------------
// delegation to the mounted backend
// ---------------------------------------------------------------------------

for (const [label, config] of [
  ['the plugin is disabled', { enabled: false }],
  ['dry-run is enabled', { dryRun: true }],
  ['hookManualCompact is false', { hookManualCompact: false }],
]) {
  test(`compactNow delegates to the mounted backend when ${label}`, async () => {
    const { ctx, backend, session, agent } = setupManual(config)
    const result = await backend.compactNow(agent, new AbortController().signal, 'cmd-native')

    assert.equal(backend.manualCalls.length, 1, 'the original compactNow must be used')
    assert.equal(ctx.hasLog('manual compaction request accepted'), false)
    assert.equal(ctx.hasLog('manual compaction delegated to the background pipeline'), false)
    assert.equal(typeof result.compactionId, 'string')
    assert.deepEqual(eventsOfType(session, 'compaction/end').length, 1)
    assert.equal(eventsOfType(session, 'compaction/end').at(-1).data.error, undefined)
    await ctx.dispose()
  })
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test('a second concurrent manual request is rejected with busy', async () => {
  const { ctx, backend, agent } = setupManual()
  backend.holdSummaries = true
  const first = backend.compactNow(agent, new AbortController().signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'first manual summary' })

  const second = backend.compactNow(agent, new AbortController().signal)
  await expectManualError(second, 'busy')

  backend.releaseAll()
  const result = await first
  assert.equal(result.manual, true)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test('an already-aborted signal is rejected with cancelled and never delegated', async () => {
  const { ctx, backend, session, agent } = setupManual()
  const controller = new AbortController()
  controller.abort()
  await expectManualError(backend.compactNow(agent, controller.signal), 'cancelled')
  assert.equal(backend.manualCalls.length, 0)
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await ctx.dispose()
})

test('aborting the signal while summarizing cancels the request', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const controller = new AbortController()
  const promise = backend.compactNow(agent, controller.signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  const logLength = session.log.length

  controller.abort()
  await expectManualError(promise, 'cancelled')
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  assert.equal(session.log.length, logLength, 'the aborted request writes no event itself')
  await ctx.dispose()
})

test('session/disposed rejects a pending manual request with cancelled', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const promise = backend.compactNow(agent, new AbortController().signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  const logLength = session.log.length

  sessionDisposed(ctx, session)
  await expectManualError(promise, 'cancelled')
  await settle()
  assert.equal(session.log.length, logLength)
  await ctx.dispose()
})

test('agent/disposed rejects a pending manual request with cancelled', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const promise = backend.compactNow(agent, new AbortController().signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  const logLength = session.log.length

  agentDisposed(ctx, agent)
  await expectManualError(promise, 'cancelled')
  await settle()
  assert.equal(session.log.length, logLength)
  await ctx.dispose()
})

test('plugin disposal rejects a pending manual request with cancelled', async () => {
  const { ctx, backend, agent } = setupManual()
  backend.holdSummaries = true
  const promise = backend.compactNow(agent, new AbortController().signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })

  await ctx.dispose()
  await expectManualError(promise, 'cancelled')
})

test('a manual request has no plugin-owned deadline and stays pending until aborted', async () => {
  const { ctx, backend, agent } = setupManual()
  backend.holdSummaries = true
  const controller = new AbortController()
  let settled = false
  const promise = backend.compactNow(agent, controller.signal)
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })

  // The plugin no longer registers a manual deadline at all.
  assert.equal(ctx.timeouts.length, 0, 'the plugin must not register a manual deadline')
  ctx.fireTimeouts()
  ctx.tick(100)
  await settle()
  assert.equal(settled, false, 'advancing the fake clock must not settle the request')

  controller.abort()
  await expectManualError(promise, 'cancelled')
  await ctx.dispose()
})

test('a ready-but-unapplied manual result waits for a boundary instead of timing out', async () => {
  const { ctx, backend, session, agent } = setupManual()
  agent.status = 'running' // keep the ready result from being applied
  backend.holdSummaries = true
  const controller = new AbortController()
  let settled = false
  const promise = backend.compactNow(agent, controller.signal)
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  backend.releaseAll()
  await waitForPhase(ctx, agent, 'READY')
  await settle()

  ctx.fireTimeouts()
  ctx.tick(100)
  await settle()
  assert.equal(settled, false, 'there is no plugin deadline to settle a ready manual result')
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })

  // Only the caller's abort (or a real boundary) can end it now.
  controller.abort()
  await expectManualError(promise, 'cancelled')
  await settle()
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  assert.match(await statusText(ctx, agent), /Task state: CANCELLED/)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// no compactable history
// ---------------------------------------------------------------------------

test('a session with only a system head resolves null instead of rejecting', async () => {
  const { ctx, backend, session, agent } = setupManual({}, { session: { turns: 0, toolPairs: 0 } })
  const result = await backend.compactNow(agent, new AbortController().signal)
  assert.equal(result, null)
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  assert.match(await statusText(ctx, agent), /Last skip: no-compactable-range/)
  await ctx.dispose()
})

test('minShadowedTokens protects only the automatic path, not an explicit manual request', async () => {
  const { ctx, backend, session, agent } = setupManual(
    { minShadowedTokens: 100_000, fixedThreshold: 0.01 },
    { session: { turns: 6, toolPairs: 0, extraTokens: 20_000 } },
  )
  // The automatic path refuses a range that would not free enough context.
  await preStep(ctx, agent)
  await waitFor(async () => (await statusText(ctx, agent)).includes('Last skip: range-too-small'))
  assert.equal(backend.summarizeCalls.length, 0)

  // An explicit /compact is a user decision: it must compact whatever range
  // exists, exactly like the native command.
  const result = await backend.compactNow(agent, new AbortController().signal)
  assert.notEqual(result, null, 'a manual request must not be skipped by minShadowedTokens')
  assert.equal(result.manual, true)
  assert.ok(result.shadowedSeqs.length > 0)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  assert.equal(eventsOfType(session, 'compaction/end').at(-1).data.error, undefined)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// boundaries
// ---------------------------------------------------------------------------

test('a running agent gets the result at its next pre-step boundary', async () => {
  const { ctx, backend, session, agent } = setupManual()
  agent.status = 'running'
  backend.holdSummaries = true
  let settled = false
  const promise = backend.compactNow(agent, new AbortController().signal)
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  backend.releaseAll()
  await waitForPhase(ctx, agent, 'READY')
  await settle()
  assert.equal(settled, false, 'a running agent must not be compacted at idle')
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })

  await preStep(ctx, agent)
  const result = await promise
  assert.equal(result.manual, true)
  assert.deepEqual(compactionEventCounts(session), { starts: 1, summaries: 1, ends: 1 })
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// superseding automatic work (independent-review fix #1)
// ---------------------------------------------------------------------------

test('a manual request discards an existing automatic READY result and compacts with manual semantics', async () => {
  const { ctx, backend, session, agent } = setupManual(
    { fixedThreshold: 0.01 },
    { session: { turns: 10, toolPairs: 1, turnOpen: true, extraTokens: 20_000 } },
  )
  backend.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => backend.pendingCount() === 1, { label: 'automatic summary' })
  backend.releaseAll()
  await waitForPhase(ctx, agent, 'READY')
  assert.equal(backend.summarizeCalls.length, 1)

  // The automatic range uses the backend's retained tail; the manual range must
  // not reuse it (the surface is unchanged because the ready result was never applied).
  const nodesBeforeManual = [...session.surface.nodes]
  backend.holdSummaries = false
  const result = await backend.compactNow(agent, new AbortController().signal)

  assert.equal(result.manual, true)
  assert.equal(backend.summarizeCalls.length, 2, 'the automatic summary must not be reused')
  assert.ok(ctx.hasLog('manual request superseded automatic pre-compaction work'))
  assert.deepEqual(compactionEventCounts(session), { starts: 1, summaries: 1, ends: 1 }, 'only the manual commit lands')

  // Native manual retention: keep the system head and only the last node.
  assert.equal(result.shadowedRange.start, nodesBeforeManual[1])
  assert.equal(result.shadowedRange.end, nodesBeforeManual[nodesBeforeManual.length - 2])
  assert.deepEqual(result.shadowedSeqs, nodesBeforeManual.slice(1, nodesBeforeManual.length - 1))
  await ctx.dispose()
})

test('an in-flight automatic task is abandoned when a manual request arrives', async () => {
  const { ctx, backend, session, agent } = setupManual(
    { fixedThreshold: 0.01 },
    { session: { turns: 10, toolPairs: 1, turnOpen: true, extraTokens: 20_000 } },
  )
  backend.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => backend.pendingCount() === 1, { label: 'automatic summary' })
  const automaticCall = backend.summarizeCalls[0]

  // The manual request supersedes the automatic task; its own summary completes.
  backend.holdSummaries = false
  const promise = backend.compactNow(agent, new AbortController().signal)
  await waitFor(() => backend.summarizeCalls.length === 2, { label: 'manual summary' })
  assert.equal(automaticCall.signal.aborted, true, 'the automatic task must be aborted')

  const result = await promise
  assert.equal(result.manual, true)
  assert.equal(backend.summarizeCalls.length, 2)
  assert.ok(ctx.hasLog('manual request superseded automatic pre-compaction work'))
  // The abandoned automatic task settles late without writing anything.
  backend.releaseAll()
  await settle()
  assert.deepEqual(compactionEventCounts(session), { starts: 1, summaries: 1, ends: 1 })
  assert.doesNotMatch(await statusText(ctx, agent), /Last failure: (summary|small-reduction|not-smaller)/)
  await ctx.dispose()
})

test('an automatic small-reduction failure never rejects a waiting manual request', async () => {
  const { ctx, backend, session, agent } = setupManual(
    { fixedThreshold: 0.01 },
    { session: { turns: 10, toolPairs: 1, turnOpen: true, extraTokens: 20_000 } },
  )
  // If the automatic task were allowed to finish, this summary would fail the
  // automatic-only 5% minimum-reduction gate.
  backend.summaryText = 'x'.repeat(20_000)
  backend.holdSummaries = true
  await preStep(ctx, agent)
  await waitFor(() => backend.pendingCount() === 1, { label: 'automatic summary' })

  // The manual request supersedes it; the manual task has its own (shorter) summary.
  backend.summaryText = DEFAULT_SUMMARY_TEXT
  backend.holdSummaries = false
  const promise = backend.compactNow(agent, new AbortController().signal)
  const result = await promise

  assert.equal(result.manual, true)
  assert.equal(backend.summarizeCalls.length, 2)
  assert.deepEqual(compactionEventCounts(session), { starts: 1, summaries: 1, ends: 1 })
  const status = await statusText(ctx, agent)
  assert.match(status, /Task state: COMPLETED/)
  assert.doesNotMatch(status, /Last failure: (small-reduction|not-smaller)/)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// payload details
// ---------------------------------------------------------------------------

test('sourceCommandId is carried into the result, checkpoint source and compaction events', async () => {
  const { ctx, backend, session, agent } = setupManual()
  const result = await backend.compactNow(agent, new AbortController().signal, 'cmd-x')
  assert.equal(result.sourceCommandId, 'cmd-x')

  const [startEvent, summaryEvent, replaceEvent, endEvent] = session.log.slice(-4)
  assert.equal(startEvent.data.sourceCommandId, 'cmd-x')
  assert.equal(summaryEvent.data.sourceCommandId, 'cmd-x')
  assert.equal(endEvent.data.sourceCommandId, 'cmd-x')
  // The replacement message carries the host-shaped checkpoint source, including
  // the manual command id (independent-review fix #2).
  assert.deepEqual(replaceEvent.data.source, {
    kind: 'compact-checkpoint',
    compactionId: result.compactionId,
    sourceCommandId: 'cmd-x',
  })
  assert.equal(result.compactionId, summaryEvent.data.compactionId)
  await ctx.dispose()
})

test('manual /compact always keeps only the last surface node (retain=0, native semantics)', async () => {
  // Retention is not configurable: the manual path always uses the native
  // `retainTokens = 0` range. Legacy keys must not change it.
  const { ctx, backend, session, agent } = setupManual({ retainTokens: 4096, retainRatio: 0.9, manualCompactRetainTokens: 16 })
  const nodesBefore = [...session.surface.nodes]
  const result = await backend.compactNow(agent, new AbortController().signal)

  assert.equal(result.shadowedRange.start, nodesBefore[1])
  assert.equal(result.shadowedRange.end, nodesBefore[nodesBefore.length - 2])
  assert.deepEqual(result.shadowedSeqs, nodesBefore.slice(1, nodesBefore.length - 1))
  assert.equal(result.shadowedSeqs.includes(nodesBefore[0]), false, 'the system head is never shadowed')
  assert.ok(result.shadowedSeqs.length >= nodesBefore.length - 2)

  // The retained tail is just the final node: only the head and the replacement
  // survive the commit.
  assert.deepEqual([...session.surface.nodes].slice(0, 2), [nodesBefore[0], result.summarySeq + 1])
  await ctx.dispose()
})

test('a preset-scoped backend is hooked through agentPresets', async () => {
  const ctx = new FakeCtx({ withoutCompaction: true, compaction: { summaryText: DEFAULT_SUMMARY_TEXT } })
  const backend = ctx.compaction
  const originalCompactNow = backend.compactNow
  ctx.agentPresets.serviceFor = (agent, name) => (name === 'compaction' ? backend : undefined)
  apply(ctx, MANUAL_CONFIG)
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))
  ctx.emit('agent/created', { agent })
  assert.notEqual(backend.compactNow, originalCompactNow)
  assert.equal(ctx.get('compaction'), undefined)

  const result = await backend.compactNow(agent, new AbortController().signal)
  assert.equal(result.manual, true)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  await ctx.dispose()
  assert.equal(backend.compactNow, originalCompactNow)
})

// ---------------------------------------------------------------------------
// flush durability checkpoint (independent-review suggestion #4)
// ---------------------------------------------------------------------------

test('a manual commit asks the host to flush the session', async () => {
  const { ctx, backend, session, agent } = setupManual()
  const result = await backend.compactNow(agent, new AbortController().signal)
  assert.equal(result.manual, true)
  assert.equal(ctx.sessions.flushes.length, 1, 'the manual commit must flush the session once')
  assert.equal(ctx.sessions.flushes[0], session)
  await ctx.dispose()
})

test('a flush failure is logged and does not reject the manual request', async () => {
  const { ctx, backend, agent } = setupManual()
  ctx.sessions.flushError = new Error('disk full')
  const result = await backend.compactNow(agent, new AbortController().signal)
  assert.equal(result.manual, true)
  await waitFor(() => ctx.hasLog('manual compaction flush failed'))
  assert.ok(ctx.hasLog(/manual compaction flush failed .*disk full/))
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// command surface
// ---------------------------------------------------------------------------

test('/precompact compact awaits the background request and reports the result', async () => {
  const { ctx, session, agent } = setupManual()
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact', agent })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /^Compacted \d+ history items \(~\d+ tokens\) in the background\.$/)
  assert.equal(typeof response.sourceEventSeq, 'number')
  assert.deepEqual(eventsOfType(session, 'compaction/end').length, 1)
  await ctx.dispose()
})

test('/precompact compact reports unavailability in dry-run mode', async () => {
  const { ctx, agent } = setupManual({ dryRun: true })
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact', agent })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /Background compaction is unavailable/)
  await ctx.dispose()
})

test('/precompact compact reports unavailability when hookManualCompact is false', async () => {
  const { ctx, agent } = setupManual({ hookManualCompact: false })
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact', agent })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /Background compaction is unavailable/)
  await ctx.dispose()
})

test('/precompact compact requires an agent session', async () => {
  const { ctx } = setupManual()
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact' })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /requires an agent session/)
  await ctx.dispose()
})

test('/precompact compact reports the empty-history case', async () => {
  const { ctx, agent } = setupManual({}, { session: { turns: 0, toolPairs: 0 } })
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact', agent })
  assert.equal(response.kind, 'success')
  assert.equal(response.text, 'No compactable history yet.')
  await ctx.dispose()
})

test('/precompact compact reports unavailability while paused', async () => {
  const { ctx, agent } = setupManual()
  await runCommand(ctx, 'precompact', { rawInput: 'pause' })
  const response = await runCommand(ctx, 'precompact', { rawInput: 'compact', agent })
  assert.equal(response.kind, 'error')
  assert.match(response.text, /Background compaction is unavailable/)
  await ctx.dispose()
})

test('a legacy manualCompactTimeoutSeconds config key is ignored (no deadline registered)', async () => {
  const { ctx, backend, agent } = setupManual({ manualCompactTimeoutSeconds: 0 })
  backend.holdSummaries = true
  const controller = new AbortController()
  const promise = backend.compactNow(agent, controller.signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  assert.equal(ctx.timeouts.length, 0, 'a removed config key must not create a deadline')

  backend.releaseAll()
  const result = await promise
  assert.equal(result.manual, true)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// cancellation regressions (former independent-review defects)
// ---------------------------------------------------------------------------

test('an aborted manual request does not commit later', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const controller = new AbortController()
  const promise = backend.compactNow(agent, controller.signal)
  await waitFor(() => backend.pendingCount() === 1, { label: 'manual summary' })
  controller.abort()
  await expectManualError(promise, 'cancelled')
  backend.releaseAll()
  await settle()
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await preStep(ctx, agent)
  await settle()
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await ctx.dispose()
})

test('a surface invalidation during the manual summary never applies a stale result', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const promise = backend.compactNow(agent, new AbortController().signal, 'cmd-retry')
  await waitFor(() => backend.pendingCount() === 1, { label: 'first manual summary' })

  const target = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'tool/result')
  rewriteToolResult(session, target, 'pruned during the manual summary')
  await delay(50)

  assert.equal(eventsOfType(session, 'compaction/end').length, 0, 'the stale snapshot must not be committed')
  assert.ok(backend.summarizeCalls.length >= 2, 'the invalidation retries under manual semantics')

  backend.releaseAll()
  const settled = await promise.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  )
  assert.equal(eventsOfType(session, 'compaction/end').length, 1, 'exactly one fresh manual commit lands')
  if (settled.ok) {
    assert.equal(settled.result.manual, true)
  } else {
    assert.equal(settled.error.name, 'ManualCompactionError')
    assert.ok(['changed', 'summary', 'cancelled'].includes(settled.error.code), `unexpected code ${settled.error.code}`)
  }
  await ctx.dispose()
})

test('a changed history retries a manual request once', async () => {
  const { ctx, backend, session, agent } = setupManual()
  backend.holdSummaries = true
  const resultPromise = backend.compactNow(agent, new AbortController().signal, 'cmd-retry')
  await waitFor(() => backend.pendingCount() === 1, { label: 'first manual summary' })

  const target = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'tool/result')
  rewriteToolResult(session, target, 'pruned during the manual summary')

  await waitFor(() => backend.summarizeCalls.length === 2 && backend.pendingCount() === 1, {
    label: 'manual retry',
  })
  backend.releaseAll()
  const result = await resultPromise
  assert.equal(result.manual, true)
  assert.equal(backend.summarizeCalls.length, 2)
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// internal-state regressions (white-box: the branches need injected state)
// ---------------------------------------------------------------------------

/** @param {any} state @param {string} [id] */
function injectPendingManual(state, id = 'injected-manual') {
  const deferredManual = deferred()
  deferredManual.promise.catch(() => {})
  /** @type {any} */
  const manual = {
    id,
    requestedAt: Date.now(),
    sourceCommandId: undefined,
    signal: undefined,
    onAbort: undefined,
    timerStop: undefined,
    retried: false,
    promise: deferredManual.promise,
    resolve: (value) => deferredManual.resolve(value),
    reject: (error) => deferredManual.reject(error),
  }
  state.manual = manual
  return { manual, deferred: deferredManual }
}

test('a manual request whose session goes away before its task starts rejects cancelled', async () => {
  const { ctx, backend, session, agent } = setupManual()
  const promise = backend.compactNow(agent, new AbortController().signal)
  // `tryManualCompaction()` has already accepted the request and started the
  // async beginManualTask(); the session disappears before the first await resumes.
  sessionDisposed(ctx, session)
  await expectManualError(promise, 'cancelled')
  await settle()
  assert.deepEqual(compactionEventCounts(session), { starts: 0, summaries: 0, ends: 0 })
  await ctx.dispose()
})

test('pruneStates keeps a session whose manual request is still pending', async () => {
  const ctx = new FakeCtx()
  const runtime = createRuntime(ctx, resolveConfig({}).config)
  const sessions = []
  for (let index = 0; index < 34; index += 1) {
    const session = ctx.sessions.add(makeSession({ id: `prune-${index}`, turns: 0, systemText: null }))
    sessions.push(session)
    runtime._internals.stateFor(session)
  }
  const pendingSession = sessions[0]
  const pendingState = runtime._internals.stateFor(pendingSession)
  injectPendingManual(pendingState, 'manual-1')

  // Creating more states pushes the table past its cap and triggers pruning.
  for (let index = 34; index < 40; index += 1) {
    const session = ctx.sessions.add(makeSession({ id: `prune-${index}`, turns: 0, systemText: null }))
    runtime._internals.stateFor(session)
  }

  const status = runtime.statusFor(pendingSession.id)
  assert.notEqual(status, null, 'a state with a pending manual request must survive pruning')
  assert.equal(status.manualRequest.id, 'manual-1')
  runtime.dispose()
})
