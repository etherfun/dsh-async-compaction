// Ad-hoc smoke test for volatile settings: the loader hands `.volatile()` fields
// over as Cordis references, and `loader/volatile-update` must change the running
// plugin's options in place (no restart).
// Usage: node scripts/smoke-config-live.mjs
import { apply } from '../index.js'

const freeze = (v) => Object.freeze(v)
const now = () => Date.now()

function makeMessage(role, text) {
  return freeze({
    id: `m-${Math.random().toString(16).slice(2)}`,
    role,
    content: [{ type: 'text', text }],
    source: { kind: role === 'user' ? 'user' : 'model' },
  })
}

class FakeSession {
  constructor(id, contextWindow = 1_000_000) {
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
      } else this.surface.nodes.push(event.seq)
    }
    this.log.push(event)
    for (const listener of this.listeners) listener(this, event)
    return event
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

const session = new FakeSession('live-config')
session.header = { config: { provider: 'fake', model: 'fake-model', maxTokens: 128000 }, tools: [] }
session.append('system/message', { message: makeMessage('system', 'You are a helpful agent. '.repeat(40)) }, { surfaceOp: 'append' })
session.append('turn/start', { turn: 1 })
for (let i = 0; i < 12; i += 1) {
  session.append('user/message', makeMessage('user', `Task ${i}: ${'do some work '.repeat(80)}`), { surfaceOp: 'append' })
}
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
session.extraTokens = 5_000

const listeners = new Map()
const disposers = []
const registeredCommands = new Map()
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
const engine = {
  config: { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16, auto: true },
  async summarize() {
    return {
      summary: [{ type: 'text', text: '## summary' }],
      rawOutput: [{ type: 'text', text: '## summary' }],
      llmStreamCall: true,
      provider: 'fake',
      model: 'fake-model',
      maxTokens: 4096,
    }
  },
}
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
    if (name === 'agentPresets') return { serviceFor: () => engine }
    if (name === 'commands') {
      return {
        register: (definition) => {
          registeredCommands.set(definition.name, definition)
          return () => registeredCommands.delete(definition.name)
        },
      }
    }
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

// Cordis volatile references: frozen objects whose only mutable state lives
// behind get().
const refs = {
  fixedThreshold: { value: 0.7, get() { return this.value } },
  enabled: { value: true, get() { return this.value } },
  minThreshold: { value: 0.5, get() { return this.value } },
  maxThreshold: { value: 0.75, get() { return this.value } },
}
const rawConfig = {
  fixedThreshold: Object.freeze({ get: () => refs.fixedThreshold.get() }),
  enabled: Object.freeze({ get: () => refs.enabled.get() }),
  minThreshold: Object.freeze({ get: () => refs.minThreshold.get() }),
  maxThreshold: Object.freeze({ get: () => refs.maxThreshold.get() }),
}

apply(ctx, rawConfig)
const emit = (name, payload) =>
  Promise.all((listeners.get(name) ?? []).map((listener) => listener(payload, async () => ({ kind: 'enter', messages: [] }))))
await emit('agent/created', { agent, source: 'startup' })
await emit('agent/pre-step', { agent, turn: 1, step: 1, signal: new AbortController().signal })
session.listeners.push((current, event) => {
  for (const listener of listeners.get('session/event') ?? []) listener(current, event)
})

async function status() {
  const command = registeredCommands.get('precompact')
  const result = await command.handler({ agent, rawInput: 'status', signal: new AbortController().signal, commandId: 'cmd-status' })
  return result.text
}

await new Promise((resolve) => setTimeout(resolve, 20))
const first = await status()
const firstTrigger = /Pre-compaction trigger: ([\d,]+)/.exec(first)?.[1]
console.log('initial trigger:', firstTrigger, '| enabled:', /enabled/.test(first))

// Volatile-only settings save: the loader updates the references in place and
// publishes `loader/volatile-update` on the plugin fiber.
refs.fixedThreshold.value = 0.4
for (const listener of listeners.get('loader/volatile-update') ?? []) listener([])
await new Promise((resolve) => setTimeout(resolve, 20))
const second = await status()
const secondTrigger = /Pre-compaction trigger: ([\d,]+)/.exec(second)?.[1]
console.log('after save trigger:', secondTrigger)

refs.enabled.value = false
for (const listener of listeners.get('loader/volatile-update') ?? []) listener([])
const third = await status()
console.log('after disable:', /paused/.test(third))

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // ignore
  }
}

const ok =
  firstTrigger === '700,000' &&
  secondTrigger === '400,000' &&
  /paused/.test(third) &&
  logs.some(([level, line]) => level === 'info' && line.includes('configuration updated'))
if (!ok) {
  console.error('FAILED: volatile settings did not update the running plugin in place')
  process.exit(1)
}
console.log('LIVE CONFIG SMOKE OK')
process.exit(0)
