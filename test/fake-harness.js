/**
 * Fake DeepSeek Harness for the dsh-async-compaction test suite.
 *
 * Zero third-party dependencies. The fake mirrors the runtime semantics the
 * plugin depends on, with the authoritative source being the installed host
 * packages (`@deepseek-ai/*` shipped inside the DSH app):
 *
 * - `dsh-session/lib/index.js` + `types/surface.js` — `Session.append` envelope,
 *   the canonical surface fold, replacement validation and the append
 *   reentrancy guard.
 * - `dsh-util-values/lib/index.js` — lossless-JSON payload snapshotting
 *   (an `undefined` anywhere makes the whole payload invalid).
 * - `dsh-token-meter` — `measure()` / `estimateMessage()` / `contextPressure()`.
 * - `dsh-compaction-basic` — mounted backend `config` + `summarize()` hook.
 * - `dsh-commands` — `/precompact` registration contract.
 *
 * @module test/fake-harness
 */

import { randomUUID } from 'node:crypto'
import { apply } from '../index.js'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Event types that produce model-visible messages. */
export const SURFACE_EVENT_TYPES = Object.freeze([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const SURFACE_EVENT_TYPE_SET = new Set(SURFACE_EVENT_TYPES)

/** Role implied by each message-producing event type (host restore validation). */
export const MESSAGE_ROLE_BY_TYPE = Object.freeze({
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
})

export const DEFAULT_SYSTEM_TEXT =
  'You are a careful coding assistant. Prefer precise, minimal changes and verify with tests.'

export const DEFAULT_SUMMARY_TEXT = [
  '## Primary Request and Intent',
  '- Build a background pre-compaction plugin for the DeepSeek Harness.',
  '## Key Technical Concepts',
  '- session surface, compaction events, token meter.',
  '## Next Step',
  '- Continue the current implementation task.',
].join('\n')

/** A JSON deep clone used by tests to read frozen values safely. */
export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Resolve after `ms`, rejecting with an AbortError when `signal` aborts. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(String(signal.reason ?? 'aborted')))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(abortError(String(signal.reason ?? 'aborted')))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Build the host-shaped cancellation error. */
export function abortError(reason = 'aborted') {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep freeze matching the host's event freezing (arrays and plain objects). */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  return value
}

/** Structural JSON equality (host `deepEqualJson`). */
export function deepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqualJson(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]))
}

/**
 * Faithful port of `@deepseek-ai/dsh-util-values`' `snapshotJsonValue()`:
 * losslessly clone JSON data, rejecting anything a JSON round trip would lose.
 * In particular an `undefined` object property rejects the whole payload, which
 * is exactly what `Session.append()` enforces on a real host.
 * @param {unknown} value
 * @param {string} [subject]
 * @returns {any}
 */
