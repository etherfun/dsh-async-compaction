/**
 * Surface helpers: derivation, tool-pair balance, range selection, checkpoint
 * framing and summarization input.
 * @module test/surface.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKPOINT_PREAMBLE,
  COMPACTION_INSTRUCTION,
  COMPACT_CHECKPOINT_KIND,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  buildSummarizationInput,
  checkpointSource,
  createCheckpointMessage,
  derivedMessage,
  isCompactCheckpointSource,
  isSurfaceEventType,
  selectCompactableRange,
  systemHead,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../src/surface.js'
import {
  assistantMessage,
  makeSession,
  systemMessage,
  toolCallBlock,
  toolResultMessage,
  userMessage,
} from './fake-harness.js'

/** @param {number} tokens */
function priced(session, tokens = 10) {
  return { nodes: session.surface.nodes.map((seq) => ({ seq, tokens, heuristicTokens: tokens })) }
}

// ---------------------------------------------------------------------------
// derivation
// ---------------------------------------------------------------------------

test('derivedMessage follows the host projection rules', () => {
  const session = makeSession({ turns: 0, systemText: null })
  const user = session.append('user/message', userMessage('hello'), { surfaceOp: 'append' })
  assert.equal(derivedMessage(session, user), user.data)

  const system = session.append(
    'system/message',
    { turn: 1, step: 0, message: systemMessage('sys') },
    { surfaceOp: 'append' },
  )
  assert.equal(derivedMessage(session, system).role, 'system')

  const emptyAssistant = session.append(
    'assistant/message',
    { turn: 1, step: 0, message: assistantMessage() },
    { surfaceOp: 'append' },
  )
  assert.equal(derivedMessage(session, emptyAssistant), null)

  const callId = 'call-1'
  const assistant = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 0,
      message: assistantMessage({ toolCalls: [toolCallBlock('read', { p: 1 }, callId)] }),
    },
    { surfaceOp: 'append' },
  )
  assert.equal(derivedMessage(session, assistant).role, 'assistant')

  const result = session.append(
    'tool/result',
    { turn: 1, step: 0, message: toolResultMessage({ callId, text: 'ok' }) },
    { surfaceOp: 'append' },
  )
  assert.equal(derivedMessage(session, result).role, 'tool')

  const turnStart = session.append('turn/start', { turn: 1 })
  assert.equal(derivedMessage(session, turnStart), null)
})

test('isSurfaceEventType accepts only the five message types', () => {
  for (const type of ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']) {
    assert.equal(isSurfaceEventType(type), true, type)
  }
  for (const type of ['turn/start', 'compaction/start', 'session/end-seed', 'request/header', undefined]) {
    assert.equal(isSurfaceEventType(type), false, String(type))
  }
})

// ---------------------------------------------------------------------------
// tool-pair balance
// ---------------------------------------------------------------------------

/**
 * [system, user, assistant(tool-call), tool/result, user]
 * cutBalanced = [true, true, true, false, true, true]
 */
function balanceSession() {
  const session = makeSession({ turns: 0, systemText: 'system prompt' })
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
  return session
}

test('tool-pair balance: cuts before/after an assistant tool call', () => {
  const session = balanceSession()
  const nodes = session.surface.nodes
  const systemSeq = nodes[0]
  const userSeq = nodes[1]
  const assistantSeq = nodes[2]
  const resultSeq = nodes[3]
  const lastUserSeq = nodes[4]

  assert.equal(toolPairingBalancedBefore(session, systemSeq), true)
  assert.equal(toolPairingBalancedAfter(session, systemSeq), true)
  assert.equal(toolPairingBalancedBefore(session, userSeq), true)
  assert.equal(toolPairingBalancedBefore(session, assistantSeq), true)
  // The cut right after the tool call is unbalanced ...
  assert.equal(toolPairingBalancedAfter(session, assistantSeq), false)
  // ... and so is the cut right before its result.
  assert.equal(toolPairingBalancedBefore(session, resultSeq), false)
  // The pair closes exactly after the result.
  assert.equal(toolPairingBalancedAfter(session, resultSeq), true)
  assert.equal(toolPairingBalancedBefore(session, lastUserSeq), true)
  assert.equal(toolPairingBalancedAfter(session, lastUserSeq), true)
})

