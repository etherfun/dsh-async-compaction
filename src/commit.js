/**
 * Atomic commit of a background pre-compaction.
 *
 * The expensive part (summarization) already ran off the critical path. Commit
 * re-validates that the snapshot still describes a legal, unchanged,
 * tool-pair-balanced surface range, then appends the exact four events the
 * shipped backend appends, synchronously and without yielding:
 *
 *   compaction/start -> compaction/summary -> user/message(replace) -> compaction/end
 *
 * Because those appends happen in one synchronous turn, no request or tool call
 * can observe a half-applied compaction, and the durable lock bracket can never
 * cross a turn boundary.
 * @module dsh-async-compaction/commit
 */

import { createCheckpointMessage, toolPairingBalancedAfter, toolPairingBalancedBefore } from './surface.js'
import { errorChain } from './util.js'

/**
 * Minimum share of the shadowed range a summary must free. This is an internal
 * safety gate, not a settings option: compaction quality is the backend's
 * business, and the async layer only refuses to commit a result that barely
 * frees anything.
 */
export const MIN_REDUCTION_RATIO = 0.05

/** A classified, user-invisible commit rejection. */
export class CommitError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.name = 'CommitError'
    this.code = code
    this.detail = detail ?? {}
  }
}

/**
 * Inspect the durable compaction lock and open-turn state from the log tail.
 * Mirrors the backend's own entry-state scan: an unmatched `compaction/start`
 * is a live lock unless a later `session/end-seed` proves it belongs to a
 * previous process lifecycle.
 * @param {any} session
 * @returns {{ openTurn: number | null, unmatchedCompactionStart: any | undefined, latestEndSeedSeq: number | undefined }}
 */
export function inspectEntryState(session) {
  let openTurn = null
  let openTurnKnown = false
  let unmatchedCompactionStart
  let compactionEntryKnown = false
  let latestEndSeedSeq
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionEntryKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryKnown = true
      }
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnKnown = true
      } else if (event.type === 'turn/end') {
        openTurnKnown = true
      }
    }
    if (openTurnKnown && compactionEntryKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/** @param {{ unmatchedCompactionStart?: any, latestEndSeedSeq?: number }} entryState */
export function compactionLockActive(entryState) {
  if (entryState.unmatchedCompactionStart === undefined) return false
  if (entryState.latestEndSeedSeq !== undefined && entryState.latestEndSeedSeq > entryState.unmatchedCompactionStart.seq) return false
  return true
}

/**
 * Price the current shadowed span and confirm it still matches the snapshot.
 * @param {object} input
 * @param {any} input.session
 * @param {Record<string, any>} input.snapshot
 * @param {any} input.measurement
 * @returns {{ startIdx: number, endIdx: number, shadowedRouteTokens: number }}
 */
function verifySpan({ session, snapshot, measurement }) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(snapshot.startSeq)
  const endIdx = nodes.indexOf(snapshot.endSeq)
  if (startIdx === -1 || endIdx === -1) {
    throw new CommitError('span-missing', 'the snapshot range is no longer present on the current surface')
  }
  if (startIdx > endIdx) {
    throw new CommitError('span-inverted', 'the snapshot range boundaries were reordered on the current surface')
  }
  const spanLength = endIdx - startIdx + 1
  if (spanLength !== snapshot.shadowedSeqs.length) {
    throw new CommitError('span-resized', 'the snapshot range now covers a different number of surface nodes', {
      expected: snapshot.shadowedSeqs.length,
      actual: spanLength,
    })
  }
  for (let offset = 0; offset < spanLength; offset += 1) {
    if (nodes[startIdx + offset] !== snapshot.shadowedSeqs[offset]) {
      throw new CommitError('span-changed', 'the snapshot range now contains different surface nodes')
    }
  }
  if (session.surface.contentGeneration !== snapshot.contentGeneration) {
    throw new CommitError('surface-rewritten', 'the session surface changed since the snapshot was taken', {
      expected: snapshot.contentGeneration,
      actual: session.surface.contentGeneration,
    })
  }
  if (session.surface.replaceGeneration !== snapshot.replaceGeneration) {
    throw new CommitError('surface-replaced', 'a surface replacement landed since the snapshot was taken', {
      expected: snapshot.replaceGeneration,
      actual: session.surface.replaceGeneration,
    })
  }

  let shadowedRouteTokens = 0
  for (let offset = 0; offset < spanLength; offset += 1) {
    const current = measurement.nodes[startIdx + offset]
    const expected = snapshot.pricedNodes[offset]
    if (current === undefined || current.seq !== expected.seq) {
      throw new CommitError('span-unpriced', 'the token meter no longer prices the snapshot range')
    }
    if (current.tokens !== expected.tokens || current.heuristicTokens !== expected.heuristicTokens) {
      throw new CommitError('span-repriced', 'the snapshot range was rewritten or repriced', {
        seq: expected.seq,
        expectedTokens: expected.tokens,
        actualTokens: current.tokens,
      })
    }
    shadowedRouteTokens += current.tokens
  }
  return { startIdx, endIdx, shadowedRouteTokens }
}

/**
 * Validate every pre-commit precondition. Throws {@link CommitError} when the
 * result must not be applied; the caller then keeps the original context.
 * @param {object} input
 * @param {any} input.session
 * @param {Record<string, any>} input.snapshot
 * @param {Record<string, any>} input.config
 * @param {any} input.meter
 * @param {number} input.framedTokens
 * @returns {{
 *   entryState: ReturnType<typeof inspectEntryState>,
 *   currentTotalTokens: number,
 *   shadowedRouteTokens: number,
 *   framedTokens: number,
 *   expectedTotalAfter: number,
 *   reductionRatio: number,
 * }}
 */