export function snapshotJsonValue(value, subject = 'value') {
  const ancestors = new Set()

  /** @param {any} current @param {string} path @returns {any} */
  function walk(current, path) {
    if (current === null) return null
    const kind = typeof current
    if (kind === 'boolean' || kind === 'string') return current
    if (kind === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new Error(`${subject} carries a non-JSON number at ${path}`)
      }
      return current
    }
    if (kind !== 'object') throw new Error(`${subject} carries a non-JSON ${kind} at ${path}`)
    if (ancestors.has(current)) throw new Error(`${subject} carries a circular reference at ${path}`)
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new Error(`${subject} carries an exotic array at ${path}`)
        }
        if (Reflect.ownKeys(current).length !== current.length + 1) {
          throw new Error(`${subject} carries a sparse array at ${path}`)
        }
        return current.map((item, index) => walk(item, `${path}[${index}]`))
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${subject} carries an exotic prototype at ${path}`)
      }
      const out = {}
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key)) {
          throw new Error(`${subject} carries a non-JSON property key at ${path}`)
        }
        out[key] = walk(current[key], `${path}.${key}`)
      }
      return out
    } finally {
      ancestors.delete(current)
    }
  }

  return walk(value, '$')
}

/** Deferred promise with exposed resolve/reject. */
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** Mounted content-block vocabulary (`dsh-llm` ContentBlockMap). */
export const CONTENT_BLOCK_TYPES = Object.freeze([
  'text',
  'reasoning',
  'image',
  'file',
  'tool-call',
  'tool-addition',
  'tool-removal',
])

const CONTENT_BLOCK_TYPE_SET = new Set(CONTENT_BLOCK_TYPES)

/** Whether one value is a host content block. @param {any} block */
export function isContentBlock(block) {
  return isRecord(block) && CONTENT_BLOCK_TYPE_SET.has(block.type)
}

/** Whether an array contains only host content blocks. @param {any} blocks */
export function checkContentBlocks(blocks) {
  return Array.isArray(blocks) && blocks.every(isContentBlock)
}

/** @param {string} text */
export function textBlock(text) {
  return { type: 'text', text }
}

/** @param {string} name @param {Record<string, unknown>} args @param {string} id */
export function toolCallBlock(name, args, id) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
}

/** @param {string} text @param {{ id?: string, source?: any }} [options] */
export function userMessage(text, options = {}) {
  return {
    id: options.id ?? randomUUID(),
    role: 'user',
    source: options.source ?? { kind: 'user' },
    content: [textBlock(text)],
  }
}

/** @param {string} text @param {{ id?: string, source?: any }} [options] */
export function systemMessage(text, options = {}) {
  return {
    id: options.id ?? randomUUID(),
    role: 'system',
    source: options.source ?? { kind: 'system-prompt' },
    content: [textBlock(text)],
  }
}

/** @param {{ text?: string, toolCalls?: any[], id?: string, provider?: string, model?: string }} [options] */
export function assistantMessage(options = {}) {
  const content = []
  if (options.text !== undefined && options.text !== '') content.push(textBlock(options.text))
  if (Array.isArray(options.toolCalls)) content.push(...options.toolCalls)
  return {
    id: options.id ?? randomUUID(),
    role: 'assistant',
    source: {
      kind: 'model',
      provider: options.provider ?? 'fake-provider',
      model: options.model ?? 'fake-model',
    },
    content,
  }
}

/** @param {{ callId: string, text: string, id?: string }} options */
export function toolResultMessage(options) {
  return {
    id: options.id ?? randomUUID(),
    role: 'tool',
    toolCallId: options.callId,
    source: { kind: 'tool', callId: options.callId },
    content: [textBlock(options.text)],
  }
}

/** Roughly price a message the way the host meter does: 4 chars ≈ 1 token. */
export function estimateMessageTokens(message, overhead = 4) {
  if (message === null || message === undefined || typeof message !== 'object') return 0
  let chars = 0
  const add = (value) => {
    if (typeof value === 'string') chars += value.length
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        add(block.text)
        break
      case 'tool-call':
        add(block.name)
        add(block.arguments)
        break
      case 'image':
        chars += 1024
        break
      case 'file':
        chars += 256
        break
      default:
        break
    }
  }
  return Math.ceil(chars / 4) + overhead
}

/** The host's `deriveEventMessage` projection. @param {any} event */
export function deriveEventMessage(event) {
  switch (event?.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      const message = event.data?.message
      if (message === undefined || !Array.isArray(message.content)) return null
      return message.content.length === 0 ? null : message
    }
    case 'tool/result':
      return event.data?.message ?? null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A replacement `surfaceOp` is exactly `{op:'replace', startSeq, endSeq}`. */
function isReplaceOp(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const op = /** @type {Record<string, any>} */ (value)
  return (
    Object.keys(op).length === 3 &&
    Object.hasOwn(op, 'op') &&
    Object.hasOwn(op, 'startSeq') &&
    Object.hasOwn(op, 'endSeq') &&
    op.op === 'replace' &&
    isEventSeq(op.startSeq) &&
    isEventSeq(op.endSeq)
  )
}

/** @param {unknown} value */
function isEventSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * One session with the host's append-only log + surface fold.
 * `log` is public so tests can inspect the exact event stream.
 */
export class FakeSession {
  /** @param {{ id?: string, provider?: string, model?: string, contextWindow?: number|null, maxTokens?: number, extraTokens?: number }} [options] */
  constructor(options = {}) {
    this.id = options.id ?? `session-${randomUUID()}`
    this.provider = options.provider ?? 'fake-provider'
    this.model = options.model ?? 'fake-model'
    this.contextWindow = options.contextWindow === undefined ? 200_000 : options.contextWindow
    this.maxTokens = options.maxTokens ?? 1024
    this.extraTokens = options.extraTokens ?? 0

    /** @type {any[]} */
    this.log = []
    /** The model-visible projection: ordered event seqs plus host generations. */
    this.surface = { nodes: [], replaceGeneration: 0, contentGeneration: 0 }
    /** @type {Array<(session: any, event: any) => void>} */
    this.eventListeners = []
    this._publisher = null
    this._appending = false
    /** @type {any} */
    this._header = {
      config: { provider: this.provider, model: this.model, maxTokens: this.maxTokens },
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    }
    /** @type {any} */
    this._context =
      this.contextWindow === null || this.contextWindow === undefined
        ? { provider: this.provider, model: this.model }
        : { provider: this.provider, model: this.model, contextWindow: this.contextWindow }
  }

  /** Next event sequence == log length, exactly like the host. */
  get seq() {
    return this.log.length
  }

  /** @param {number} seq */
  eventAt(seq) {
    return this.log[seq]
  }

  /** @param {{ provider: string, model: string, maxTokens?: number }} options */
  setRoute(options) {
    this.provider = options.provider
    this.model = options.model
    if (typeof options.maxTokens === 'number') this.maxTokens = options.maxTokens
    this._header = {
      ...this._header,
      config: { ...this._header.config, provider: options.provider, model: options.model, maxTokens: this.maxTokens },
    }
    this._context = { ...this._context, provider: options.provider, model: options.model }
    return this
  }

  /** @param {number|null} contextWindow */
  setContextWindow(contextWindow) {
    this.contextWindow = contextWindow
    this._context = { ...this._context }
    if (contextWindow === null || contextWindow === undefined) delete this._context.contextWindow
    else this._context.contextWindow = contextWindow
    return this
  }

  requestHeader() {
    return this._header
  }

  requestContext() {
    return this._context
  }

  toolHistory() {
    return []
  }

  /** @param {any} event */
  deriveEventMessage(event) {
    return deriveEventMessage(event)
  }

  /**
   * Append one event with the host's validation and atomic surface fold.
   * @param {string} type
   * @param {any} data
   * @param {{ surfaceOp?: any, sourceEventSeqs?: number[] }} [opts]
   */
  append(type, data, opts = {}) {
    if (this._appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    const metadata = {
      ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: snapshotJsonValue(opts.sourceEventSeqs, 'surface metadata') }),
      ...(opts.surfaceOp === undefined ? {} : { surfaceOp: snapshotJsonValue(opts.surfaceOp, 'surface metadata') }),
    }
    const dataSnapshot = snapshotJsonValue(data, `session event "${type}"`)
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data: dataSnapshot,
      ...metadata,
    }

    // --- event-local validation (mirrors validateSessionEventData + restore shape)
    this._assertEventPayload(event)
    // --- surface planning (mirrors planSurfaceEvent)
    const plan = this._planSurface(event)

    this._appending = true
    try {
      this.log.push(deepFreeze(event))
      if (plan?.kind === 'append') {
        this.surface.nodes.push(event.seq)
      } else if (plan?.kind === 'replace') {
        this.surface.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, event.seq)
        this.surface.replaceGeneration += 1
        this.surface.contentGeneration += 1
      }
      const publisher = this._publisher
      if (publisher !== null) publisher(event)
    } finally {
      this._appending = false
    }
    return event
  }

  /** @param {any} event */
  _assertEventPayload(event) {
    const subject = `session event "${event.type}" at seq ${event.seq}`

    if (SURFACE_EVENT_TYPE_SET.has(event.type)) {
      const data = event.data
      if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
      const message = event.type === 'user/message' ? data : data.message
      if (!isRecord(message)) throw new Error(`${subject} lacks an identified message`)
      if (typeof message.id !== 'string' || message.id === '') throw new Error(`${subject} lacks an identified message`)
      const expectedRole = MESSAGE_ROLE_BY_TYPE[event.type]
      if (message.role !== expectedRole) throw new Error(`${subject} message must have role "${expectedRole}"`)
      if (!isRecord(message.source) || typeof message.source.kind !== 'string' || message.source.kind === '') {
        throw new Error(`${subject} message has invalid source`)
      }
      if (!Array.isArray(message.content)) throw new Error(`${subject} message has invalid content`)
      if (event.type === 'system/message' && message.source.kind !== 'system-prompt') {
        throw new Error(`${subject} message must have system-prompt source`)
      }
      if (event.type === 'assistant/message') {
        if (
          message.source.kind !== 'model' ||
          typeof message.source.provider !== 'string' ||
          message.source.provider === '' ||
          typeof message.source.model !== 'string' ||
          message.source.model === ''
        ) {
          throw new Error(`${subject} message must have model source`)
        }
      }
      if (event.type === 'tool/result') {
        if (message.source.kind !== 'tool' || typeof message.source.callId !== 'string' || message.source.callId === '') {
          throw new Error(`${subject} message must have tool source`)
        }
        if (message.toolCallId !== message.source.callId) {
          throw new Error(`${subject} message has mismatched tool call ids`)
        }
        if (data.error !== undefined && message.isError !== true) {
          throw new Error(`${subject} error requires message.isError === true`)
        }
      }
      return
    }

    // Log-only events may not carry surface metadata.
    if (event.surfaceOp !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    }
    if (event.sourceEventSeqs !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    }
  }

  /** @param {any} event @returns {{kind:'append'}|{kind:'replace',startIdx:number,endIdx:number,shadowedSeqs:number[]}|undefined} */
  _planSurface(event) {
    if (!SURFACE_EVENT_TYPE_SET.has(event.type)) {
      if (event.surfaceOp !== undefined) {
        throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
      }
      return undefined
    }
    const op = event.surfaceOp
    if (op === undefined) {
      throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
    }
    if (op === 'append') return { kind: 'append' }
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
    }
    if (!isReplaceOp(op)) {
      throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
    }
    if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
      throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
    }
    const startIdx = this.surface.nodes.indexOf(op.startSeq)
    if (startIdx === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`)
    const endIdx = this.surface.nodes.indexOf(op.endSeq)
    if (endIdx === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`)
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`)
    }
    const shadowedSeqs = this.surface.nodes.slice(startIdx, endIdx + 1)
    this._assertSourceEventReferences(event, shadowedSeqs)
    this._assertToolResultRewrite(event, shadowedSeqs)
    this._assertSystemHeadRewrite(event, startIdx, shadowedSeqs)
    return { kind: 'replace', startIdx, endIdx, shadowedSeqs }
  }

  /** @param {any} event @param {number[]} shadowedSeqs */
  _assertSourceEventReferences(event, shadowedSeqs) {
    if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
      throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
    }
    const sources = new Set()
    const raw = event.sourceEventSeqs
    if (raw !== undefined) {
      if (!Array.isArray(raw)) throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
      if (raw.length === 0) throw new Error('sourceEventSeqs must not be empty')
      for (const source of raw) {
        if (!isEventSeq(source)) {
          throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
        }
        sources.add(source)
        if (source >= event.seq) {
          throw new Error(`sourceEventSeqs must reference earlier events: ${source} >= current seq ${event.seq}`)
        }
      }
      if (sources.size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates')
    }
    const missing = shadowedSeqs.filter((seq) => !sources.has(seq))
    if (missing.length > 0) {
      throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
    }
  }

  /** @param {any} event @param {number[]} shadowedSeqs */
  _assertToolResultRewrite(event, shadowedSeqs) {
    if (event.type !== 'tool/result') return
    if (shadowedSeqs.length !== 1) {
      throw new Error('tool/result surface replacement must rewrite exactly one current node')
    }
    const original = this.eventAt(shadowedSeqs[0])
    if (original?.type !== 'tool/result') {
      throw new Error('tool/result surface replacement must target a current tool/result')
    }
    const originalRest = { ...original.data, message: { ...original.data.message, content: null } }
    const replacementRest = { ...event.data, message: { ...event.data.message, content: null } }
    if (!deepEqualJson(originalRest, replacementRest)) {
      throw new Error('tool/result surface replacement may change only content')
    }
  }

  /** @param {any} event @param {number} startIdx @param {number[]} shadowedSeqs */
  _assertSystemHeadRewrite(event, startIdx, shadowedSeqs) {
    if (startIdx !== 0) return
    const headSeq = this.surface.nodes[0]
    if (headSeq === undefined) return
    const head = this.eventAt(headSeq)
    if (head?.type !== 'system/message') return
    if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
      throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
    }
  }
}