test('tool-pair balance: throws for a seq that is not on the surface', () => {
  const session = balanceSession()
  assert.throws(() => toolPairingBalancedBefore(session, 9999), /not found/)
  assert.throws(() => toolPairingBalancedAfter(session, 9999), /not found/)
})

// ---------------------------------------------------------------------------
// system head
// ---------------------------------------------------------------------------

test('systemHead only recognizes a system/message at surface node 0', () => {
  const withSystem = makeSession({ turns: 0, systemText: 'head' })
  assert.equal(systemHead(withSystem, withSystem.surface.nodes[0]).type, 'system/message')

  const withoutSystem = makeSession({ turns: 1, systemText: null })
  assert.equal(systemHead(withoutSystem, withoutSystem.surface.nodes[0]), undefined)
})

// ---------------------------------------------------------------------------
// range selection
// ---------------------------------------------------------------------------

test('selectCompactableRange excludes surface node 0 and keeps a priced tail', () => {
  const session = makeSession({ turns: 3, systemText: 'head' }) // 1 system + 6 messages
  const nodes = session.surface.nodes
  const range = selectCompactableRange(session, priced(session), 10)
  assert.notEqual(range, null)
  assert.equal(range.startIdx, 1)
  assert.equal(range.start, nodes[1])
  assert.equal(range.endIdx, nodes.length - 2) // keeps the last node
  assert.equal(range.end, nodes[nodes.length - 2])
  assert.deepEqual(range.shadowedSeqs, nodes.slice(1, nodes.length - 1))
})

test('selectCompactableRange without a system head starts at node 0', () => {
  const session = makeSession({ turns: 3, systemText: null })
  const nodes = session.surface.nodes
  const range = selectCompactableRange(session, priced(session), 10)
  assert.notEqual(range, null)
  assert.equal(range.startIdx, 0)
  assert.equal(range.shadowedSeqs.length, nodes.length - 1) // keeps only the last node
})

test('selectCompactableRange returns null when the retained tail leaves nothing', () => {
  const session = makeSession({ turns: 2, systemText: 'head' })
  const range = selectCompactableRange(session, priced(session), 1000)
  assert.equal(range, null)
})

test('selectCompactableRange returns null for an empty surface', () => {
  const session = makeSession({ turns: 0, systemText: null })
  assert.deepEqual(session.surface.nodes, [])
  assert.equal(selectCompactableRange(session, { nodes: [] }, 0), null)
})

test('selectCompactableRange walks the cut back so a tool-call/result pair is never split', () => {
  const session = balanceSession()
  // Tokens: [system 10, user 10, assistant 10, result 10, user 10]
  // retainTokens 15 -> naive cut before the tool/result (idx 3), which is
  // unbalanced, so the selector keeps both the tool call and its result.
  const range = selectCompactableRange(session, priced(session), 15)
  assert.notEqual(range, null)
  assert.equal(range.startIdx, 1)
  assert.equal(range.endIdx, 1)
  assert.deepEqual(range.shadowedSeqs, [session.surface.nodes[1]])

  // Keeping only 5 tokens retains only the final user message; the tool-call and
  // its result are both shadowed, so the pair still leaves the surface whole.
  const wide = selectCompactableRange(session, priced(session), 5)
  assert.notEqual(wide, null)
  assert.equal(wide.endIdx, 3)
  assert.deepEqual(wide.shadowedSeqs, session.surface.nodes.slice(1, 4))
})

test('selectCompactableRange rejects a measurement that does not match the surface', () => {
  const session = makeSession({ turns: 3, systemText: 'head' })
  const measurement = { nodes: session.surface.nodes.map((seq) => ({ seq: seq + 100, tokens: 10, heuristicTokens: 10 })) }
  assert.throws(() => selectCompactableRange(session, measurement, 10), /does not match the current session surface/)
})

// ---------------------------------------------------------------------------
// summarization input + checkpoint framing
// ---------------------------------------------------------------------------

