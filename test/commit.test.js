/**
 * Commit validation and the four-event compaction transaction.
 *
 * These are unit-level tests of `src/commit.js`: they prove that the commit
 * either lands completely or leaves the session untouched, and that every
 * documented refusal code is produced for the right precondition.
 * @module test/commit.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolveConfig } from '../src/config.js'
import { createSnapshot } from '../src/snapshot.js'
import {
  CommitError,
  MIN_REDUCTION_RATIO,
  appendCompaction,
  compactionLockActive,
  inspectEntryState,
  validateCommit,
} from '../src/commit.js'
import { prepareCheckpoint } from '../src/summarizer.js'
import {
  FakeCtx,
  assistantMessage,
  jsonClone,
  makeSession,
  nativeCompactRange,
  toolCallBlock,
  toolResultMessage,
  userMessage,
} from './fake-harness.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NATIVE = Object.freeze({
  known: true,
  source: 'backend-config',
  contextWindow: 200_000,
  thresholdTokens: 160_000,
  thresholdRatio: 0.8,
  retainTokens: 96,
})

/** @param {{ sessionOptions?: Record<string, any>, configOverrides?: Record<string, any> }} [options] */
function buildFixture(options = {}) {
  const ctx = new FakeCtx()
  const session = makeSession({
    turns: 12,
    toolPairs: 1,
    contextWindow: 200_000,
    extraTokens: 0,
    turnOpen: true,
    ...(options.sessionOptions ?? {}),
  })
  const meter = ctx.get('tokenMeter')
  const config = resolveConfig({ minShadowedTokens: 0, ...(options.configOverrides ?? {}) }).config
  const measurement = meter.measure(session)
  const built = createSnapshot({
    session,
    measurement,
    config,
    native: NATIVE,
    route: { provider: session.provider, model: session.model },
    triggerTokens: 10_000,
    now: 1000,
  })
  assert.ok(built.snapshot !== undefined, `snapshot skipped: ${built.skip}`)
  return { ctx, session, meter, config, snapshot: built.snapshot, measurement }
}

/**
 * @param {any} meter
 * @param {any} snapshot
 * @param {{ text?: string, extra?: Record<string, any>, compactionId?: string }} [options]
 */
function preparedFor(meter, snapshot, options = {}) {
  const summary = [{ type: 'text', text: options.text ?? '## Primary Request\n- short summary body' }]
  const compactionId = options.compactionId ?? randomUUID()
  const checkpoint = prepareCheckpoint(meter, compactionId, summary)
  return {
    compactionId,
    summary,
    provider: 'fake-provider',
    model: 'fake-model',
    llmStreamCall: true,
    rawOutput: [{ type: 'text', text: summary[0].text }],
    ...checkpoint,
    ...(options.extra ?? {}),
  }
}

