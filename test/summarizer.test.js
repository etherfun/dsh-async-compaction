/**
 * Summarization: the mounted-backend hook, the `ctx.llm.stream()` fallback, the
 * checkpoint pricing, and the fallback commit bug found during testing.
 * @module test/summarizer.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { runSummarization, prepareCheckpoint } from '../src/summarizer.js'
import {
  DEFAULT_SUMMARY_TEXT,
  FakeCtx,
  checkContentBlocks,
  eventsOfType,
  makeAgent,
  makeSession,
  preStep,
  spawnPlugin,
  statusText,
  waitForPhase,
} from './fake-harness.js'

/** @param {Record<string, any>} [compaction] */
function makeCtx(compaction = {}) {
  const ctx = new FakeCtx({ compaction })
  return ctx
}

function config(overrides = {}) {
  return resolveConfig(overrides).config
}

const AGENT = { session: { id: 'agent-session', toolHistory: () => [] } }

/** @param {Record<string, any>} [overrides] */
function snapshot(overrides = {}) {
  return {
    input: { messages: [{ role: 'system', content: [{ type: 'text', text: 'system prompt' }] }], tools: [] },
    route: { provider: 'route-provider', model: 'route-model' },
    sessionId: 'agent-session',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// mounted backend hook
// ---------------------------------------------------------------------------

test('the backend summarize() hook is preferred and its result is normalized', async () => {
  const ctx = makeCtx({ summaryText: DEFAULT_SUMMARY_TEXT })
  const result = await runSummarization({
    ctx,
    config: config(),
    agent: AGENT,
    snapshot: snapshot(),
    signal: new AbortController().signal,
    log: ctx.logger,
  })
  assert.equal(result.source, 'backend-hook')
  assert.equal(result.provider, 'fake-provider')
  assert.equal(result.model, 'fake-model')
  assert.equal(result.llmStreamCall, true)
  assert.ok(Array.isArray(result.rawOutput))
  assert.deepEqual(result.summary, [{ type: 'text', text: DEFAULT_SUMMARY_TEXT }])
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
})

test('non-text summary blocks are dropped by the normalizer', async () => {
  const ctx = makeCtx()
  ctx.compaction.summarize = async () => ({
    summary: [
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'the real summary' },
    ],
    provider: 'p',
    model: 'm',
  })
  const result = await runSummarization({
    ctx,
    config: config(),
    agent: AGENT,
    snapshot: snapshot(),
    signal: new AbortController().signal,
    log: ctx.logger,
  })
  assert.deepEqual(result.summary, [{ type: 'text', text: 'the real summary' }])
})

test('a backend result without summary blocks fails closed', async () => {
  const ctx = makeCtx()
  ctx.compaction.summarize = async () => ({ provider: 'p', model: 'm' })
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /returned no summary blocks/,
  )
})

test('a backend result with only blank text fails closed', async () => {
  const ctx = makeCtx()
  ctx.compaction.summarize = async () => ({ summary: [{ type: 'text', text: '   ' }], provider: 'p', model: 'm' })
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /no text summary content/,
  )
})

test('a backend result without any provider/model route fails closed', async () => {
  const ctx = makeCtx()
  ctx.compaction.summarize = async () => ({ summary: [{ type: 'text', text: 'ok' }] })
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot({ route: undefined }),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /no provider\/model route/,
  )
})

test('the route from the snapshot fills in a missing provider/model', async () => {
  const ctx = makeCtx()
  ctx.compaction.summarize = async () => ({ summary: [{ type: 'text', text: 'ok' }] })
  const result = await runSummarization({
    ctx,
    config: config(),
    agent: AGENT,
    snapshot: snapshot(),
    signal: new AbortController().signal,
    log: ctx.logger,
  })
  assert.equal(result.provider, 'route-provider')
  assert.equal(result.model, 'route-model')
})

// ---------------------------------------------------------------------------
// direct LLM stream fallback
// ---------------------------------------------------------------------------

test('the fallback streams through ctx.llm.stream and assembles the text', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  ctx.llm.summaryText = '## fallback summary\n- one line'
  const result = await runSummarization({
    ctx,
    config: config(),
    agent: AGENT,
    snapshot: snapshot(),
    signal: new AbortController().signal,
    log: ctx.logger,
  })
  assert.equal(result.source, 'llm-stream')
  assert.equal(result.llmStreamCall, true)
  assert.deepEqual(result.rawOutput, [{ type: 'text', text: '## fallback summary\n- one line' }], 'the fallback reports its raw output so the summary event stays lossless-JSON')
  assert.deepEqual(result.summary, [{ type: 'text', text: '## fallback summary\n- one line' }])
  assert.equal(result.provider, 'route-provider')
  assert.equal(result.model, 'route-model')
  assert.equal(result.maxTokens, 65536)
  assert.equal(ctx.llm.streamCalls.length, 1)
  assert.equal(ctx.llm.streamCalls[0].purpose, 'compaction')
  assert.equal(ctx.llm.streamCalls[0].maxTokens, 65536)
})

