// Ad-hoc end-to-end smoke test for the pre-compaction runtime.
// Uses a deliberately small fake session; the full harness lives in test/.
// Usage: node scripts/smoke.mjs
import { resolveConfig } from '../src/config.js'
import { createRuntime, PHASE } from '../src/coordinator.js'

const now = () => Date.now()
const freeze = (v) => Object.freeze(v)

function makeMessage(role, text, extra = {}) {
  return freeze({
    id: `m-${Math.random().toString(16).slice(2)}`,
    role,
    content: [{ type: 'text', text }],
    source: { kind: role === 'user' ? 'user' : 'model' },
    ...extra,
  })
}

class FakeSession {
  constructor(id, contextWindow = 100000) {
    this.id = id
    this.log = []
    this.surface = { nodes: [], replaceGeneration: 0, contentGeneration: 0 }
    this.contextWindow = contextWindow
    this.extraTokens = 0
    this.appendedDuringAppend = false
  }
  get seq() { return this.log.length }
  eventAt(seq) { return this.log[seq] }
  append(type, data, opts = {}) {
    if (this._appending) throw new Error('session append cannot reenter while another append is being published')
    this._appending = true
    try {
      const event = freeze({ type, seq: this.log.length, time: now(), data, ...opts })
      const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
      if (surfaceTypes.has(type)) {
        if (opts.surfaceOp === undefined) throw new Error(`surface event ${type} requires surfaceOp`)
        if (opts.surfaceOp !== 'append') {
          const { startSeq, endSeq } = opts.surfaceOp
          const startIdx = this.surface.nodes.indexOf(startSeq)
          const endIdx = this.surface.nodes.indexOf(endSeq)
          if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error('invalid replace range')
          this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
          this.surface.replaceGeneration += 1
          this.surface.contentGeneration += 1
          this.log.push(event)
          this.emit(event)
          return event
        }
        this.surface.nodes.push(event.seq)
      }
      this.log.push(event)
      this.emit(event)
      return event
    } finally {
      this._appending = false
    }
  }
  emit(event) {
    for (const listener of this.listeners ?? []) listener(this, event)
  }
  deriveEventMessage(event) {
    if (event.type === 'user/message') return event.data
    if (event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message ?? null
    return null
  }
  requestHeader() { return this.header }
  requestContext() { return { provider: 'fake', model: 'fake-1m', contextWindow: this.contextWindow } }
}

function estimate(text) {
  return Math.ceil(text.length / 4) + 4
}
function messageTokens(message) {
  let total = 4
  for (const block of message?.content ?? []) total += estimate(String(block.text ?? ''))
  return total
}

function makeCtx(session) {
  const disposers = []
  const listeners = new Map()
  const logs = []
  const ctx = {
    logger: {
      debug: (line) => logs.push(['debug', line]),
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === session.id ? session : undefined), list: () => [session] }
      if (name === 'agents') return { get: () => agent }
      if (name === 'tokenMeter') return meter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: session.contextWindow }, defaultMaxTokens: 128000 }) }
      if (name === 'compaction') return engine
      if (name === 'timer' || name === 'commands' || name === 'agentPresets') return undefined
      return undefined
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      const dispose = () => {}
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  }
  const meter = {
    measure(current) {
      const nodes = current.surface.nodes.map((seq) => {
        const message = current.deriveEventMessage(current.eventAt(seq))
        const tokens = messageTokens(message)
        return { seq, tokens, heuristicTokens: tokens }
      })
      const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return { totalTokens: surfaceTokens + current.extraTokens, surfaceTokens, nodes }
    },
    estimateMessage: (message) => messageTokens(message),
    contextPressure: () => ({ pressureTokens: 0, contextWindow: current.contextWindow }),
  }
  const engine = {
    config: { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16, auto: true },
    async summarize(input, _agent, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        summary: [{ type: 'text', text: '## Primary Request and Intent\n- smoke test summary' }],
        rawOutput: [{ type: 'text', text: '## Primary Request and Intent\n- smoke test summary' }],
        llmStreamCall: true,
        provider: 'fake',
        model: 'fake-1m',
        maxTokens: 4096,
      }
    },
  }
  const agent = { id: 'agent-1', session, status: 'running', options: { provider: 'fake', model: 'fake-1m' } }
  const current = session
  session.listeners = []
  return { ctx, meter, engine, agent, listeners, logs }
}

// Build a conversation: system prompt + 60 alternating messages with tool pairs.
// The window/header pair leaves a native pressure budget small enough that this
// synthetic session crosses the trigger while its surface still exceeds the
// backend-derived retention tail.
const session = new FakeSession('smoke-session', 100_000)
session.header = { config: { provider: 'fake', model: 'fake-1m', maxTokens: 8000 }, tools: [{ name: 'pwsh' }] }
session.append('system/message', { message: makeMessage('system', 'You are a helpful agent. '.repeat(40)) }, { surfaceOp: 'append' })
session.append('turn/start', { turn: 1 })
for (let i = 0; i < 60; i += 1) {
  session.append('step/start', { turn: 1, step: i + 1 })
  session.append('user/message', makeMessage('user', `Task ${i}: ${'do some work '.repeat(60)}`), { surfaceOp: 'append' })
  const callId = `call-${i}`
  session.append(
    'assistant/message',
    { message: makeMessage('assistant', `working ${i}`, { content: [{ type: 'text', text: `working ${i}` }, { type: 'tool-call', id: callId, name: 'pwsh', arguments: '{}' }] }) },
    { surfaceOp: 'append' },
  )
  session.append('tool/result', { message: makeMessage('tool', `result ${i} ${'data '.repeat(60)}`, { toolCallId: callId }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: i + 1 })
}
session.extraTokens = 20000

const { ctx, agent, listeners } = makeCtx(session)
const { config } = resolveConfig({
  fixedThreshold: 0.005,
  minInterval: 0,
  growthSamplingInterval: 1000,
  logLevel: 'debug',
})
const runtime = createRuntime(ctx, config, [])
runtime.onPreStep(agent)
await new Promise((resolve) => setTimeout(resolve, 120))
const ready = runtime.statusFor(session.id)
console.log('after first pre-step:', ready.phase, 'ready?', ready.hasReadyResult, 'trigger', ready.triggerReason, 'tokens', ready.currentTokens)
runtime.onPreStep(agent)
await new Promise((resolve) => setTimeout(resolve, 30))
const after = runtime.statusFor(session.id)
const types = session.log.map((event) => event.type)
console.log('after apply:', after.phase, 'lastOutcome', after.lastOutcome?.state, 'log tail:', types.slice(-6).join(','))
const summaryEvent = session.log.filter((event) => event.type === 'compaction/summary').at(-1)
console.log('summary event:', summaryEvent ? { shadowed: summaryEvent.data.shadowedSeqs.length, provider: summaryEvent.data.provider } : null)
console.log('surface nodes after:', session.surface.nodes.length); runtime.dispose()
if (after.phase !== PHASE.COMPLETED && after.lastOutcome?.state !== PHASE.COMPLETED) {
  console.error('SMOKE FAILED: compaction did not complete', JSON.stringify(after, null, 2).slice(0, 2000))
  process.exit(1)
}
console.log('SMOKE OK')
