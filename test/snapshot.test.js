/**
 * Snapshot selection for manual compactions made while a step is in flight.
 * The current step is preserved as the baseline; only older history is shadowed.
 * @module test/snapshot.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { createSnapshot } from '../src/snapshot.js'
import {
  DEFAULT_SYSTEM_TEXT,
  FakeCtx,
  assistantMessage,
  makeSession,
  systemMessage,
  textBlock,
  toolCallBlock,
  toolResultMessage,
  userMessage,
} from './fake-harness.js'

/** @param {any} session @param {Record<string, any>} [overrides] */
function native(session, overrides = {}) {
  return {
    known: true,
    source: 'backend-config',
    provider: session.provider,
    model: session.model,
    contextWindow: 200_000,
    thresholdTokens: 160_000,
    thresholdRatio: 0.8,
    retainTokens: 128,
    ...overrides,
  }
}

/** @param {FakeCtx} ctx @param {any} session */
function measurementOf(ctx, session) {
  return ctx.get('tokenMeter').measure(session)
}

/** @param {any} session @param {Record<string, any>} [overrides] */
function snapshotFor(ctx, session, overrides = {}) {
  return createSnapshot({
    session,
    measurement: measurementOf(ctx, session),
    config: resolveConfig({ minShadowedTokens: 0 }).config,
    native: native(session),
    route: { provider: session.provider, model: session.model },
    triggerTokens: null,
    manual: true,
    now: 1_000,
    ...overrides,
  })
}

/** Session with completed history followed by one in-flight step. @param {{ turns?: number }} [options] */
function sessionWithRunningStep(options = {}) {
  const ctx = new FakeCtx()
  const session = ctx.sessions.add(makeSession({ turns: options.turns ?? 4, toolPairs: 0, turnOpen: true }))
  const stepStartSeq = session.seq
  session.append('step/start', { turn: 5, step: 0 })
  session.append('user/message', userMessage("Current step request: keep this work untouched."), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 5,
      step: 0,
      message: assistantMessage({
        text: 'Current step reply: work in progress.',
        provider: session.provider,
        model: session.model,
      }),
    },
    { surfaceOp: 'append' },
  )
  return { ctx, session, stepStartSeq }
}

test('a manual snapshot with preserveFromSeq keeps the in-flight step and shadows only earlier history', () => {
  const { ctx, session, stepStartSeq } = sessionWithRunningStep()
  const nodes = [...session.surface.nodes]
  const preservedNodes = nodes.filter((seq) => seq >= stepStartSeq)
  assert.ok(preservedNodes.length >= 2)

  const { snapshot } = snapshotFor(ctx, session, { preserveFromSeq: stepStartSeq })
  assert.equal(snapshot.manual, true)
  assert.equal(snapshot.preserveFromSeq, stepStartSeq)
  assert.ok(snapshot.endSeq < stepStartSeq, 'the compaction ends before the in-flight step starts')
  assert.equal(snapshot.startSeq, nodes[1], 'the system head stays outside the shadowed range')
  for (const seq of preservedNodes) {
    assert.equal(snapshot.shadowedSeqs.includes(seq), false, `current-step node ${seq} must not be shadowed`)
  }
  assert.equal(snapshot.shadowedSeqs.includes(stepStartSeq), false)
  assert.ok(snapshot.shadowedSeqs.length > 0)
  assert.ok(snapshot.shadowedSeqs.every((seq) => seq < stepStartSeq))
})

test('without preserveFromSeq manual compaction keeps the native retain-0 behavior', () => {
  const { ctx, session } = sessionWithRunningStep()
  const nodes = [...session.surface.nodes]

  const { snapshot } = snapshotFor(ctx, session)
  assert.equal(snapshot.preserveFromSeq, null)
  assert.equal(snapshot.startSeq, nodes[1])
  assert.equal(snapshot.endSeq, nodes[nodes.length - 2], 'only the last surface node is retained')
  assert.deepEqual(snapshot.shadowedSeqs, nodes.slice(1, nodes.length - 1))
})