test('buildSummarizationInput replays the system head then the shadowed messages', () => {
  const session = makeSession({ turns: 0, systemText: 'you are helpful' })
  const user1 = session.append('user/message', userMessage('first'), { surfaceOp: 'append' })
  const empty = session.append(
    'assistant/message',
    { turn: 1, step: 0, message: assistantMessage() },
    { surfaceOp: 'append' },
  )
  const user2 = session.append('user/message', userMessage('second'), { surfaceOp: 'append' })

  const input = buildSummarizationInput(session, [user1.seq, empty.seq, user2.seq])
  assert.equal(input.messages.length, 3) // system + 2 non-empty messages
  assert.equal(input.messages[0].role, 'system')
  assert.deepEqual(
    input.messages.slice(1).map((message) => message.content[0].text),
    ['first', 'second'],
  )
  assert.ok(Array.isArray(input.tools))
  assert.equal(input.tools[0].name, 'read_file')
})

test('buildSummarizationInput omits the system head when node 0 is not a system message', () => {
  const session = makeSession({ turns: 1, systemText: null })
  const input = buildSummarizationInput(session, session.surface.nodes)
  assert.ok(input.messages.every((message) => message.role !== 'system'))
})

test('createCheckpointMessage frames the summary the way the native backend does', () => {
  const message = createCheckpointMessage('11111111-1111-1111-1111-111111111111', [
    { type: 'text', text: '## Summary\n- did things' },
  ])
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.source, {
    kind: COMPACT_CHECKPOINT_KIND,
    compactionId: '11111111-1111-1111-1111-111111111111',
  })
  assert.equal(message.source.kind, 'compact-checkpoint')
  assert.equal(message.content.length, 3)
  assert.equal(message.content[0].text, `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}`)
  assert.equal(message.content[1].text, '## Summary\n- did things')
  assert.equal(message.content[2].text, SUMMARY_CLOSE_TAG)

  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  for (const block of message.content) assert.equal(Object.isFrozen(block), true)

  // A manual command id is carried in the checkpoint source, exactly like the
  // host's `compactCheckpointSource(compactionId, sourceCommandId)`.
  const manual = createCheckpointMessage(
    '11111111-1111-1111-1111-111111111111',
    [{ type: 'text', text: '## Summary' }],
    'command-42',
  )
  assert.deepEqual(manual.source, {
    kind: COMPACT_CHECKPOINT_KIND,
    compactionId: '11111111-1111-1111-1111-111111111111',
    sourceCommandId: 'command-42',
  })
  assert.equal(isCompactCheckpointSource(manual.source), true)
})

test('checkpoint source helpers identify compaction checkpoints only', () => {
  const source = checkpointSource('abc')
  assert.deepEqual(source, { kind: 'compact-checkpoint', compactionId: 'abc' })
  assert.ok(Object.isFrozen(source))
  assert.equal(isCompactCheckpointSource(source), true)
  assert.equal(isCompactCheckpointSource({ kind: 'user' }), false)
  assert.equal(isCompactCheckpointSource(undefined), false)

  // The manual `/compact` command id joins the same marker shape.
  const commandSource = checkpointSource('abc', 'command-7')
  assert.deepEqual(commandSource, { kind: 'compact-checkpoint', compactionId: 'abc', sourceCommandId: 'command-7' })
  assert.equal(isCompactCheckpointSource(commandSource), true)
})

test('the summarization instruction matches the shipped backend shape', () => {
  assert.match(COMPACTION_INSTRUCTION, /^You are now acting as a compaction engine/)
  for (const section of [
    '## Primary Request and Intent',
    '## Key Technical Concepts',
    '## Files and Code',
    '## Errors and Fixes',
    '## Pending Jobs',
    '## Current Work',
    '## Next Step',
    '## Critical Context',
  ]) {
    assert.ok(COMPACTION_INSTRUCTION.includes(section), `missing ${section}`)
  }
  assert.ok(COMPACTION_INSTRUCTION.includes(SUMMARY_OPEN_TAG))
})
