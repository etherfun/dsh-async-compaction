/**
 * Immutable pre-compaction snapshot.
 *
 * A snapshot captures the exact surface range a background summary describes:
 * inclusive boundary seqs, the priced surface nodes, the derived messages that
 * go to the summarizer, the versions that must still match at commit time, and
 * the token budget it was planned against. Later appends are intentionally NOT
 * part of the snapshot — the commit only replaces this range and leaves later
 * messages in place.
 * @module dsh-async-compaction/snapshot
 */

import { randomUUID } from 'node:crypto'
import { buildSummarizationInput, selectCompactableRange, systemHead } from './surface.js'
import { round } from './util.js'

/**
 * @param {object} input
 * @param {any} input.session
 * @param {any} input.measurement - `ctx.tokenMeter.measure(session)`
 * @param {Record<string, any>} input.config
 * @param {{ known: boolean, contextWindow?: number, thresholdTokens?: number, retainTokens?: number, thresholdRatio?: number }} input.native
 * @param {{ provider: string, model: string } | undefined} input.route
 * @param {number} input.triggerTokens
 * @param {number} [input.now]
 * @param {boolean} [input.manual] - an explicit `/compact`-style request: keep
 *   the native manual tail budget (only the last surface node) instead of the
 *   backend's automatic retention policy
 * @returns {{ snapshot: Record<string, any> } | { skip: string, detail?: Record<string, any> }}
 */
export function createSnapshot({ session, measurement, config, native, route, triggerTokens, now = Date.now(), manual = false }) {
  const nodes = session.surface.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return { skip: 'empty-surface' }
  if (native.known !== true || !(native.contextWindow > 0)) return { skip: 'no-context-capacity' }

  // Retention is compaction semantics, not this plugin's policy: use whatever
  // the running backend retains. A manual `/compact` keeps the native behavior
  // of retaining only the last surface node (the selector expands for tool
  // pairs), exactly like `compactNow` does.
  const retainTokens = manual ? 0 : native.retainTokens ?? 0
  const range = selectCompactableRange(session, measurement, retainTokens)
  if (range === null) return { skip: 'no-compactable-range' }

  const input = buildSummarizationInput(session, range.shadowedSeqs)
  const pricedNodes = measurement.nodes.slice(range.startIdx, range.endIdx + 1).map((node) => ({
    seq: node.seq,
    tokens: node.tokens,
    heuristicTokens: node.heuristicTokens,
  }))
  const shadowedRouteTokens = pricedNodes.reduce((total, node) => total + node.tokens, 0)
  const shadowedHeuristicTokens = pricedNodes.reduce((total, node) => total + node.heuristicTokens, 0)
  // The minimum-gain gate protects automatic triggers from paying for a summary
  // that frees almost nothing. An explicit `/compact` request is a user
  // decision, so it keeps the native behavior and compacts whatever range exists.
  if (!manual && shadowedRouteTokens < config.minShadowedTokens) {
    return {
      skip: 'range-too-small',
      detail: { shadowedRouteTokens, minShadowedTokens: config.minShadowedTokens },
    }
  }
  const head = systemHead(session, nodes[0])

  const snapshot = Object.freeze({
    id: randomUUID(),
    sessionId: session.id,
    sessionRef: session,
    createdAt: now,
    createdAtMonotonic: typeof performance !== 'undefined' ? performance.now() : now,

    // Version evidence. `contentGeneration` changes on any replacement or
    // message projection; `replaceGeneration` only on replacements. Requiring
    // both unchanged is deliberately stricter than the host's own check.
    logSeq: session.seq,
    surfaceNodeCount: nodes.length,
    contentGeneration: session.surface.contentGeneration,
    replaceGeneration: session.surface.replaceGeneration,

    startSeq: range.start,
    endSeq: range.end,
    startIdx: range.startIdx,
    endIdx: range.endIdx,
    shadowedSeqs: Object.freeze([...range.shadowedSeqs]),
    shadowedCount: range.shadowedSeqs.length,
    pricedNodes: Object.freeze(pricedNodes.map((node) => Object.freeze(node))),
    shadowedRouteTokens,
    shadowedHeuristicTokens,

    hasSystemHead: head !== undefined,
    manual,
    input,
    route,
    policy: Object.freeze({
      source: native.source ?? 'unknown',
      contextWindow: native.contextWindow,
      thresholdTokens: native.thresholdTokens,
      thresholdRatio: native.thresholdRatio === undefined ? undefined : round(native.thresholdRatio, 4),
      retainTokens,
    }),
    triggerTokens,
    totalTokensAtSnapshot: measurement.totalTokens,
  })

  return { snapshot }
}

/** Human-readable one-line snapshot summary for logs. @param {Record<string, any>} snapshot */
export function describeSnapshot(snapshot) {
  return {
    snapshot: snapshot.id.slice(0, 8),
    snapshot_seq: snapshot.logSeq,
    surface_nodes: snapshot.surfaceNodeCount,
    shadowed_nodes: snapshot.shadowedCount,
    range: `${snapshot.startSeq}-${snapshot.endSeq}`,
    shadowed_tokens: snapshot.shadowedRouteTokens,
    total_tokens: snapshot.totalTokensAtSnapshot,
    content_gen: snapshot.contentGeneration,
  }
}