/** @param {any} promise @param {string} code */
function assertCommitError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CommitError, `expected CommitError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code, `expected code "${code}", got "${error.code}" (${error.message})`)
    return true
  })
}

/** All seqs of the surface that are neither shadowed nor the system head. */
function retainedSeqs(session, snapshot) {
  const shadowed = new Set(snapshot.shadowedSeqs)
  return session.surface.nodes.filter((seq, index) => index > 0 && !shadowed.has(seq))
}

/** @param {any} session */
function toolChainCounts(session) {
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
  return { calls, results }
}

/** Replace one tool/result node's content (the only legal tool/result rewrite). */
function rewriteToolResult(session, seq, text) {
  const original = session.eventAt(seq)
  assert.equal(original.type, 'tool/result')
  const data = jsonClone(original.data)
  data.message.content = [{ type: 'text', text }]
  return session.append('tool/result', data, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('validateCommit accepts a stable span and appendCompaction lands the four events', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const prepared = preparedFor(meter, snapshot)

  const validation = validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens })
  assert.equal(validation.currentTotalTokens, meter.measure(session).totalTokens)
  assert.equal(validation.shadowedRouteTokens, snapshot.shadowedRouteTokens)
  assert.equal(validation.framedTokens, prepared.framedTokens)
  assert.equal(
    validation.expectedTotalAfter,
    Math.max(0, validation.currentTotalTokens - snapshot.shadowedRouteTokens + prepared.framedTokens),
  )
  assert.ok(validation.reductionRatio > 0.5)

  const committed = appendCompaction({ session, snapshot, prepared, entryState: validation.entryState })
  assert.equal(committed.compactionId, prepared.compactionId)
  assert.equal(committed.startSeq + 1, committed.summarySeq)
  assert.equal(committed.summarySeq + 1, committed.startSeq + 2) // the replacement event sits between
  assert.equal(committed.summarySeq + 2, committed.endSeq)
  assert.equal(committed.startSeq + 3, session.log.length - 1)
  assert.equal(committed.turn, 1) // turn/start is still open

  const tail = session.log.slice(-4)
  assert.deepEqual(tail.map((event) => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ])
  const [startEvent, summaryEvent, replaceEvent, endEvent] = tail
  assert.deepEqual(startEvent.data, { compactionId: prepared.compactionId, turn: 1 })
  assert.equal(summaryEvent.data.compactionId, prepared.compactionId)
  assert.deepEqual(summaryEvent.data.shadowedRange, { start: snapshot.startSeq, end: snapshot.endSeq })
  assert.deepEqual(summaryEvent.data.shadowedSeqs, [...snapshot.shadowedSeqs])
  assert.equal(summaryEvent.data.provider, 'fake-provider')
  assert.equal(summaryEvent.data.model, 'fake-model')
  assert.deepEqual(replaceEvent.data.source, { kind: 'compact-checkpoint', compactionId: prepared.compactionId })
  assert.deepEqual(replaceEvent.sourceEventSeqs, [
    startEvent.seq,
    summaryEvent.seq,
    ...snapshot.shadowedSeqs,
  ])
  assert.deepEqual(endEvent.data, { compactionId: prepared.compactionId, turn: 1 })

  // Surface: system head, the replacement node, then the previously retained tail.
  const systemSeq = session.surface.nodes[0]
  assert.equal(session.eventAt(systemSeq).type, 'system/message')
  assert.equal(session.surface.nodes[1], replaceEvent.seq)
  assert.equal(session.surface.replaceGeneration, 1)
  assert.equal(session.surface.contentGeneration, 1)
  for (const seq of snapshot.shadowedSeqs) assert.equal(session.surface.nodes.includes(seq), false)
})

test('commit keeps messages appended after the snapshot: no loss, no duplicates, tool chain intact', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const before = {
    nodes: [...session.surface.nodes],
    messages: session.surface.nodes.map((seq) => session.eventAt(seq).data),
  }
  const added = [
    session.append('user/message', userMessage('appended while summarizing'), { surfaceOp: 'append' }),
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 5,
        message: assistantMessage({ text: 'assistant reply while summarizing', provider: session.provider, model: session.model }),
      },
      { surfaceOp: 'append' },
    ),
    session.append('user/message', userMessage('one more follow-up'), { surfaceOp: 'append' }),
  ]
  const addedSeqs = added.map((event) => event.seq)
  const retained = retainedSeqs(session, snapshot)

  const prepared = preparedFor(meter, snapshot)
  const validation = validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens })
  const committed = appendCompaction({ session, snapshot, prepared, entryState: validation.entryState })

  // Exact expected surface order: [system, replacement, ...retained-before,
  // ...appended-after-snapshot] (the appends stay at the tail in order).
  const shadowed = new Set(snapshot.shadowedSeqs)
  const expected = [
    before.nodes[0],
    committed.summarySeq + 1,
    ...before.nodes.slice(1).filter((seq) => !shadowed.has(seq)),
    ...addedSeqs,
  ]
  assert.deepEqual([...session.surface.nodes], expected)

  // The three appended messages are still present, in order, exactly once.
  assert.deepEqual(session.surface.nodes.slice(-3), addedSeqs)
  assert.equal(new Set(session.surface.nodes).size, session.surface.nodes.length)
  for (const seq of retained) assert.equal(session.surface.nodes.includes(seq), true)

  // No message content was lost: every retained message id is still derivable,
  // and the shadowed messages are gone from the derived history.
  const ids = new Set()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.data.message
    ids.add(message.id)
  }
  for (const seq of retained) {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.data.message
    assert.ok(ids.has(message.id), `retained message ${message.id} disappeared`)
  }
  for (const seq of addedSeqs) {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.data.message
    assert.ok(ids.has(message.id), `appended message ${message.id} disappeared`)
  }
  for (const seq of snapshot.shadowedSeqs) {
    assert.equal(session.surface.nodes.includes(seq), false, `shadowed node ${seq} is still on the surface`)
  }

  // Both counts agree, so no tool call lost its result (or vice versa).
  const counts = toolChainCounts(session)
  assert.equal(counts.calls, counts.results)
  assert.ok(counts.calls > 0)
})

test('appendCompaction carries sourceCommandId into the lifecycle, summary and checkpoint source', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const summary = [{ type: 'text', text: '## Primary Request\n- short summary body' }]
  const compactionId = randomUUID()
  const prepared = {
    compactionId,
    summary,
    provider: 'fake-provider',
    model: 'fake-model',
    llmStreamCall: true,
    rawOutput: [{ type: 'text', text: summary[0].text }],
    sourceCommandId: 'cmd-commit',
    ...prepareCheckpoint(meter, compactionId, summary, 'cmd-commit'),
  }
  const validation = validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens })
  appendCompaction({ session, snapshot, prepared, entryState: validation.entryState })

  const [startEvent, summaryEvent, replaceEvent, endEvent] = session.log.slice(-4)
  assert.equal(startEvent.data.sourceCommandId, 'cmd-commit')
  assert.equal(summaryEvent.data.sourceCommandId, 'cmd-commit')
  assert.equal(endEvent.data.sourceCommandId, 'cmd-commit')
  assert.deepEqual(replaceEvent.data.source, {
    kind: 'compact-checkpoint',
    compactionId,
    sourceCommandId: 'cmd-commit',
  })
})

// ---------------------------------------------------------------------------
// refusal: native compaction already landed
// ---------------------------------------------------------------------------

test('a native compaction of the same span makes the prepared result stale without touching the log', () => {
  const { session, meter, config, snapshot } = buildFixture()
  nativeCompactRange(session, { startSeq: snapshot.startSeq, endSeq: snapshot.endSeq })

  const logAfterNative = session.log.length
  const surfaceAfterNative = [...session.surface.nodes]
  const prepared = preparedFor(meter, snapshot)

  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }), 'span-missing')
  assert.equal(session.log.length, logAfterNative, 'validation must not append anything')
  assert.deepEqual(session.surface.nodes, surfaceAfterNative, 'the native context must be untouched')
})

// ---------------------------------------------------------------------------
// refusal: durable compaction lock
// ---------------------------------------------------------------------------

test('an unmatched compaction/start is an active lock and rejects the commit', () => {
  const { session, meter, config, snapshot } = buildFixture()
  session.append('compaction/start', { compactionId: 'other-compaction', turn: 1 })

  const entry = inspectEntryState(session)
  assert.equal(compactionLockActive(entry), true)
  assert.equal(entry.unmatchedCompactionStart.data.compactionId, 'other-compaction')

  const prepared = preparedFor(meter, snapshot)
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }), 'locked')
  assert.equal(session.log.filter((event) => event.type === 'compaction/end').length, 0)
})

test('a session/end-seed after the unmatched start marks the lock as orphaned', () => {
  const { session, meter, config, snapshot } = buildFixture()
  session.append('compaction/start', { compactionId: 'orphan', turn: null })
  session.append('session/end-seed', {})
  const entry = inspectEntryState(session)
  assert.equal(compactionLockActive(entry), false)
  assert.ok(entry.latestEndSeedSeq > entry.unmatchedCompactionStart.seq)

  // The lock is stale, so validation proceeds.
  const prepared = preparedFor(meter, snapshot)
  assert.doesNotThrow(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }))
})

test('inspectEntryState reports the open turn and clears it after turn/end', () => {
  const session = makeSession({ turns: 0, systemText: null, turnOpen: true })
  session.append('user/message', userMessage('hi'), { surfaceOp: 'append' })
  assert.equal(inspectEntryState(session).openTurn, 1)
  session.append('turn/end', { turn: 1, reason: 'complete' })
  assert.equal(inspectEntryState(session).openTurn, null)
})

// ---------------------------------------------------------------------------
// refusal: the summary is not smaller / not small enough
// ---------------------------------------------------------------------------

test('a framed summary that is not smaller than the shadowed span is rejected', () => {
  const { session, meter, config, snapshot } = buildFixture()
  assertCommitError(
    () => validateCommit({ session, snapshot, config, meter, framedTokens: snapshot.shadowedRouteTokens }),
    'not-smaller',
  )
  assertCommitError(
    () => validateCommit({ session, snapshot, config, meter, framedTokens: snapshot.shadowedRouteTokens + 500 }),
    'not-smaller',
  )
})

test('a summary that frees too little context is rejected by the internal MIN_REDUCTION_RATIO', () => {
  const { session, meter, config, snapshot } = buildFixture()
  assert.equal(MIN_REDUCTION_RATIO, 0.05, 'the minimum reduction is an internal constant')
  assert.ok(snapshot.shadowedRouteTokens > 100)

  // One token below the span: smaller, but the reduction ratio stays tiny.
  assertCommitError(
    () => validateCommit({ session, snapshot, config, meter, framedTokens: snapshot.shadowedRouteTokens - 1 }),
    'small-reduction',
  )

  // Just above the constant's boundary (framed one token larger than the exact
  // 5% cut) is still rejected.
  const justTooLittle = Math.floor(snapshot.shadowedRouteTokens * (1 - MIN_REDUCTION_RATIO)) + 1
  assertCommitError(
    () => validateCommit({ session, snapshot, config, meter, framedTokens: justTooLittle }),
    'small-reduction',
  )

  // A legacy `minReductionRatio` config value is ignored: both a stricter and a
  // looser override leave the constant in charge.
  const legacyStrict = { ...config, minReductionRatio: 0.99 }
  const passesConstant = Math.floor(snapshot.shadowedRouteTokens * (1 - MIN_REDUCTION_RATIO - 0.01))
  assert.doesNotThrow(() =>
    validateCommit({ session, snapshot, config: legacyStrict, meter, framedTokens: passesConstant }),
  )
  const legacyLoose = { ...config, minReductionRatio: 0.0001 }
  assertCommitError(
    () => validateCommit({ session, snapshot, config: legacyLoose, meter, framedTokens: snapshot.shadowedRouteTokens - 1 }),
    'small-reduction',
  )
})

// ---------------------------------------------------------------------------
// refusal: the surface changed during summarization
// ---------------------------------------------------------------------------

test('a replacement that lands during summarization makes the snapshot stale (surface-rewritten)', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const target = retainedSeqs(session, snapshot).find((seq) => session.eventAt(seq).type === 'tool/result')
  assert.notEqual(target, undefined)
  rewriteToolResult(session, target, 'pruned while a summary was being prepared')
  const contentGeneration = session.surface.contentGeneration
  const logLength = session.log.length

  const prepared = preparedFor(meter, snapshot)
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }), 'surface-rewritten')
  assert.equal(session.surface.contentGeneration, contentGeneration, 'validation must not change the surface')
  assert.equal(session.log.length, logLength, 'validation must not append events')
})

test('a replacement inside the shadowed span makes the snapshot stale (span-changed)', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const target = snapshot.shadowedSeqs.find((seq) => session.eventAt(seq).type === 'tool/result')
  assert.notEqual(target, undefined)
  rewriteToolResult(session, target, 'rewritten inside the snapshot span')
  const prepared = preparedFor(meter, snapshot)
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }), 'span-changed')
})

test('the shadowed span length must not change', () => {
  const { session, meter, config, snapshot } = buildFixture()
  // Remove two shadowed nodes by replacing them with a single checkpoint node.
  const first = snapshot.shadowedSeqs[0]
  const second = snapshot.shadowedSeqs[1]
  nativeCompactRange(session, { startSeq: first, endSeq: second })
  const prepared = preparedFor(meter, snapshot)
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens }), 'span-missing')
})

// ---------------------------------------------------------------------------
// refusal: unbalanced boundaries
// ---------------------------------------------------------------------------

/** @param {any} session @param {any} measurement @param {number} startIdx @param {number} endIdx */
function manualSnapshot(session, measurement, startIdx, endIdx) {
  const nodes = session.surface.nodes
  const pricedNodes = measurement.nodes.slice(startIdx, endIdx + 1).map((node) => ({
    seq: node.seq,
    tokens: node.tokens,
    heuristicTokens: node.heuristicTokens,
  }))
  return {
    id: randomUUID(),
    sessionId: session.id,
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    startIdx,
    endIdx,
    shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
    shadowedCount: endIdx - startIdx + 1,
    pricedNodes,
    shadowedRouteTokens: pricedNodes.reduce((total, node) => total + node.tokens, 0),
    shadowedHeuristicTokens: pricedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    contentGeneration: session.surface.contentGeneration,
    replaceGeneration: session.surface.replaceGeneration,
    surfaceNodeCount: nodes.length,
  }
}

function balanceFixture() {
  const ctx = new FakeCtx()
  const session = makeSession({ turns: 0, systemText: 'head' })
  session.append('user/message', userMessage('ask'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: 1, step: 0, message: assistantMessage({ toolCalls: [toolCallBlock('read', {}, 'c1')] }) },
    { surfaceOp: 'append' },
  )
  session.append(
    'tool/result',
    { turn: 1, step: 0, message: toolResultMessage({ callId: 'c1', text: 'done' }) },
    { surfaceOp: 'append' },
  )
  session.append('user/message', userMessage('next'), { surfaceOp: 'append' })
  const meter = ctx.get('tokenMeter')
  const config = resolveConfig({ minShadowedTokens: 0 }).config
  const measurement = meter.measure(session)
  return { ctx, session, meter, config, measurement }
}

test('a span ending on an unanswered tool call is rejected (unbalanced-end)', () => {
  const { session, meter, config, measurement } = balanceFixture()
  const snapshot = manualSnapshot(session, measurement, 1, 2) // user + assistant tool-call
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: 1 }), 'unbalanced-end')
})

test('a span starting on a tool result is rejected (unbalanced-start)', () => {
  const { session, meter, config, measurement } = balanceFixture()
  const snapshot = manualSnapshot(session, measurement, 3, 4) // tool result + user
  assertCommitError(() => validateCommit({ session, snapshot, config, meter, framedTokens: 1 }), 'unbalanced-start')
})

// ---------------------------------------------------------------------------
// refusal: session mismatch
// ---------------------------------------------------------------------------

test('a snapshot from another session is rejected', () => {
  const { meter, config, snapshot } = buildFixture()
  const otherSession = makeSession({ turns: 6, toolPairs: 1 })
  const prepared = preparedFor(meter, snapshot)
  assertCommitError(
    () => validateCommit({ session: otherSession, snapshot, config, meter, framedTokens: prepared.framedTokens }),
    'session-mismatch',
  )
})

// ---------------------------------------------------------------------------
// failure containment inside the transaction
// ---------------------------------------------------------------------------

test('a failed replace still closes the lock and preserves the original surface', () => {
  const { session, meter, config, snapshot } = buildFixture()
  const surfaceBefore = [...session.surface.nodes]
  const prepared = preparedFor(meter, snapshot)
  const validation = validateCommit({ session, snapshot, config, meter, framedTokens: prepared.framedTokens })

  const originalAppend = session.append
  session.append = function failingAppend(type, data, opts) {
    if (type === 'user/message') throw new Error('simulated append failure')
    return originalAppend.call(session, type, data, opts)
  }

  assertCommitError(
    () => appendCompaction({ session, snapshot, prepared, entryState: validation.entryState }),
    'commit-failed',
  )
  session.append = originalAppend

  const tail = session.log.slice(-3)
  assert.deepEqual(tail.map((event) => event.type), ['compaction/start', 'compaction/summary', 'compaction/end'])
  assert.match(String(tail[2].data.error), /simulated append failure/)
  assert.deepEqual(session.surface.nodes, surfaceBefore)
  assert.equal(compactionLockActive(inspectEntryState(session)), false)
})
