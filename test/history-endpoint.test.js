/**
 * Read-only session-view history endpoint: payload shape, whitelist, id and
 * origin validation, failure mapping.
 * @module test/history-endpoint.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { HISTORY_PATH, createHistoryResource } from '../src/history-endpoint.js'
import { LOGS_PATH } from '../src/logs-endpoint.js'
import { VISUAL_STATUS_PATH } from '../src/visual-status.js'
import { FakeCtx } from './fake-harness.js'

const CURRENT_KEYS = [
  'applyStrategy',
  'contextWindow',
  'currentTokens',
  'enabled',
  'growthRateTokensPerSecond',
  'lastFailure',
  'lastSkip',
  'manualHook',
  'manualRequest',
  'mode',
  'nativeThresholdRatio',
  'nativeThresholdTokens',
  'phase',
  'predictedDurationSeconds',
  'step',
  'triggerRatio',
  'triggerReason',
  'triggerTokens',
  'turn',
  'usageRatio',
]

/** A `runtime.statusFor()`-shaped session with samples and history. */
function statusStub(overrides = {}) {
  return {
    sessionId: 'session-abc',
    turn: 7,
    step: 4,
    enabled: true,
    mode: 'fixed',
    applyStrategy: 'safe',
    phase: 'IDLE',
    currentTokens: 12_000,
    surfaceNodes: 10,
    contextWindow: 200_000,
    usageRatio: 0.06,
    nativeThresholdTokens: 160_000,
    nativeThresholdRatio: 0.8,
    nativeSource: 'backend-config',
    triggerTokens: 130_000,
    triggerRatio: 0.65,
    triggerReason: 'fixed-threshold',
    dataComplete: true,
    derivation: { internal: true },
    growthRateTokensPerSecond: 200,
    predictedDurationSeconds: 58.5,
    durationObservations: 0,
    lastMeasurementAt: 1,
    lastEvaluationAt: 2,
    lastSkip: { at: 3, reason: 'range-too-small', detail: 'internal selection detail' },
    retriggerFloor: 0,
    activeTask: null,
    readyResult: null,
    manualRequest: { id: 'req-1', requestedAt: 4, sourceCommandId: 'cmd-secret', retried: false },
    lastOutcome: null,
    lastFailure: { at: 5, code: 'locked', message: 'internal error chain', detail: { task: 'task-9' } },
    lastMeasureError: null,
    manualHook: { state: 'active' },
    samples: [
      { at: 10, tokens: 10_000, trigger: 130_000, native: 160_000, turn: 1, step: 1 },
      { at: 20, tokens: 11_500, trigger: 130_000, native: 160_000, turn: 1, step: 1 },
    ],
    steps: [
      { at: 20, tokens: 11_500, trigger: 130_000, native: 160_000, turn: 1, step: 1 },
      { at: 25, tokens: 12_000, trigger: 130_000, native: 160_000, turn: 1, step: 2 },
    ],
    history: [
      {
        at: 30,
        turn: 1,
        step: 2,
        manual: false,
        trigger: 'fixed-threshold',
        mode: 'fixed',
        boundary: 'pre-step',
        compactionId: 'compaction-1',
        shadowedTokens: 8000,
        framedTokens: 3200,
        reduction: 0.6,
        totalAfterEstimate: 4800,
        durationMs: 42,
      },
    ],
    ...overrides,
  }
}

/** @param {any} result */
function fakeRuntime(result) {
  const calls = []
  return {
    calls,
    statusFor(sessionId) {
      calls.push(sessionId)
      return typeof result === 'function' ? result(sessionId) : result
    },
  }
}

/** @param {string} query @param {Record<string, string>} [headers] */
function request(query = '', headers = undefined) {
  return new Request(`http://example.test${HISTORY_PATH}${query}`, headers === undefined ? undefined : { headers })
}

/** @param {Response} response */
async function jsonBody(response) {
  return JSON.parse(await response.text())
}

test('the history endpoint returns the bounded series and applied compactions', async () => {
  const status = statusStub()
  const runtime = fakeRuntime(status)
  const response = await createHistoryResource(runtime)(request('?sessionId=abc'))

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await jsonBody(response)
  assert.equal(body.ok, true)
  assert.equal(body.version, 1)
  assert.equal(typeof body.now, 'number')
  assert.equal(body.sessionId, 'abc')
  assert.deepEqual(body.samples, status.samples)
  assert.deepEqual(body.steps, status.steps)
  assert.deepEqual(body.history, status.history)
  assert.deepEqual(runtime.calls, ['abc'])
})

test('current is a strict whitelist aligned with runtime.statusFor()', async () => {
  assert.equal(CURRENT_KEYS.length, 20)
  const body = await jsonBody(await createHistoryResource(fakeRuntime(statusStub()))(request('?sessionId=abc')))
  assert.deepEqual(Object.keys(body.current).sort(), CURRENT_KEYS)
  assert.equal(body.current.currentTokens, 12_000)
  assert.equal(body.current.nativeThresholdTokens, 160_000)
  assert.equal(body.current.triggerReason, 'fixed-threshold')
  assert.equal(body.current.turn, 7, 'the visualization turn is passed through')
  assert.equal(body.current.step, 4, 'the visualization step is passed through')

  // Diagnostic objects are trimmed to their public shape: no internal error
  // chains, selection details, command ids or task references.
  assert.deepEqual(body.current.lastFailure, { at: 5, code: 'locked' })
  assert.deepEqual(body.current.lastSkip, { at: 3, reason: 'range-too-small' })
  assert.deepEqual(body.current.manualRequest, { id: 'req-1', requestedAt: 4, retried: false })

  // Fields outside the view model never leak into `current` (or the top level).
  for (const hidden of ['readyResult', 'activeTask', 'derivation', 'lastOutcome', 'surfaceNodes', 'dataComplete']) {
    assert.equal(Object.hasOwn(body.current, hidden), false, `${hidden} must not be exposed`)
    assert.equal(Object.hasOwn(body, hidden), false, `${hidden} must not be exposed at top level`)
  }
})