test('the fallback always uses the session route and the constant token cap', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  // Legacy summarization/routing keys no longer exist; passing them through the
  // raw config must not change the fallback's route or output cap.
  const result = await runSummarization({
    ctx,
    config: config({
      maxSummaryTokens: 1234,
      summarizationProvider: 'p2',
      summarizationModel: 'm2',
    }),
    agent: AGENT,
    snapshot: snapshot(),
    signal: new AbortController().signal,
    log: ctx.logger,
  })
  assert.equal(result.provider, 'route-provider')
  assert.equal(result.model, 'route-model')
  assert.equal(result.maxTokens, 65_536)
  assert.equal(ctx.llm.streamCalls[0].maxTokens, 65_536)
  assert.equal(ctx.llm.streamCalls[0].provider, 'route-provider')
  assert.equal(ctx.llm.streamCalls[0].model, 'route-model')
})

test('the fallback fails without an llm service', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  ctx.provide('llm', undefined)
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /no llm service is mounted/,
  )
})

test('the fallback fails without a routed provider/model', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot({ route: undefined }),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /no routed provider\/model/,
  )
})

test('a truncated fallback stream fails with MAX_TOKENS', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  ctx.llm.finish = { kind: 'max-tokens' }
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    (error) => error.code === 'MAX_TOKENS',
  )
})

test('a failed fallback stream propagates the provider failure', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  ctx.llm.finish = { kind: 'error', failure: { message: 'provider exploded', code: 'PROVIDER' } }
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    (error) => error.message === 'provider exploded' && error.code === 'PROVIDER',
  )
})

test('an empty fallback stream fails closed', async () => {
  const ctx = makeCtx({ implementsSummarize: false })
  ctx.llm.summaryText = ''
  await assert.rejects(
    runSummarization({
      ctx,
      config: config(),
      agent: AGENT,
      snapshot: snapshot(),
      signal: new AbortController().signal,
      log: ctx.logger,
    }),
    /no text summary content/,
  )
})

// ---------------------------------------------------------------------------
// checkpoint pricing
// ---------------------------------------------------------------------------

test('prepareCheckpoint frames the message and prices it with the host meter', () => {
  const ctx = new FakeCtx()
  const meter = ctx.get('tokenMeter')
  const summary = [{ type: 'text', text: 'a short summary' }]
  const prepared = prepareCheckpoint(meter, 'compaction-1', summary)
  assert.equal(prepared.message.role, 'user')
  assert.deepEqual(prepared.message.source, { kind: 'compact-checkpoint', compactionId: 'compaction-1' })
  assert.equal(prepared.framedTokens, meter.estimateMessage(prepared.message))
  assert.ok(prepared.framedTokens > 0)

  // A manual command id is forwarded into the checkpoint source.
  const manual = prepareCheckpoint(meter, 'compaction-2', summary, 'command-9')
  assert.deepEqual(manual.message.source, {
    kind: 'compact-checkpoint',
    compactionId: 'compaction-2',
    sourceCommandId: 'command-9',
  })
})

// ---------------------------------------------------------------------------
// bug: the fallback result cannot be committed on a real host
// ---------------------------------------------------------------------------

/**
 * The fallback result has no `rawOutput`, and `src/commit.js` unconditionally
 * emits `{ rawOutput: prepared.rawOutput }` when `llmStreamCall === true`.
 * `Session.append()` snapshots its payload with the host's lossless-JSON
 * validator, which rejects an `undefined` property — so the replacement never
 * lands. Regression tests below guard both halves of that fix.
 * @param {{ dryRun?: boolean }} [options]
 */
function setupFallbackCommit(options = {}) {
  const { ctx } = spawnPlugin(
    {
      triggerMode: 'fixed',
      fixedThreshold: 0.05,
      minInterval: 60_000,
      minShadowedTokens: 0,
      dryRun: options.dryRun === true,
    },
    { compaction: { implementsSummarize: false, summaryText: DEFAULT_SUMMARY_TEXT } },
  )
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))
  return { ctx, session, agent }
}

test('fallback commit lands four events without undefined fields (REPORT #1 regression)', async () => {
  const { ctx, session, agent } = setupFallbackCommit()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  const logLength = session.log.length
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'COMPLETED')

  const tail = session.log.slice(logLength)
  assert.deepEqual(
    tail.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  )
  assert.ok(Object.hasOwn(tail[1].data, 'rawOutput'), 'rawOutput is present instead of undefined')
  assert.equal(tail[1].data.llmStreamCall, true)
  assert.equal(tail[3].data.error, undefined, 'the lock closes without an error')

  const status = await statusText(ctx, agent)
  assert.match(status, /Task state: COMPLETED/)
  await ctx.dispose()
})

test('fallback summarization commits on a real host (REPORT #1 fixed)', async () => {
  const { ctx, session, agent } = setupFallbackCommit()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'COMPLETED')
  assert.equal(eventsOfType(session, 'compaction/end').length, 1)
  assert.deepEqual(eventsOfType(session, 'compaction/end').at(-1).data.error, undefined)
  await ctx.dispose()
})

// Guard: the helper is used so the imported content-block checker is not dead code.
test('checkContentBlocks mirrors the host content-block vocabulary', () => {
  assert.equal(checkContentBlocks([{ type: 'text', text: 'x' }]), true)
  assert.equal(checkContentBlocks([{ type: 'image', data: 'x' }, { type: 'text', text: 'y' }]), true)
  assert.equal(checkContentBlocks([{ type: 'tool-call', id: 'c', name: 'n', arguments: '{}' }]), true)
  assert.equal(checkContentBlocks([{ type: 'unknown-ish' }]), false)
})
