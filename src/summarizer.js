/**
 * Summarization for a background pre-compaction.
 *
 * Preferred path: call the mounted backend's own `summarize(input, agent,
 * signal)` hook. That reuses the native prompt, model routing, KV-cache-friendly
 * prefix, output cap and usage accounting, so the pre-compaction produces the
 * same artifact the native mechanism would produce — just earlier and off the
 * critical path.
 *
 * Fallback path (only when a backend without that hook is mounted): stream the
 * same instruction through `ctx.llm.stream()` and assemble text ourselves.
 * @module dsh-pre-compact/summarizer
 */

import { COMPACTION_INSTRUCTION, createCheckpointMessage } from './surface.js'
import { compactionServiceOf } from './native-policy.js'
import { errorChain } from './util.js'

/** Output cap assumed only when neither the backend nor the plugin config names one. */
const FALLBACK_MAX_TOKENS = 65536

/**
 * @typedef {object} SummarizationResult
 * @property {Array<{ type: 'text', text: string }>} summary
 * @property {Array<any>} [rawOutput]
 * @property {boolean} llmStreamCall
 * @property {string} provider
 * @property {string} model
 * @property {number} [maxTokens]
 * @property {any} [usage]
 * @property {'backend-hook' | 'llm-stream'} source
 */

/**
 * @param {object} input
 * @param {any} input.ctx
 * @param {Record<string, any>} input.config
 * @param {any} input.agent
 * @param {Record<string, any>} input.snapshot
 * @param {AbortSignal} input.signal
 * @param {ReturnType<import('./log.js').createLogger>} input.log
 * @returns {Promise<SummarizationResult>}
 */
export async function runSummarization({ ctx, config, agent, snapshot, signal, log }) {
  const engine = compactionServiceOf(ctx, agent)
  if (engine !== undefined && typeof engine.summarize === 'function') {
    log.debug('summarizing through the mounted backend hook', { provider: snapshot.route?.provider, model: snapshot.route?.model })
    const raw = await engine.summarize(snapshot.input, agent, signal)
    return normalizeResult(raw, snapshot, 'backend-hook')
  }
  log.warn('mounted backend has no summarize() hook; falling back to a direct streaming call')
  return fallbackSummarize({ ctx, agent, snapshot, signal })
}

/**
 * @param {any} raw
 * @param {Record<string, any>} snapshot
 * @param {'backend-hook'} source
 * @returns {SummarizationResult}
 */
function normalizeResult(raw, snapshot, source) {
  const summary = Array.isArray(raw?.summary) ? raw.summary : undefined
  if (summary === undefined) throw new Error('summarization returned no summary blocks')
  const textBlocks = summary.filter((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string')
  if (textBlocks.length === 0 || textBlocks.every((/** @type {any} */ block) => block.text.trim().length === 0)) {
    throw new Error('summarization produced no text summary content')
  }
  const provider = typeof raw?.provider === 'string' && raw.provider.length > 0 ? raw.provider : snapshot.route?.provider
  const model = typeof raw?.model === 'string' && raw.model.length > 0 ? raw.model : snapshot.route?.model
  if (!provider || !model) throw new Error('summarization returned no provider/model route')
  return {
    summary: textBlocks,
    ...(Array.isArray(raw?.rawOutput) ? { rawOutput: raw.rawOutput } : {}),
    llmStreamCall: raw?.llmStreamCall === true,
    provider,
    model,
    ...(typeof raw?.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
    ...(raw?.usage === undefined ? {} : { usage: raw.usage }),
    source,
  }
}

/**
 * Stream one summarization call and assemble its text blocks without depending
 * on host packages.
 * @param {object} input
 * @param {any} input.ctx
 * @param {Record<string, any>} input.config
 * @param {any} input.agent
 * @param {Record<string, any>} input.snapshot
 * @param {AbortSignal} input.signal
 * @returns {Promise<SummarizationResult>}
 */
async function fallbackSummarize({ ctx, agent, snapshot, signal }) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('no llm service is mounted for fallback summarization')
  }
  const route = snapshot.route
  if (route === undefined || !route.provider || !route.model) {
    throw new Error('no routed provider/model is available for summarization')
  }
  // The summarizer model is not configurable here: the fallback summarizes on
  // the session's own route, so compaction stays a backend concern.
  const provider = route.provider
  const model = route.model
  const maxTokens = FALLBACK_MAX_TOKENS

  const messages = [
    ...snapshot.input.messages,
    { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
  ]
  const options = {
    provider,
    model,
    messages,
    toolHistory: typeof agent?.session?.toolHistory === 'function' ? agent.session.toolHistory() : undefined,
    ...(snapshot.input.tools === undefined ? {} : { tools: [...snapshot.input.tools] }),
    maxTokens,
    sessionId: agent?.session?.id ?? snapshot.sessionId,
    purpose: 'compaction',
    signal,
  }

  /** @type {Map<number, { text: string, order: number }>} */
  const texts = new Map()
  let order = 0
  let usage
  let finish
  for await (const chunk of llm.stream(options)) {
    switch (chunk?.type) {
      case 'text-delta': {
        const index = typeof chunk.index === 'number' ? chunk.index : 0
        if (!texts.has(index)) texts.set(index, { text: '', order: order++ })
        const entry = texts.get(index)
        if (entry !== undefined) entry.text += String(chunk.text ?? '')
        break
      }
      case 'block-end': {
        const index = typeof chunk.index === 'number' ? chunk.index : 0
        const block = chunk.block
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (!texts.has(index)) texts.set(index, { text: block.text, order: order++ })
          else texts.get(index).text = block.text
        }
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }

  const kind = finish?.kind ?? 'stop'
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish?.failure
    const error = new Error(failure?.message ? String(failure.message) : `summarization stream ended with ${kind}`)
    if (typeof failure?.code === 'string') error.code = failure.code
    throw error
  }
  if (kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
    error.code = 'MAX_TOKENS'
    throw error
  }
  const text = [...texts.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([, entry]) => entry.text)
    .join('')
  if (text.trim().length === 0) throw new Error('summarization produced no text summary content')
  const blocks = [{ type: 'text', text }]
  return {
    summary: blocks,
    rawOutput: blocks,
    llmStreamCall: true,
    provider,
    model,
    maxTokens,
    ...(usage === undefined ? {} : { usage }),
    source: 'llm-stream',
  }
}

/**
 * Build the durable replacement message and price it with the host meter.
 * @param {{ estimateMessage: (message: any) => number }} meter
 * @param {string} compactionId
 * @param {Array<{ type: 'text', text: string }>} summary
 */
export function prepareCheckpoint(meter, compactionId, summary, sourceCommandId) {
  const message = createCheckpointMessage(compactionId, summary, sourceCommandId)
  let framedTokens
  try {
    framedTokens = meter.estimateMessage(message)
  } catch (error) {
    throw new Error(`cannot price the checkpoint message: ${errorChain(error)}`)
  }
  return { message, framedTokens }
}