export function validateCommit({ session, snapshot, config, meter, framedTokens }) {
  if (session?.id !== snapshot.sessionId) {
    throw new CommitError('session-mismatch', 'the snapshot belongs to a different session')
  }
  const entryState = inspectEntryState(session)
  if (compactionLockActive(entryState)) {
    throw new CommitError('locked', 'another compaction holds the durable compaction lock', {
      lockSeq: entryState.unmatchedCompactionStart?.seq,
    })
  }

  let measurement
  try {
    measurement = meter.measure(session)
  } catch (error) {
    throw new CommitError('measure-failed', `cannot measure the current session: ${errorChain(error)}`)
  }
  const { startIdx, endIdx, shadowedRouteTokens } = verifySpan({ session, snapshot, measurement })

  // Tool-pairing balance is not validated by the session layer, so it is our
  // responsibility: never split a tool call from its result.
  if (!toolPairingBalancedBefore(session, snapshot.startSeq)) {
    throw new CommitError('unbalanced-start', 'the range start now splits a tool-call/result pair')
  }
  if (!toolPairingBalancedAfter(session, snapshot.endSeq)) {
    throw new CommitError('unbalanced-end', 'the range end now splits a tool-call/result pair')
  }

  if (!(shadowedRouteTokens > 0)) {
    throw new CommitError('empty-range', 'the snapshot range prices to zero tokens')
  }
  if (!(framedTokens < shadowedRouteTokens)) {
    throw new CommitError('not-smaller', 'the framed summary is not smaller than the shadowed range', {
      framedTokens,
      shadowedRouteTokens,
    })
  }
  const reduction = (shadowedRouteTokens - framedTokens) / shadowedRouteTokens
  if (reduction < MIN_REDUCTION_RATIO) {
    throw new CommitError('small-reduction', 'the framed summary does not free enough context', {
      reduction: Number(reduction.toFixed(4)),
      required: MIN_REDUCTION_RATIO,
    })
  }

  return {
    entryState,
    currentTotalTokens: measurement.totalTokens,
    shadowedRouteTokens,
    framedTokens,
    expectedTotalAfter: Math.max(0, measurement.totalTokens - shadowedRouteTokens + framedTokens),
    reductionRatio: Number(reduction.toFixed(4)),
    range: { startIdx, endIdx },
  }
}

/**
 * Append the four-event compaction transaction. All appends are synchronous, so
 * nothing can interleave between the lock, the replacement and the release.
 * @param {object} input
 * @param {any} input.session
 * @param {Record<string, any>} input.snapshot
 * @param {{ compactionId: string, message: any, summary: Array<{ type: 'text', text: string }>, rawOutput?: Array<any>, llmStreamCall?: boolean, provider: string, model: string, maxTokens?: number, usage?: any }} input.prepared
 * @param {ReturnType<typeof inspectEntryState>} input.entryState
 * @returns {{ compactionId: string, startSeq: number, summarySeq: number, endSeq: number, turn: number | null }}
 */
export function appendCompaction({ session, snapshot, prepared, entryState }) {
  const turn = entryState.openTurn
  const lifecycle = {
    compactionId: prepared.compactionId,
    ...(typeof prepared.sourceCommandId === 'string' && prepared.sourceCommandId.length > 0
      ? { sourceCommandId: prepared.sourceCommandId }
      : {}),
    turn,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  let closed = false
  let stage = 'summary'
  try {
    // Only present fields may enter the payload: the real Session.append()
    // rejects a lossless-JSON snapshot containing `undefined`.
    const callRecord = {
      ...(prepared.rawOutput === undefined ? {} : { rawOutput: prepared.rawOutput }),
      ...(prepared.llmStreamCall === true ? { llmStreamCall: true } : {}),
    }
    const summaryEvent = session.append('compaction/summary', {
      compactionId: prepared.compactionId,
      ...(lifecycle.sourceCommandId === undefined ? {} : { sourceCommandId: lifecycle.sourceCommandId }),
      summary: prepared.summary,
      ...callRecord,
      shadowedRange: { start: snapshot.startSeq, end: snapshot.endSeq },
      shadowedSeqs: [...snapshot.shadowedSeqs],
      shadowedTokenCount: snapshot.shadowedHeuristicTokens,
      provider: prepared.provider,
      model: prepared.model,
      ...(prepared.maxTokens === undefined ? {} : { maxTokens: prepared.maxTokens }),
      ...(prepared.usage === undefined ? {} : { usage: prepared.usage }),
    })
    stage = 'replace'
    session.append('user/message', prepared.message, {
      surfaceOp: { op: 'replace', startSeq: snapshot.startSeq, endSeq: snapshot.endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...snapshot.shadowedSeqs],
    })
    stage = 'close'
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    return {
      compactionId: prepared.compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      turn,
    }
  } catch (error) {
    if (!closed) {
      // Mirror the backend: make exactly one close attempt so the lock is not
      // left dangling. A failed close is itself recorded as the failure.
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
      } catch {
        // leave the unmatched start as the durable busy signal
      }
    }
    throw new CommitError('commit-failed', `compaction did not commit cleanly (${stage})`, {
      cause: errorChain(error),
      stage,
    })
  }
}

/** Build the replacement message for a summary. Exposed for tests. */
export { createCheckpointMessage }