// ---------------------------------------------------------------------------
// session / agent stores
// ---------------------------------------------------------------------------

export class FakeSessionStore {
  /** @param {FakeCtx} [ctx] */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, FakeSession>} */
    this.map = new Map()
    /** Flush spy: every `sessions.flush(session)` call records the session here. */
    /** @type {FakeSession[]} */
    this.flushes = []
    /** When set, `flush()` rejects with this error (manual-commit flush failure path). */
    /** @type {any} */
    this.flushError = undefined
  }

  /** @param {FakeSession} session */
  add(session) {
    this.map.set(session.id, session)
    session._publisher = (event) => this.ctx?.emit('session/event', session, event)
    return session
  }

  /** @param {FakeSession|string} session */
  remove(session) {
    this.map.delete(typeof session === 'string' ? session : session.id)
  }

  /** @param {string} id */
  get(id) {
    return this.map.get(id)
  }

  list() {
    return [...this.map.values()]
  }

  /** The host's only flush entry point (`sessions.flush(session)`). @param {FakeSession} session */
  flush(session) {
    this.flushes.push(session)
    if (this.flushError !== undefined) return Promise.reject(this.flushError)
    return Promise.resolve(true)
  }
}

export class FakeAgentStore {
  constructor() {
    /** @type {Map<string, any>} */
    this.map = new Map()
  }

