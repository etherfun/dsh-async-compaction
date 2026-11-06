/**
 * End-to-end: pressure sampling -> background summary -> READY -> atomic commit
 * at the next safe boundary, plus the dry-run path.
 * @module test/e2e.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG } from '../src/surface.js'
import {
  assistantMessage,
  eventsOfType,
  makeAgent,
  makeSession,
  preStep,
  spawnPlugin,
  statusText,
  userMessage,
  waitFor,
  waitForPhase,
} from './fake-harness.js'

const E2E_CONFIG = Object.freeze({
  triggerMode: 'fixed',
  fixedThreshold: 0.05,
  minInterval: 60_000,
  minShadowedTokens: 0,
  logLevel: 'info',
})

/**
 * A ~60-message session (system + 14 turns with a tool pair each).
 * @param {Record<string, any>} [overrides]
 */
function setupE2E(overrides = {}) {
  const { ctx } = spawnPlugin({ ...E2E_CONFIG, ...overrides })
  ctx.compaction.holdSummaries = true
  const session = ctx.sessions.add(
    makeSession({
      id: 'e2e-session',
      turns: 15,
      toolPairs: 1,
      turnOpen: true,
      extraTokens: 20_000,
    }),
  )
  const agent = ctx.agents.add(makeAgent(session))
  return { ctx, session, agent }
}

/** Append one user message and wait until the background task is really running. */
async function triggerAndHold(ctx, session) {
  session.append('user/message', userMessage('While the summary runs, please also review the e2e flow.'), {
    surfaceOp: 'append',
  })
  await waitFor(() => ctx.compaction.pendingCount() === 1, { label: 'background summary to start' })
}

/** Append the messages that must survive the commit. */
function appendDuringCompression(session) {
  const user = session.append('user/message', userMessage('message added while the summary is in flight'), {
    surfaceOp: 'append',
  })
  const assistant = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 0,
      message: assistantMessage({
        text: 'assistant reply while the summary is in flight',
        provider: session.provider,
        model: session.model,
      }),
    },
    { surfaceOp: 'append' },
  )
  const followUp = session.append('user/message', userMessage('one more follow-up after that reply'), {
    surfaceOp: 'append',
  })
  return [user, assistant, followUp]
}

// ---------------------------------------------------------------------------
// full flow
// ---------------------------------------------------------------------------

