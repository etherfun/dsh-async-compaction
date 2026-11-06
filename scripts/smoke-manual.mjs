// Ad-hoc smoke test for the async manual-compaction hook (the /compact path).
// Usage: node scripts/smoke-manual.mjs
import { apply } from '../index.js'

const freeze = (v) => Object.freeze(v)
const now = () => Date.now()

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
    this.listeners = []
  }
  get seq() { return this.log.length }
  eventAt(seq) { return this.log[seq] }
  append(type, data, opts = {}) {
    if (this._appending) throw new Error('session append cannot reenter')
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
          for (const listener of this.listeners) listener(this, event)
          return event
        }
        this.surface.nodes.push(event.seq)
      }
      this.log.push(event)
      for (const listener of this.listeners) listener(this, event)
      return event
    } finally {
      this._appending = false
    }
  }
  deriveEventMessage(event) {
    if (event.type === 'user/message') return event.data
    if (event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message ?? null
    return null
  }
  requestHeader() { return this.header }
  requestContext() { return { provider: 'fake', model: 'fake-model', contextWindow: this.contextWindow } }
}

function messageTokens(message) {
  let total = 4
  for (const block of message?.content ?? []) total += Math.ceil(String(block.text ?? '').length / 4) + 4
  return total
}

function makeCtx(session, engine) {
  const listeners = new Map()
  const disposers = []
  const logs = []
  const agent = { id: 'agent-1', session, status: 'idle', options: { provider: 'fake', model: 'fake-model' }, ctx: {} }
  const meter = {
    measure(current) {
      const nodes = current.surface.nodes.map((seq) => {
        const tokens = messageTokens(current.deriveEventMessage(current.eventAt(seq)))
        return { seq, tokens, heuristicTokens: tokens }
      })
      return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) + current.extraTokens, nodes }
    },
    estimateMessage: (message) => messageTokens(message),
    contextPressure: () => ({ pressureTokens: 0, contextWindow: session.contextWindow }),
  }
  const sessions = {
    get: (id) => (id === session.id ? session : undefined),
    list: () => [session],
  }
  const ctx = {
    logger: {
      debug: (line) => logs.push(['debug', line]),
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
    },
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'agents') return { get: () => agent }
      if (name === 'tokenMeter') return meter
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: session.contextWindow }, defaultMaxTokens: 128000 }) }
      if (name === 'compaction') return engine
      if (name === 'agentPresets') return { serviceFor: () => engine }
      return undefined
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result)
      return result
    },
  }
  return { ctx, logs, listeners, agent, disposers, meter, engine }
}

function emit(ctx, listeners, name, payload) {
  for (const listener of listeners.get(name) ?? []) listener(payload, async () => ({ kind: 'enter', messages: [] }))
}

function buildSession() {
  const session = new FakeSession('manual-smoke', 1_000_000)
  session.header = { config: { provider: 'fake', model: 'fake-model', maxTokens: 128000 }, tools: [] }
  session.append('system/message', { message: makeMessage('system', 'You are a helpful agent. '.repeat(40)) }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  for (let i = 0; i < 20; i += 1) {
    session.append('step/start', { turn: 1, step: i + 1 })
    session.append('user/message', makeMessage('user', `Task ${i}: ${'do some work '.repeat(80)}`), { surfaceOp: 'append' })
    session.append('assistant/message', { message: makeMessage('assistant', `working ${i}`) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: i + 1 })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function makeEngine(session) {
  const engine = {
    originalCalls: 0,
    config: { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16, auto: true },
    async summarize() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        summary: [{ type: 'text', text: '## Primary Request and Intent\n- manual smoke summary' }],
        rawOutput: [{ type: 'text', text: '## Primary Request and Intent\n- manual smoke summary' }],
        llmStreamCall: true,
        provider: 'fake',
        model: 'fake-model',
        maxTokens: 4096,
      }
    },
    async compactNow() {
      this.originalCalls += 1
      return null
    },
  }
  return engine
}

const session = buildSession()
const engine = makeEngine(session)
const { ctx, logs, listeners, agent, disposers } = makeCtx(session, engine)
session.listeners.push((current, event) => {
  for (const listener of listeners.get('session/event') ?? []) listener(current, event)
})
apply(ctx, { fixedThreshold: 0.9, manualCompactRetainTokens: 0, minShadowedTokens: 0, minInterval: 0, logLevel: 'debug' })
emit(ctx, listeners, 'agent/created', { agent, source: 'startup' })

if (engine.compactNow.name !== 'backgroundCompactNow') {
  console.error('FAILED: compactNow was not patched')
  process.exit(1)
}
const promise = engine.compactNow(agent, new AbortController().signal, 'cmd-smoke')
if (!(promise instanceof Promise)) {
  console.error('FAILED: patched compactNow did not return a promise')
  process.exit(1)
}
const result = await promise
const types = session.log.slice(-4).map((event) => event.type)
const summaryEvent = session.log.findLast?.((event) => event.type === 'compaction/summary')
console.log('result:', result && { shadowed: result.shadowedSeqs?.length, tokens: result.shadowedTokenCount, turn: result.turn, manual: result.manual, command: result.sourceCommandId })
console.log('tail events:', types.join(','))
console.log('original compactNow calls:', engine.originalCalls)
console.log('summary payload command:', summaryEvent?.data?.sourceCommandId)
console.log('applied log line:', logs.some(([level, line]) => level === 'info' && line.includes('compaction applied')))
if (engine.originalCalls !== 0) {
  console.error('FAILED: the original native compactNow ran instead of the background pipeline')
  process.exit(1)
}
if (types.join(',') !== 'compaction/start,compaction/summary,user/message,compaction/end') {
  console.error('FAILED: manual compaction did not append the four events')
  process.exit(1)
}
if (!result || !Array.isArray(result.shadowedSeqs) || result.shadowedSeqs.length === 0) {
  console.error('FAILED: result is missing shadowedSeqs')
  process.exit(1)
}
if (result.sourceCommandId !== 'cmd-smoke' || summaryEvent?.data?.sourceCommandId !== 'cmd-smoke') {
  console.error('FAILED: sourceCommandId was not carried into the payload')
  process.exit(1)
}
console.log('MANUAL SMOKE OK')
// The runtime falls back to a process-level interval when no timer service is
// mounted; release it so the script exits.
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // ignore
  }
}
process.exit(0)