  /** @param {any} agent */
  add(agent) {
    this.map.set(agent.session.id, agent)
    return agent
  }

  /** @param {any} agent */
  remove(agent) {
    this.map.delete(typeof agent === 'string' ? agent : agent.session.id)
  }

  /** @param {string} sessionId */
  get(sessionId) {
    return this.map.get(sessionId)
  }

  list() {
    return [...this.map.values()]
  }
}

// ---------------------------------------------------------------------------
// services: logger, token meter, llm, compaction, commands
// ---------------------------------------------------------------------------

/** @param {string[]} lines */
function createFakeLogger(lines) {
  const push = (level) => (/** @type {string} */ message) => {
    lines.push(`${level}: ${String(message)}`)
  }
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

export function createFakeTokenMeter() {
  /** @type {any} */
  const meter = {
    measureCalls: [],
    estimateMessageCalls: [],
    overheadTokens: 4,
    /** @param {FakeSession} session */
    measure(session) {
      meter.measureCalls.push(session.id)
      const nodes = session.surface.nodes.map((seq) => {
        const event = session.eventAt(seq)
        const message = event === undefined ? null : deriveEventMessage(event)
        const tokens = estimateMessageTokens(message, meter.overheadTokens)
        return { seq, tokens, heuristicTokens: tokens }
      })
      const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
      const totalTokens = surfaceTokens + (session.extraTokens ?? 0)
      return {
        logRevision: session.seq,
        baseline: { kind: 'estimated', tokens: 0 },
        surfaceDeltaTokens: surfaceTokens,
        totalTokens,
        surfaceTokens,
        nodes,
      }
    },
    /** @param {any} message */
    estimateMessage(message) {
      meter.estimateMessageCalls.push(message)
      return estimateMessageTokens(message, meter.overheadTokens)
    },
    /** @param {FakeSession} session */
    contextPressure(session) {
      const measurement = meter.measure(session)
      return {
        pressureTokens: measurement.totalTokens,
        ...(typeof session.contextWindow === 'number' && session.contextWindow > 0
          ? { contextWindow: session.contextWindow }
          : {}),
      }
    },
  }
  return meter
}

export function createFakeLlm(options = {}) {
  /** @type {Map<string, any>} */
  const models = new Map()
  for (const [key, info] of Object.entries(options.models ?? {})) models.set(key, info)

  const llm = {
    models,
    streamCalls: [],
    resolveModelInfoCalls: [],
    summaryText: options.summaryText ?? DEFAULT_SUMMARY_TEXT,
    streamDelayMs: options.streamDelayMs ?? 0,
    finish: options.finish ?? { kind: 'stop' },
    usage: options.usage ?? { inputTokens: 10, outputTokens: 20 },

    /** @param {string} provider @param {string} model @param {Record<string, any>} info */
    setModel(provider, model, info) {
      models.set(`${provider}/${model}`, info)
    },

    async resolveModelInfo(provider, model, signal) {
      llm.resolveModelInfoCalls.push({ provider, model })
      if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
      const info = models.get(`${provider}/${model}`)
      if (info === undefined) throw new Error(`fake llm: no adapter model info for ${provider}/${model}`)
      return { provider, id: model, name: model, ...info }
    },

    /** @param {any} request */
    stream(request) {
      llm.streamCalls.push(request)
      return streamChunks(request)
    },
  }

  /** @param {any} request */
  async function* streamChunks(request) {
    const signal = request?.signal
    const text = llm.summaryText
    const chunkSize = Math.max(1, Math.ceil(text.length / 3))
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
      if (llm.streamDelayMs > 0) await delay(llm.streamDelayMs, signal)
      yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + chunkSize) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: llm.usage }
    yield { type: 'finish', reason: llm.finish }
  }

  return llm
}

/** The turn still open at the log tail, or null (native `inspectCompactionEntryState`). @param {FakeSession} session */
function openTurnOf(session) {
  for (let seq = session.log.length - 1; seq >= 0; seq -= 1) {
    const event = session.log[seq]
    if (event.type === 'turn/start') return event.data.turn
    if (event.type === 'turn/end') return null
  }
  return null
}

/**
 * The aggressive native `/compact` range: keep the system head and one tail
 * node, shadow everything in between (native `retainTokens = 0`).
 * @param {FakeSession} session
 */
function nativeManualRange(session) {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null
  const firstIdx = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  const endIdx = nodes.length - 2
  if (endIdx < firstIdx) return null
  return {
    startIdx: firstIdx,
    endIdx,
    startSeq: nodes[firstIdx],
    endSeq: nodes[endIdx],
    shadowedSeqs: [...nodes.slice(firstIdx, endIdx + 1)],
  }
}

function manualCompactionError(code, message) {
  const error = new Error(message)
  error.name = 'ManualCompactionError'
  error.code = code
  return error
}

/**
 * @param {FakeSession} session
 * @param {{ shadowedSeqs: number[], startIdx: number, endIdx: number }} range
 * @param {any} summarized
 * @param {string|undefined} sourceCommandId
 */