test('current.turn and current.step stay null before any turn/step was observed', async () => {
  const body = await jsonBody(
    await createHistoryResource(fakeRuntime(statusStub({ turn: null, step: null })))(request('?sessionId=abc')),
  )
  assert.equal(body.current.turn, null)
  assert.equal(body.current.step, null)
  assert.deepEqual(Object.keys(body.current).sort(), CURRENT_KEYS)
})

test('samples, steps and history are per-request copies, not runtime state references', async () => {
  const status = statusStub()
  const resource = createHistoryResource(fakeRuntime(status))

  const first = await jsonBody(await resource(request('?sessionId=abc')))
  // Mutating the response must not reach the runtime's arrays.
  first.samples.push({ at: 999, tokens: 1, trigger: null, native: null })
  first.samples[0].tokens = -1
  first.steps.push({ at: 999, tokens: 1, trigger: null, native: null, step: 99 })
  first.steps[0].tokens = -1
  first.history.length = 0
  first.history.push({ at: 1 })

  const second = await jsonBody(await resource(request('?sessionId=abc')))
  assert.deepEqual(second.samples, status.samples, 'the second response reflects the untouched runtime state')
  assert.deepEqual(second.steps, status.steps)
  assert.deepEqual(second.history, status.history)
  assert.equal(status.samples[0].tokens, 10_000, 'the underlying sample object is not mutated')
  assert.equal(status.steps[0].tokens, 11_500, 'the underlying step object is not mutated')
  assert.equal(status.history.length, 1)
})

test('an untracked session answers current:null with empty arrays', async () => {
  const runtime = fakeRuntime(null)
  const response = await createHistoryResource(runtime)(request('?sessionId=unknown'))
  assert.equal(response.status, 200)
  const body = await jsonBody(response)
  assert.equal(body.ok, true)
  assert.equal(body.version, 1)
  assert.equal(body.sessionId, 'unknown')
  assert.equal(body.current, null)
  assert.deepEqual(body.samples, [])
  assert.deepEqual(body.steps, [])
  assert.deepEqual(body.history, [])
  assert.deepEqual(runtime.calls, ['unknown'])
})

test('sessionId must match the shared id shape (400 before querying the runtime)', async () => {
  const runtime = fakeRuntime(statusStub())
  const resource = createHistoryResource(runtime)
  for (const query of ['', '?sessionId=', '?sessionId=has%20space', '?sessionId=a%2Fb', `?sessionId=${'x'.repeat(129)}`]) {
    const response = await resource(request(query))
    assert.equal(response.status, 400, query)
    assert.equal((await jsonBody(response)).error, 'invalid sessionId')
  }
  assert.deepEqual(runtime.calls, [])

  assert.equal((await resource(request('?sessionId=abc_123-X'))).status, 200)
})

test('the history endpoint enforces the same-origin guard', async () => {
  const runtime = fakeRuntime(statusStub())
  const resource = createHistoryResource(runtime)

  assert.equal((await resource(request('?sessionId=abc', { host: 'example.test', origin: 'http://example.test' }))).status, 200)
  assert.equal((await resource(request('?sessionId=abc', { host: 'example.test' }))).status, 200)
  for (const origin of ['https://evil.test', 'not a url']) {
    const response = await resource(request('?sessionId=abc', { host: 'example.test', origin }))
    assert.equal(response.status, 403, origin)
    assert.equal((await jsonBody(response)).error, 'forbidden')
  }
})

test('a throwing statusFor reports 500 instead of crashing', async () => {
  const runtime = fakeRuntime(() => {
    throw new Error('boom')
  })
  const response = await createHistoryResource(runtime)(request('?sessionId=abc'))
  assert.equal(response.status, 500)
  assert.equal((await jsonBody(response)).error, 'history unavailable')
})

test('malformed samples/steps/history on the status collapse to empty arrays', async () => {
  const body = await jsonBody(
    await createHistoryResource(fakeRuntime(statusStub({ samples: null, steps: 'nope', history: 'nope' })))(
      request('?sessionId=abc'),
    ),
  )
  assert.deepEqual(body.samples, [])
  assert.deepEqual(body.steps, [])
  assert.deepEqual(body.history, [])
})

test('apply() registers all three read-only routes and dispose unregisters each', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { logLevel: 'debug' })

  const routes = ctx.webServer.routes
  assert.equal(routes.length, 3)
  assert.deepEqual(routes.map((route) => route.path).sort(), [HISTORY_PATH, LOGS_PATH, VISUAL_STATUS_PATH].sort())
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.resource, 'function')
  }

  const historyRoute = routes.find((route) => route.path === HISTORY_PATH)
  const response = await historyRoute.resource(new Request(`http://example.test${HISTORY_PATH}?sessionId=abc`))
  assert.equal(response.status, 200)
  const body = await jsonBody(response)
  assert.equal(body.current, null, 'the fresh plugin has no tracked session yet')
  assert.deepEqual(body.samples, [])
  assert.deepEqual(body.steps, [])
  assert.deepEqual(body.history, [])

  const entries = ctx.webServer.registered
  assert.ok(entries.every((entry) => entry.disposed === false))
  await ctx.dispose()
  assert.ok(entries.every((entry) => entry.disposed === true), 'all three route disposers must run')
})