test('a preserve cutoff without earlier history is skipped as no-compactable-range', () => {
  const ctx = new FakeCtx()
  const session = ctx.sessions.add(makeSession({ turns: 0, toolPairs: 0 }))
  const stepStartSeq = session.seq
  session.append('step/start', { turn: 1, step: 0 })
  session.append('user/message', userMessage('Only the in-flight step exists.'), { surfaceOp: 'append' })

  const result = snapshotFor(ctx, session, { preserveFromSeq: stepStartSeq })
  assert.deepEqual(result, { skip: 'no-compactable-range' })
})

test('a preserve cutoff at the first compressible node is skipped as no-compactable-range', () => {
  const { ctx, session } = sessionWithRunningStep()
  const nodes = [...session.surface.nodes]
  // Cutoff at the first node after the system head leaves nothing to shadow.
  const result = snapshotFor(ctx, session, { preserveFromSeq: nodes[1] })
  assert.deepEqual(result, { skip: 'no-compactable-range' })
})

test('the preserve cutoff does not split a tool pair even when it sits before the step', () => {
  const ctx = new FakeCtx()
  const session = ctx.sessions.add(makeSession({ turns: 0, toolPairs: 0, systemText: DEFAULT_SYSTEM_TEXT }))
  session.append('user/message', userMessage('Earlier request'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 0,
      message: assistantMessage({
        text: 'Reading a file',
        toolCalls: [toolCallBlock('read_file', { path: 'src/a.js' }, 'call-a')],
        provider: session.provider,
        model: session.model,
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('tool/result', {
    turn: 1,
    step: 0,
    message: toolResultMessage({ callId: 'call-a', text: 'file contents' }),
  }, { surfaceOp: 'append' })
  const stepStartSeq = session.seq
  session.append('step/start', { turn: 2, step: 0 })
  session.append('user/message', userMessage('New step request'), { surfaceOp: 'append' })

  const { snapshot } = snapshotFor(ctx, session, { preserveFromSeq: stepStartSeq })
  const toolCallSeq = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'assistant/message')
  const toolResultSeq = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'tool/result')
  assert.ok(toolCallSeq < stepStartSeq && toolResultSeq < stepStartSeq)
  assert.equal(snapshot.shadowedSeqs.includes(toolCallSeq), true)
  assert.equal(snapshot.shadowedSeqs.includes(toolResultSeq), true)
  assert.equal(snapshot.shadowedSeqs.includes(snapshot.endSeq), true)
  assert.equal(snapshot.endSeq, toolResultSeq, 'the pair closes the compressed range')
  assert.ok(snapshot.endSeq < stepStartSeq)
})

test('the preserve cutoff walks back over an unmatched tool call instead of splitting it', () => {
  const ctx = new FakeCtx()
  const session = ctx.sessions.add(makeSession({ turns: 0, toolPairs: 0, systemText: DEFAULT_SYSTEM_TEXT }))
  session.append('user/message', userMessage('Earlier request'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 0,
      message: assistantMessage({
        text: 'Calling a tool that is still running',
        toolCalls: [toolCallBlock('read_file', { path: 'src/b.js' }, 'call-b')],
        provider: session.provider,
        model: session.model,
      }),
    },
    { surfaceOp: 'append' },
  )
  const stepStartSeq = session.seq
  session.append('step/start', { turn: 2, step: 0 })
  session.append(
    'assistant/message',
    {
      turn: 2,
      step: 0,
      message: assistantMessage({ text: 'New step reply', provider: session.provider, model: session.model }),
    },
    { surfaceOp: 'append' },
  )

  const { snapshot } = snapshotFor(ctx, session, { preserveFromSeq: stepStartSeq })
  const callSeq = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'assistant/message')
  const userSeq = session.surface.nodes.find((seq) => session.eventAt(seq).type === 'user/message')
  assert.equal(snapshot.shadowedSeqs.includes(callSeq), false, 'the unmatched call moves out of the shadowed range')
  assert.equal(snapshot.shadowedSeqs.includes(stepStartSeq), false)
  assert.equal(snapshot.endSeq, userSeq, 'only history before the unmatched pair is compacted')
  assert.ok(snapshot.endSeq < stepStartSeq)
})