function writeNativeCompaction(session, range, summarized, sourceCommandId) {
  const compactionId = randomUUID()
  const turn = openTurnOf(session)
  const { startSeq, endSeq } = range
  const lifecycle = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    turn,
  }
  const shadowedTokenCount = range.shadowedSeqs.reduce((total, seq) => {
    const event = session.eventAt(seq)
    return total + estimateMessageTokens(event === undefined ? null : deriveEventMessage(event))
  }, 0)
  const startEvent = session.append('compaction/start', lifecycle)
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    summary: summarized.summary,
    shadowedRange: { start: startSeq, end: endSeq },
    shadowedSeqs: [...range.shadowedSeqs],
    shadowedTokenCount,
    provider: summarized.provider,
    model: summarized.model,
  })
  const message = {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'compact-checkpoint', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) },
    content: [
      {
        type: 'text',
        text: `native background compaction\n\n${summarized.summary.map((block) => block.text).join('')}`,
      },
    ],
  }
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
  })
  const endEvent = session.append('compaction/end', lifecycle)
  return {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    endSeq: endEvent.seq,
    summary: summarized.summary,
    shadowedRange: { start: startSeq, end: endSeq },
    shadowedSeqs: [...range.shadowedSeqs],
    shadowedTokenCount,
    turn,
  }
}

/**
 * The mounted compaction backend: exposes the resolved policy as the instance
 * field `config` (that is what `dsh-compaction-basic` does), an optional
 * `summarize(input, agent, signal)` hook, and a native-style `compactNow`.
 */
export function createFakeCompactionBackend(options = {}) {
  /** @type {any} */
  const backend = {
    config: {
      thresholdRatio: 0.8,
      headroomTokens: 0,
      retainRatio: 0.16,
      retainTokens: 128,
      maxTokens: 4096,
      auto: true,
      ...(options.config ?? {}),
    },
    summarizeCalls: [],
    manualCalls: [],
    holdSummaries: options.holdSummaries ?? false,
    delayMs: options.delayMs ?? 0,
    summaryText: options.summaryText ?? DEFAULT_SUMMARY_TEXT,
    provider: options.provider ?? 'fake-provider',
    model: options.model ?? 'fake-model',
    summarizeError: undefined,
    /** Present only on backends that implement the hook. */
    summarize: undefined,
    /** Present only on backends that implement the manual entry point. */
    compactNow: undefined,

    releaseAll() {
      for (const call of backend.summarizeCalls) call.release?.()
    },
    pendingCount() {
      return backend.summarizeCalls.filter((call) => call.release !== undefined && call.settled !== true && call.aborted !== true)
        .length
    },
  }

  if (options.implementsSummarize !== false) {
    backend.summarize = async (input, agent, signal) => {
      const call = { input, agent, signal, at: Date.now(), settled: false, aborted: false }
      backend.summarizeCalls.push(call)
      try {
        if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
        if (backend.summarizeError !== undefined) throw backend.summarizeError
        if (backend.holdSummaries) {
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              call.aborted = true
              call.settled = true
              cleanup()
              reject(abortError(String(signal?.reason ?? 'aborted')))
            }
            const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
            call.release = () => {
              if (call.settled) return
              call.settled = true
              cleanup()
              resolve()
            }
            call.abort = onAbort
            signal?.addEventListener?.('abort', onAbort, { once: true })
            if (signal?.aborted) onAbort()
          })
        } else if (backend.delayMs > 0) {
          await delay(backend.delayMs, signal)
        }
        if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
        call.settled = true
        return {
          summary: [{ type: 'text', text: backend.summaryText }],
          rawOutput: [{ type: 'text', text: backend.summaryText }],
          llmStreamCall: true,
          provider: backend.provider,
          model: backend.model,
          maxTokens: backend.config.maxTokens,
          usage: { inputTokens: 100, outputTokens: 20 },
        }
      } finally {
        call.settled = true
      }
    }
  }

  if (options.implementsCompactNow !== false) {
    // Native-style synchronous `/compact`: refuses a non-idle agent, runs the
    // summarizer while holding the caller, then appends the same four events and
    // returns a host-shaped `CompactionResult`.
    backend.compactNow = async function compactNow(agent, signal, sourceCommandId) {
      const call = { agent, signal, sourceCommandId, at: Date.now() }
      backend.manualCalls.push(call)
      if (agent?.status !== 'idle') {
        throw manualCompactionError(
          'busy',
          'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
        )
      }
      if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
      const session = agent?.session
      if (session === undefined || session === null) return null
      const range = nativeManualRange(session)
      if (range === null) return null
      const summarized =
        typeof backend.summarize === 'function'
          ? await backend.summarize({ messages: [], tools: [] }, agent, signal)
          : {
              summary: [{ type: 'text', text: backend.summaryText }],
              provider: backend.provider,
              model: backend.model,
            }
      if (signal?.aborted) throw abortError(String(signal.reason ?? 'aborted'))
      return writeNativeCompaction(session, range, summarized, sourceCommandId)
    }
  }

  return backend
}

export function createFakeCommands() {
  /** @type {any[]} */
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
    get(name) {
      return definitions.find((definition) => definition.name === name)
    },
    list() {
      return [...definitions]
    },
  }
}

/**
 * The host's read-only web server registry: records every registered route and
 * returns the disposer `ctx.effect` expects.
 */
export function createFakeWebServer() {
  return {
    /** @type {Array<{ definition: any, disposed: boolean }>} */
    registered: [],
    /** @param {any} definition */
    register(definition) {
      const entry = { definition, disposed: false }
      this.registered.push(entry)
      return () => {
        entry.disposed = true
      }
    },
    get routes() {
      return this.registered.map((entry) => entry.definition)
    },
  }
}