test('60-message session: background summary then pre-step commit preserves every later message', async () => {
  const { ctx, session, agent } = setupE2E()
  const messageCountBeforeTrigger = session.surface.nodes.length
  assert.ok(messageCountBeforeTrigger >= 60, `expected a ~60 message session, got ${messageCountBeforeTrigger}`)

  await triggerAndHold(ctx, session)
  assert.match(await statusText(ctx, agent), /Task state: (COMPRESSING|SNAPSHOTTING)/)
  const added = appendDuringCompression(session)
  const addedSeqs = added.map((event) => event.seq)

  const surfaceAtCompression = [...session.surface.nodes]
  const logLengthBeforeApply = session.log.length

  ctx.compaction.releaseAll()
  await waitForPhase(ctx, agent, 'READY')

  // ---- atomic commit at the pre-step boundary
  await preStep(ctx, agent)
  assert.equal(session.log.length, logLengthBeforeApply + 4)

  const tail = session.log.slice(-4)
  assert.deepEqual(tail.map((event) => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ])
  const [startEvent, summaryEvent, replaceEvent, endEvent] = tail
  const compactionId = startEvent.data.compactionId
  const shadowedSeqs = [...summaryEvent.data.shadowedSeqs]
  const shadowedSet = new Set(shadowedSeqs)
  const replaceOp = replaceEvent.surfaceOp

  // ---- event envelope and payloads
  assert.deepEqual(startEvent.data, { compactionId, turn: 1 })
  assert.deepEqual(endEvent.data, { compactionId, turn: 1 })
  assert.equal(compactionId, replaceEvent.data.source.compactionId)
  assert.equal(startEvent.seq, summaryEvent.seq - 1)
  assert.equal(summaryEvent.seq, replaceEvent.seq - 1)
  assert.equal(replaceEvent.seq, endEvent.seq - 1)
  assert.deepEqual(replaceEvent.sourceEventSeqs, [startEvent.seq, summaryEvent.seq, ...shadowedSeqs])

  // compaction/summary carries the native payload shape
  assert.equal(summaryEvent.data.compactionId, compactionId)
  assert.deepEqual(summaryEvent.data.shadowedRange, { start: replaceOp.startSeq, end: replaceOp.endSeq })
  assert.deepEqual(summaryEvent.data.shadowedSeqs, shadowedSeqs)
  assert.equal(typeof summaryEvent.data.shadowedTokenCount, 'number')
  assert.ok(summaryEvent.data.shadowedTokenCount > 0)
  assert.equal(summaryEvent.data.provider, 'fake-provider')
  assert.equal(summaryEvent.data.model, 'fake-model')
  assert.equal(summaryEvent.data.llmStreamCall, true)
  assert.ok(Array.isArray(summaryEvent.data.rawOutput))
  assert.equal(typeof summaryEvent.data.maxTokens, 'number')
  assert.deepEqual(summaryEvent.data.usage, { inputTokens: 100, outputTokens: 20 })
  assert.ok(Array.isArray(summaryEvent.data.summary))
  assert.ok(summaryEvent.data.summary.every((block) => block.type === 'text'))
  assert.ok(summaryEvent.data.summary.some((block) => block.text.includes('Primary Request')))
  assert.ok(shadowedSeqs.length > 20, `expected a meaningful shadowed range, got ${shadowedSeqs.length}`)

  // the replacement is a compact-checkpoint user message
  assert.equal(replaceOp.op, 'replace')
  assert.equal(replaceEvent.data.role, 'user')
  assert.deepEqual(replaceEvent.data.source, { kind: 'compact-checkpoint', compactionId })
  assert.equal(typeof replaceEvent.data.id, 'string')
  assert.ok(replaceEvent.data.content[0].text.startsWith(CHECKPOINT_PREAMBLE))
  assert.ok(replaceEvent.data.content[0].text.includes(SUMMARY_OPEN_TAG))
  assert.equal(replaceEvent.data.content.at(-1).text, SUMMARY_CLOSE_TAG)

  // ---- the surface is exactly [system head, checkpoint, retained, later appends]
  const expectedSurface = [
    surfaceAtCompression[0],
    replaceEvent.seq,
    ...surfaceAtCompression.slice(1).filter((seq) => !shadowedSet.has(seq)),
  ]
  assert.deepEqual([...session.surface.nodes], expectedSurface)
  assert.equal(session.eventAt(session.surface.nodes[0]).type, 'system/message')
  for (const seq of shadowedSeqs) {
    assert.equal(session.surface.nodes.includes(seq), false, `shadowed node ${seq} still surfaced`)
  }
  assert.deepEqual(session.surface.nodes.slice(-3), addedSeqs, 'the three in-flight messages are still at the tail')
  assert.equal(new Set(session.surface.nodes).size, session.surface.nodes.length, 'no duplicated surface node')

  // ---- no message loss: every retained message id is still derivable exactly once
  const derivedIds = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.data.message
    derivedIds.push(message.id)
  }
  assert.equal(new Set(derivedIds).size, derivedIds.length)
  assert.equal(derivedIds.length, session.surface.nodes.length, 'every surface node derives a message')
  for (const seq of addedSeqs) {
    const event = session.eventAt(seq)
    const messageId = event.type === 'user/message' ? event.data.id : event.data.message.id
    assert.ok(derivedIds.includes(messageId), 'an appended message disappeared from the history')
  }
  assert.ok(derivedIds.includes(replaceEvent.data.id))

  // ---- the tool chain is still balanced (every tool-call has its result somewhere)
  let calls = 0
  let results = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event.type === 'assistant/message') {
      calls += event.data.message.content.filter((block) => block.type === 'tool-call').length
    } else if (event.type === 'tool/result') {
      results += 1
    }
  }
  assert.equal(calls, results)
  assert.ok(calls > 0)

  // ---- the summarizer saw the exact prefix (system head + shadowed messages + tools)
  const summarizeCall = ctx.compaction.summarizeCalls[0]
  assert.equal(summarizeCall.input.messages[0].role, 'system')
  assert.ok(summarizeCall.input.tools.length > 0)
  assert.equal(summarizeCall.input.messages.length, shadowedSeqs.length + 1) // every message derives

  // ---- bookkeeping and status
  assert.equal(session.surface.replaceGeneration, 1)
  assert.equal(session.surface.contentGeneration, 1)
  assert.equal(ctx.compaction.summarizeCalls.length, 1, 'the commit must not start another summary')
  const status = await statusText(ctx, agent)
  assert.match(status, /Task state: COMPLETED/)
  assert.match(status, /Last result: shadowed \d+ nodes/)
  assert.ok(ctx.hasLog('background pre-compaction applied'))
  assert.ok(ctx.hasLog('background pre-compaction ready'))
  await ctx.dispose()
})

test('dryRun computes the result but never appends an event', async () => {
  const { ctx, session, agent } = setupE2E({ dryRun: true })
  await triggerAndHold(ctx, session)
  appendDuringCompression(session)
  ctx.compaction.releaseAll()
  await waitForPhase(ctx, agent, 'READY')

  const logLength = session.log.length
  const surfaceBefore = [...session.surface.nodes]
  const replaceGeneration = session.surface.replaceGeneration
  const contentGeneration = session.surface.contentGeneration

  await preStep(ctx, agent)

  assert.equal(session.log.length, logLength, 'dryRun must not append any event')
  assert.deepEqual(session.surface.nodes, surfaceBefore, 'dryRun must not rewrite the surface')
  assert.equal(session.surface.replaceGeneration, replaceGeneration)
  assert.equal(session.surface.contentGeneration, contentGeneration)
  assert.equal(eventsOfType(session, 'compaction/start').length, 0)
  assert.equal(eventsOfType(session, 'compaction/summary').length, 0)
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)

  const status = await statusText(ctx, agent)
  assert.match(status, /Task state: COMPLETED/)
  assert.match(status, /Last result \(dry run\): would shadow \d+ nodes/)
  assert.ok(ctx.hasLog('dry run: pre-compaction would have been applied'))
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  await ctx.dispose()
})

test('a small session below the shadow threshold is never summarized (integration)', async () => {
  const { ctx } = spawnPlugin({
    ...E2E_CONFIG,
    minShadowedTokens: 4096,
  })
  ctx.compaction.holdSummaries = true
  const session = ctx.sessions.add(makeSession({ turns: 4, toolPairs: 0, extraTokens: 20_000, turnOpen: true }))
  const agent = ctx.agents.add(makeAgent(session))

  await preStep(ctx, agent)
  await waitFor(async () => (await statusText(ctx, agent)).includes('Last skip: range-too-small'))
  assert.equal(ctx.compaction.summarizeCalls.length, 0)
  assert.equal(eventsOfType(session, 'compaction/start').length, 0)
  await ctx.dispose()
})
