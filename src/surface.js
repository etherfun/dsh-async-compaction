/**
 * Surface helpers: the model-visible projection of the session log.
 *
 * These functions mirror the host's own compaction vocabulary so a
 * pre-compaction produced here is indistinguishable from a native one:
 * - tool-pairing balance (same fold as `dsh-compaction`'s exported helpers),
 * - range selection (same tail-retention + balance-walk algorithm),
 * - summarization input (system head + shadowed messages + tool schemas),
 * - the durable `<compacted-summary>` checkpoint framing.
 *
 * Nothing here mutates a session.
 * @module dsh-pre-compact/surface
 */

import { randomUUID } from 'node:crypto'

/** The marker that makes a replacement message recognizable as a compaction checkpoint. */
export const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint'

/** Opening tag of the structured summary inside the checkpoint message. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
/** Closing tag of the structured summary inside the checkpoint message. */
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Preamble that makes the replacement message read as established background. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation ' +
  'to free up context. Treat the captured context as established background and build on it ' +
  'without restating it. Continue the task directly from the messages that follow, without ' +
  'acknowledging this checkpoint.'

/**
 * The summarization directive, kept byte-for-byte identical to the shipped
 * backend's instruction so a pre-compaction summary is compatible with the
 * native `<compacted-summary>` continuation rule.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Surface-eligible event types (the only events that add model history). */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** @param {any} session */
export function surfaceNodes(session) {
  return session.surface.nodes
}

/** @param {any} session @param {number} seq */
export function eventAt(session, seq) {
  return session.eventAt(seq)
}

/** @param {any} event @returns {any | null} */
export function derivedMessage(session, event) {
  return session.deriveEventMessage(event)
}

/** Number of tool calls an assistant message requests. @param {any} event */
function toolCallDelta(event) {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter((/** @type {any} */ block) => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** @type {WeakMap<object, { generation: number, cutBalanced: boolean[], indexBySeq: Map<number, number>, inProgressToolCalls: number }>} */
const balanceCaches = new WeakMap()

/**
 * Fold unseen surface nodes into the per-session balance cache, exactly like
 * the host's tool-pairing helper.
 * @param {any} session
 * @param {{ generation: number, cutBalanced: boolean[], indexBySeq: Map<number, number>, inProgressToolCalls: number }} cache
 * @param {readonly number[]} seqs
 */
function extendBalanceCache(session, cache, seqs) {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  const pendingCuts = []
  let inProgress = cache.inProgressToolCalls
  for (const seq of tail) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    inProgress += toolCallDelta(event)
    if (inProgress < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgress === 0)
  }
  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgress
  return cache
}

/** @param {any} session */
function balanceCache(session) {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCaches.get(session)
  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    const rebuilt = extendBalanceCache(
      session,
      { generation, cutBalanced: [true], indexBySeq: new Map(), inProgressToolCalls: 0 },
      seqs,
    )
    balanceCaches.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendBalanceCache(session, cached, seqs)
  return cached
}

/** @param {{ indexBySeq: Map<number, number>, cutBalanced: boolean[] }} cache @param {number} seq @param {number} offset */
function cutBalance(cache, seq, offset) {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

/**
 * Whether the cut immediately before a current surface sequence is balanced
 * (no unanswered assistant tool call crosses it).
 * @param {any} session @param {number} seq
 */
export function toolPairingBalancedBefore(session, seq) {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * Whether the cut immediately after a current surface sequence is balanced.
 * @param {any} session @param {number} seq
 */
export function toolPairingBalancedAfter(session, seq) {
  return cutBalance(balanceCache(session), seq, 1)
}

/** The `system/message` at surface node 0, or undefined when node 0 is another type. @param {any} session @param {number} headSeq */
export function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq)
  return head?.type === 'system/message' ? head : undefined
}

/**
 * Resolve the inclusive surface-range to compact: keep a priced recent tail and
 * never split an assistant tool-call/result pair. Matches the shipped backend's
 * selection so the pre-compaction looks like a normal automatic compaction.
 * @param {any} session
 * @param {{ nodes: Array<{ seq: number, tokens: number, heuristicTokens: number }> }} measurement
 * @param {number} retainTokens
 * @returns {{ start: number, end: number, startIdx: number, endIdx: number, shadowedSeqs: number[] } | null}
 */
export function selectCompactableRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null
  const nodes = session.surface.nodes
  if (nodes.length !== pricedNodes.length || nodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('pre-compact: token-meter surface does not match the current session surface')
  }
  const firstIdx = systemHead(session, nodes[0]) === undefined ? 0 : 1
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, nodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return {
    start: nodes[firstIdx],
    end: nodes[keepFromIdx - 1],
    startIdx: firstIdx,
    endIdx: keepFromIdx - 1,
    shadowedSeqs: nodes.slice(firstIdx, keepFromIdx),
  }
}

/**
 * Build the replayed conversation prefix handed to the summarizer: the system
 * prompt held at surface node 0, then every shadowed message in surface order.
 * @param {any} session
 * @param {readonly number[]} shadowedSeqs
 * @returns {{ tools?: any[], messages: any[] }}
 */
export function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader?.()
  const head = systemHead(session, session.surface.nodes[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = []
  for (const seq of shadowedSeqs) {
    const message = session.deriveEventMessage(session.eventAt(seq))
    if (message !== null && message !== undefined) regionMessages.push(message)
  }
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/**
 * Create the checkpoint source marker that every backend uses, so compaction
 * consumers (including the host's own next compaction) recognize the summary.
 * A manual request carries the initiating command id, exactly like the host's
 * `compactCheckpointSource()`.
 * @param {string} compactionId
 * @param {string} [sourceCommandId]
 */
export function checkpointSource(compactionId, sourceCommandId) {
  return Object.freeze({
    kind: COMPACT_CHECKPOINT_KIND,
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  })
}

/**
 * Create the replacement user message for one summary.
 * @param {string} compactionId
 * @param {ReadonlyArray<{ type: 'text', text: string }>} summaryBlocks
 * @param {string} [sourceCommandId]
 */
export function createCheckpointMessage(compactionId, summaryBlocks, sourceCommandId) {
  const content = [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summaryBlocks.map((block) => ({ type: 'text', text: block.text })),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content.map((block) => Object.freeze(block))),
    source: checkpointSource(compactionId, sourceCommandId),
  })
}

/** Whether a message source identifies a compaction checkpoint. @param {any} source */
export function isCompactCheckpointSource(source) {
  return source?.kind === COMPACT_CHECKPOINT_KIND
}

/** Whether an event type can join the model-visible surface. @param {string} type */
export function isSurfaceEventType(type) {
  return SURFACE_EVENT_TYPES.has(type)
}