// ---------------------------------------------------------------------------
// ctx
// ---------------------------------------------------------------------------

/**
 * A minimal Cordis-shaped context: event table, effect scope, manual interval,
 * and the services the plugin resolves through `ctx.get(...)`.
 */
export class FakeCtx {
  constructor(options = {}) {
    this.options = options
    /** @type {string[]} */
    this.logs = []
    this.logger = createFakeLogger(this.logs)
    /** @type {Map<string, Array<{ fn: Function, options: any }>>} */
    this.handlers = new Map()
    /** @type {Array<{ label: string, disposers: Function[] }>} */
    this.effects = []
    /** @type {Array<{ callback: Function, ms: number, stopped: boolean, runs: number }>} */
    this.intervals = []
    /** @type {Array<{ callback: Function, ms: number, cleared: boolean }>} */
    this.timeouts = []
    /** @type {Map<string, any>} */
    this.services = new Map()
    this.disposed = false
    this.tokenMeter = createFakeTokenMeter()
    this.llm = createFakeLlm(options.llm)
    this.compaction = createFakeCompactionBackend(options.compaction)
    this.commands = createFakeCommands()
    this.sessions = new FakeSessionStore(this)
    this.agents = new FakeAgentStore()
    this.agentPresets = { serviceFor: () => undefined }
    this.webServer = options.withoutWebServer === true ? undefined : createFakeWebServer()
    /** Recorded `ctx.inject([...], callback)` calls (the callback runs immediately). */
    /** @type {Array<{ names: string[], callback: Function }>} */
    this.injections = []
    // The host's timer service: the coordinator resolves it as `ctx.get('timer')`
    // and expects `interval(callback, ms)` / `timeout(callback, ms)` to return a
    // disposer. Neither schedules a real timer; tests drive them explicitly.
    this.timer = {
      interval: (callback, ms) => this.interval(callback, ms),
      timeout: (callback, ms) => {
        const record = { callback, ms, cleared: false }
        this.timeouts.push(record)
        return () => {
          record.cleared = true
        }
      },
    }

    this.services.set('tokenMeter', this.tokenMeter)
    this.services.set('llm', this.llm)
    this.services.set('compaction', this.compaction)
    this.services.set('commands', this.commands)
    this.services.set('sessions', this.sessions)
    this.services.set('agents', this.agents)
    this.services.set('agentPresets', this.agentPresets)
    this.services.set('timer', this.timer)
    if (this.webServer !== undefined) this.services.set('webServer', this.webServer)
  }

  /**
   * Cordis-style service injection. The fake supplies the requested services
   * immediately: the callback receives a child context exposing `webServer`
   * (when available) plus the parent's `effect`/`on`/`get`.
   * @param {string[]} names
   * @param {Function} callback
   */
  inject(names, callback) {
    this.injections.push({ names, callback })
    const webCtx = {
      webServer: this.webServer,
      effect: (execute, label) => this.effect(execute, label),
      on: (name, fn, options) => this.on(name, fn, options),
      get: (name) => this.get(name),
      logger: this.logger,
      interval: (fn, ms) => this.interval(fn, ms),
    }
    callback(webCtx)
  }

  /**
   * @param {string} name
   * @param {any} [value] - set the service; omit to read it.
   */
  provide(name, value) {
    this.services.set(name, value)
    if (name === 'tokenMeter') this.tokenMeter = value
    if (name === 'llm') this.llm = value
    if (name === 'compaction') this.compaction = value
    if (name === 'commands') this.commands = value
    return this
  }

  /** @param {string} name */
  get(name) {
    if (name === 'commands' && this.options.withoutCommands) return undefined
    if (name === 'compaction' && this.options.withoutCompaction) return undefined
    if (name === 'tokenMeter' && this.options.withoutTokenMeter) return undefined
    return this.services.get(name)
  }

  /**
   * @param {string} name
   * @param {Function} fn
   * @param {any} [options]
   */
  on(name, fn, options = {}) {
    const list = this.handlers.get(name) ?? []
    list.push({ fn, options })
    this.handlers.set(name, list)
    const remove = () => {
      const current = this.handlers.get(name)
      if (current === undefined) return
      const index = current.indexOf(entry)
      if (index >= 0) current.splice(index, 1)
    }
    const entry = list.at(-1)
    return remove
  }

  /** Observe-only dispatch with per-listener containment (host `emit`). */
  emit(name, ...args) {
    const list = [...(this.handlers.get(name) ?? [])]
    const results = []
    for (const entry of list) {
      try {
        const returned = entry.fn(...args)
        results.push(returned)
        if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
          returned.then(undefined, (error) => this.logger.warn(`${name} listener rejected: ${String(error)}`))
        }
      } catch (error) {
        this.logger.warn(`${name} listener threw: ${String(error)}`)
      }
    }
    return results
  }

  /**
   * Waterfall dispatch in registration order, with an injectable default.
   * @param {string} name
   * @param {any} payload
   * @param {Function} [fallback]
   */
  async waterfall(name, payload, fallback = () => ({ kind: 'enter' })) {
    const list = [...(this.handlers.get(name) ?? [])]
    const run = async (index) => {
      if (index >= list.length) return fallback(payload)
      return list[index].fn(payload, () => run(index + 1))
    }
    return run(0)
  }

  /** @param {Function} execute @param {string} [label] */
  effect(execute, label = 'anonymous') {
    const record = { label, disposers: [] }
    const executed = execute()
    if (typeof executed === 'function') {
      record.disposers.push(executed)
    } else if (executed !== null && typeof executed === 'object' && typeof executed[Symbol.iterator] === 'function') {
      for (const value of executed) if (typeof value === 'function') record.disposers.push(value)
    }
    this.effects.push(record)
    return () => this._disposeEffect(record)
  }

  /** @param {{ label: string, disposers: Function[] }} record */
  _disposeEffect(record) {
    const disposers = record.disposers.splice(0).reverse()
    for (const dispose of disposers) {
      try {
        const returned = dispose()
        if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
          returned.then(undefined, (error) => this.logger.warn(`effect "${record.label}" disposer rejected: ${String(error)}`))
        }
      } catch (error) {
        this.logger.warn(`effect "${record.label}" disposer threw: ${String(error)}`)
      }
    }
  }

  /**
   * Manual interval: returns a stop function and never schedules real timers.
   * @param {Function} callback @param {number} ms
   */
  interval(callback, ms) {
    const record = { callback, ms, stopped: false, runs: 0 }
    this.intervals.push(record)
    return () => {
      record.stopped = true
    }
  }

  /** Run every live interval callback once. */
  tick(times = 1) {
    for (let index = 0; index < times; index += 1) {
      for (const record of this.intervals) {
        if (record.stopped) continue
        record.runs += 1
        try {
          record.callback()
        } catch (error) {
          this.logger.warn(`interval callback threw: ${String(error)}`)
        }
      }
    }
    return this
  }

  /** Fire every pending `timer.timeout(...)` callback once (manual clock). */
  fireTimeouts() {
    for (const record of this.timeouts) {
      if (record.cleared) continue
      record.cleared = true
      try {
        record.callback()
      } catch (error) {
        this.logger.warn(`timeout callback threw: ${String(error)}`)
      }
    }
    return this
  }

  /** Unload the plugin exactly like a fiber teardown: LIFO effect disposal. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const record of [...this.effects].reverse()) this._disposeEffect(record)
    for (const record of this.intervals) record.stopped = true
    for (const record of this.timeouts) record.cleared = true
    // Let pending abort rejections settle.
    await Promise.resolve()
    await Promise.resolve()
  }

  /** All captured log lines, including the plugin's `[pre-compact]` prefix. */
  get logLines() {
    return this.logs
  }

  /** @param {string|RegExp} pattern */
  hasLog(pattern) {
    const test = typeof pattern === 'string' ? (line) => line.includes(pattern) : (line) => pattern.test(line)
    return this.logs.some(test)
  }

  /** @param {string|RegExp} pattern */
  countLogs(pattern) {
    const test = typeof pattern === 'string' ? (line) => line.includes(pattern) : (line) => pattern.test(line)
    return this.logs.filter(test).length
  }
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/**
 * Build a realistic session: system head, optional open turn, then N turns of
 * user → (tool call + result)* → assistant messages.
 * @param {{
 *   id?: string,
 *   systemText?: string|null,
 *   turns?: number,
 *   toolPairs?: number,
 *   turnOpen?: boolean,
 *   extraTokens?: number,
 *   contextWindow?: number|null,
 *   provider?: string,
 *   model?: string,
 *   maxTokens?: number,
 * }} [options]
 */
export function makeSession(options = {}) {
  const session = new FakeSession(options)
  const turns = options.turns ?? 10
  const toolPairs = options.toolPairs ?? 0
  if (options.turnOpen === true) session.append('turn/start', { turn: 1 })
  if (options.systemText !== null) {
    session.append(
      'system/message',
      { turn: 1, step: 0, message: systemMessage(options.systemText ?? DEFAULT_SYSTEM_TEXT) },
      { surfaceOp: 'append' },
    )
  }
  let callId = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append(
      'user/message',
      userMessage(
        `User message ${turn}: ${'context detail '.repeat(4)}please continue the implementation with care.`,
      ),
      { surfaceOp: 'append' },
    )
    for (let pair = 0; pair < toolPairs; pair += 1) {
      callId += 1
      session.append(
        'assistant/message',
        {
          turn,
          step: pair,
          message: assistantMessage({
            text: `Inspecting project file part ${turn}.${pair}.`,
            toolCalls: [toolCallBlock('read_file', { path: `src/file-${turn}-${pair}.js` }, `call-${callId}`)],
            provider: session.provider,
            model: session.model,
          }),
        },
        { surfaceOp: 'append' },
      )
      session.append(
        'tool/result',
        {
          turn,
          step: pair,
          message: toolResultMessage({
            callId: `call-${callId}`,
            text: `Result for call-${callId}: ${'content detail '.repeat(5)}`,
          }),
        },
        { surfaceOp: 'append' },
      )
    }
    session.append(
      'assistant/message',
      {
        turn,
        step: toolPairs,
        message: assistantMessage({
          text: `Turn ${turn} summary: ${'completed the requested step '.repeat(3)}`,
          provider: session.provider,
          model: session.model,
        }),
      },
      { surfaceOp: 'append' },
    )
  }
  return session
}

/** @param {FakeSession} session @param {Record<string, any>} [overrides] */
export function makeAgent(session, overrides = {}) {
  return {
    session,
    status: 'idle',
    options: { provider: session.provider, model: session.model },
    ...overrides,
  }
}

/**
 * Boot the plugin on a fresh fake ctx.
 * @param {Record<string, unknown>} [configOverride]
 * @param {ConstructorParameters<typeof FakeCtx>[0]} [options]
 */
export function spawnPlugin(configOverride = {}, options = {}) {
  const ctx = new FakeCtx(options)
  apply(ctx, configOverride)
  return { ctx }
}

// ---------------------------------------------------------------------------
// driver helpers (the plugin has no exported runtime; drive it through hooks)
// ---------------------------------------------------------------------------

/** @param {FakeCtx} ctx @param {any} agent @param {Record<string, any>} [extra] */
export function preStep(ctx, agent, extra = {}) {
  return ctx.waterfall('agent/pre-step', { agent, ...extra })
}

/** @param {FakeCtx} ctx @param {any} agent */
export function turnStopping(ctx, agent) {
  return ctx.emit('agent/turn-stopping', { agent, turn: 1 })
}

/** @param {FakeCtx} ctx @param {any} agent @param {'idle'|'running'} status */
export function agentStatus(ctx, agent, status) {
  agent.status = status
  return ctx.emit('agent/status', { agent, status })
}

/** @param {FakeCtx} ctx @param {any} agent */
export function agentIdle(ctx, agent) {
  return agentStatus(ctx, agent, 'idle')
}

/** @param {FakeCtx} ctx @param {any} agent */
export function agentRunning(ctx, agent) {
  return agentStatus(ctx, agent, 'running')
}

/** @param {FakeCtx} ctx @param {FakeSession} session */
export function sessionDisposed(ctx, session) {
  ctx.sessions.remove(session)
  return ctx.emit('session/disposed', session)
}

/** @param {FakeCtx} ctx @param {any} agent */
export function agentDisposed(ctx, agent) {
  ctx.agents.remove(agent)
  return ctx.emit('agent/disposed', { agent })
}

// ---------------------------------------------------------------------------
// command helpers
// ---------------------------------------------------------------------------

/** @param {FakeCtx} ctx @param {string} name */
export function commandOf(ctx, name) {
  return ctx.get('commands')?.get?.(name)
}

/**
 * Invoke a registered command exactly like the host adapter would.
 * @param {FakeCtx} ctx @param {string} name @param {Record<string, any>} [invocation]
 */
export async function runCommand(ctx, name, invocation = {}) {
  const definition = commandOf(ctx, name)
  if (definition === undefined) throw new Error(`command "${name}" is not registered`)
  return definition.handler({ rawInput: '', ...invocation })
}

/** @param {FakeCtx} ctx @param {any} [agent] @param {string} [rawInput] */
export async function statusText(ctx, agent, rawInput = '') {
  const result = await runCommand(ctx, 'precompact', { agent, rawInput })
  return result?.text ?? ''
}

/** Extract `Task state: READY` from the status command output. */
export function phaseFromText(text) {
  const match = /Task state: ([A-Z]+)/.exec(text)
  return match === null ? null : match[1]
}

/**
 * Poll the public `/precompact status` command until the phase is reached.
 * Avoids fixed sleeps and does not depend on private runtime internals.
 * @param {FakeCtx} ctx @param {any} agent @param {string|string[]} phases
 * @param {{ timeout?: number, interval?: number }} [options]
 */
export async function waitForPhase(ctx, agent, phases, options = {}) {
  const wanted = new Set(Array.isArray(phases) ? phases : [phases])
  let text = ''
  await waitFor(
    async () => {
      text = await statusText(ctx, agent)
      return wanted.has(phaseFromText(text))
    },
    { label: `phase ${[...wanted].join('|')}`, ...options },
  )
  return text
}

/**
 * Poll an arbitrary condition.
 * @param {() => any} predicate
 * @param {{ timeout?: number, interval?: number, label?: string }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 3000
  const interval = options.interval ?? 5
  const label = options.label ?? 'condition'
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started >= timeout) throw new Error(`timed out after ${timeout}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

// ---------------------------------------------------------------------------
// event helpers
// ---------------------------------------------------------------------------

/** @param {FakeSession} session @param {string} type */
export function eventsOfType(session, type) {
  return session.log.filter((event) => event.type === type)
}

/** @param {FakeSession} session */
export function lastEvent(session) {
  return session.log.at(-1)
}

/** @param {FakeSession} session @param {number} count */
export function tailEvents(session, count) {
  return session.log.slice(-count)
}

/** @param {FakeSession} session */
export function surfaceEvents(session) {
  return session.surface.nodes.map((seq) => session.eventAt(seq))
}

/** @param {FakeSession} session @param {number} seq */
export function isOnSurface(session, seq) {
  return session.surface.nodes.includes(seq)
}

/**
 * Rewrite one tool/result node's content — the only replacement the host allows
 * for a `tool/result` — exactly like the tool-result pruner does.
 * @param {FakeSession} session
 * @param {number} seq
 * @param {string} text
 */
export function rewriteToolResult(session, seq, text) {
  const original = session.eventAt(seq)
  if (original?.type !== 'tool/result') throw new Error(`rewriteToolResult: seq ${seq} is not a tool/result`)
  const data = jsonClone(original.data)
  data.message.content = [{ type: 'text', text }]
  return session.append('tool/result', data, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}

/**
 * Compact a range exactly like the native backend does, with the four-event
 * transaction. Used to simulate a native compaction landing while a prepared
 * result is cached.
 * @param {FakeSession} session
 * @param {{ startSeq: number, endSeq: number, compactionId?: string, summaryText?: string, turn?: number|null }} options
 */
export function nativeCompactRange(session, options) {
  const startIdx = session.surface.nodes.indexOf(options.startSeq)
  const endIdx = session.surface.nodes.indexOf(options.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error('nativeCompactRange: invalid range')
  }
  const shadowedSeqs = session.surface.nodes.slice(startIdx, endIdx + 1)
  const compactionId = options.compactionId ?? randomUUID()
  const summaryText = options.summaryText ?? DEFAULT_SUMMARY_TEXT
  const turn = options.turn ?? null
  const lifecycle = { compactionId, turn }
  const startEvent = session.append('compaction/start', lifecycle)
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: summaryText }],
    shadowedRange: { start: options.startSeq, end: options.endSeq },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount: shadowedSeqs.length,
    provider: session.provider,
    model: session.model,
  })
  const message = {
    id: randomUUID(),
    role: 'user',
    source: {
      kind: 'compact-checkpoint',
      compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
    },
    content: [{ type: 'text', text: `native summary check\n\n${summaryText}` }],
  }
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: options.startSeq, endSeq: options.endSeq },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  const endEvent = session.append('compaction/end', lifecycle)
  return { startEvent, summaryEvent, endEvent, shadowedSeqs, compactionId }
}
