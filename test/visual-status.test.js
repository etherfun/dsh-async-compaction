/**
 * Read-only visual status resource the Web UI indicator polls beside the context
 * meter. Covers the payload projection, window edges, and the Fetch resource
 * (validation, same-origin guard, headers) plus route registration.
 * @module test/visual-status.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import {
  DONE_WINDOW_MS,
  FAILED_WINDOW_MS,
  VISUAL_STATUS_PATH,
  buildVisualStatus,
  createStatusResource,
} from '../src/visual-status.js'
import { FakeCtx } from './fake-harness.js'

const NOW = 1_000_000

/** A `runtime.statusFor()` shape with everything idle by default. */
function runtimeStatus(overrides = {}) {
  return {
    sessionId: 'session-abc',
    enabled: true,
    mode: 'fixed',
    applyStrategy: 'safe',
    phase: 'IDLE',
    hasActiveTask: false,
    hasReadyResult: false,
    activeTask: null,
    readyResult: null,
    manualRequest: null,
    lastOutcome: null,
    lastFailure: null,
    ...overrides,
  }
}

/** @param {Record<string, any>} [overrides] */
function build(overrides = {}) {
  return buildVisualStatus(runtimeStatus(overrides), NOW)
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

/** @param {string} url @param {Record<string, string>} [headers] */
function request(url, headers = undefined) {
  return new Request(url, headers === undefined ? undefined : { headers })
}

/** @param {Response} response */
async function jsonBody(response) {
  return JSON.parse(await response.text())
}

// ---------------------------------------------------------------------------
// buildVisualStatus: idle / priority / payload
// ---------------------------------------------------------------------------

test('buildVisualStatus(null) reports idle without outcome or failure', () => {
  const payload = buildVisualStatus(null, NOW)
  assert.deepEqual(payload, {
    ok: true,
    version: 1,
    now: NOW,
    state: 'idle',
    phase: 'IDLE',
    enabled: null,
    manual: false,
    startedAt: null,
    outcome: null,
    failure: null,
  })
})

test('buildVisualStatus exposes exactly the aggregate fields (no content)', () => {
  const payload = build()
  assert.deepEqual(Object.keys(payload).sort(), [
    'enabled',
    'failure',
    'manual',
    'now',
    'ok',
    'outcome',
    'phase',
    'startedAt',
    'state',
    'version',
  ])
  assert.equal(payload.ok, true)
  assert.equal(payload.version, 1)
  assert.equal(payload.now, NOW)
})

test('state priority: working > ready', () => {
  const working = build({
    activeTask: { id: 'task-1', startedAt: NOW - 1234 },
    readyResult: { task: 'task-2' },
  })
  assert.equal(working.state, 'working')
  assert.equal(working.startedAt, NOW - 1234)

  const ready = build({ readyResult: { task: 'task-2' } })
  assert.equal(ready.state, 'ready')
  assert.equal(ready.startedAt, null)

  const activeWithoutStart = build({ activeTask: { id: 'task-1' } })
  assert.equal(activeWithoutStart.state, 'working')
  assert.equal(activeWithoutStart.startedAt, null)
})

test('done state is visible for exactly DONE_WINDOW_MS after a completed outcome', () => {
  assert.equal(DONE_WINDOW_MS, 8000)
  const atEdge = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - DONE_WINDOW_MS, shadowedTokens: 1200, reduction: 0.42 },
  })
  assert.equal(atEdge.state, 'done')

  const justOutside = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - DONE_WINDOW_MS - 1, shadowedTokens: 1200 },
  })
  assert.equal(justOutside.state, 'idle')

  const wellOutside = build({ lastOutcome: { state: 'COMPLETED', at: NOW - 9000 } })
  assert.equal(wellOutside.state, 'idle')
})

test('failed state needs a recent failure newer than the last outcome', () => {
  assert.equal(FAILED_WINDOW_MS, 8000)
  // Recent failure, no outcome at all.
  const failed = build({ lastFailure: { at: NOW - 2000, code: 'commit-failed', message: 'secret', task: 't1' } })
  assert.equal(failed.state, 'failed')
  assert.deepEqual(failed.failure, { at: NOW - 2000, code: 'commit-failed' })

  // Failure window edge.
  assert.equal(build({ lastFailure: { at: NOW - FAILED_WINDOW_MS, code: 'x' } }).state, 'failed')
  assert.equal(build({ lastFailure: { at: NOW - FAILED_WINDOW_MS - 1, code: 'x' } }).state, 'idle')

  // An older completed outcome no longer holds the "done" window; the newer
  // failure takes over.
  const newerFailure = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - 9000 },
    lastFailure: { at: NOW - 3000, code: 'small-reduction' },
  })
  assert.equal(newerFailure.state, 'failed')

  // A failure older than the last outcome is not shown.
  const olderFailure = build({
    lastOutcome: { state: 'STALE', at: NOW - 9000 },
    lastFailure: { at: NOW - 12000, code: 'commit-failed' },
  })
  assert.equal(olderFailure.state, 'idle')

  // A failure newer than the completed outcome wins: "succeeded, then failed"
  // must surface the failure.
  const failureAfterDone = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - 2000 },
    lastFailure: { at: NOW - 1000, code: 'commit-failed' },
  })
  assert.equal(failureAfterDone.state, 'failed')
  assert.equal(failureAfterDone.outcome.state, 'COMPLETED')

  // A failure older than the last completed outcome is hidden by failureIsNewer,
  // so the recent "done" window shows.
  const olderFailureThanDone = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - 2000 },
    lastFailure: { at: NOW - 5000, code: 'commit-failed' },
  })
  assert.equal(olderFailureThanDone.state, 'done')

  // Missing failure code falls back to "failed".
  assert.equal(build({ lastFailure: { at: NOW - 1000 } }).failure.code, 'failed')
})

test('manual is reported from the pending manual request', () => {
  const pending = build({ manualRequest: { id: 'req-1', requestedAt: NOW } })
  assert.equal(pending.manual, true)
  assert.equal(build().manual, false)

  // A completed manual outcome keeps its manual flag inside `outcome`.
  const completed = build({
    lastOutcome: { state: 'COMPLETED', at: NOW - 1000, manual: true, shadowedTokens: 10, reduction: 0.9 },
  })
  assert.equal(completed.state, 'done')
  assert.equal(completed.outcome.manual, true)
})

test('outcome and failure are trimmed to the public aggregate fields', () => {
  const payload = build({
    lastOutcome: {
      state: 'COMPLETED',
      at: NOW - 1000,
      manual: true,
      dryRun: true,
      reduction: 0.5,
      shadowedTokens: 4000,
      // internal fields that must not leak
      message: 'secret summary',
      task: 'task-9',
      compactionId: 'id-secret',
      seqs: { start: 1, end: 2 },
    },
    lastFailure: {
      at: NOW - 500,
      code: 'commit-failed',
      message: 'secret failure',
      detail: { cause: 'boom' },
      task: 'task-9',
    },
  })
  // The newer failure takes priority over the recent completed outcome.
  assert.equal(payload.state, 'failed')
  assert.deepEqual(payload.outcome, {
    state: 'COMPLETED',
    at: NOW - 1000,
    manual: true,
    dryRun: true,
    reduction: 0.5,
    shadowedTokens: 4000,
  })
  assert.deepEqual(payload.failure, { at: NOW - 500, code: 'commit-failed' })

  // Non-number metrics coerce to null rather than leaking raw values.
  const sparse = build({ lastOutcome: { state: 'COMPLETED', at: NOW - 1000 } })
  assert.equal(sparse.outcome.reduction, null)
  assert.equal(sparse.outcome.shadowedTokens, null)
  assert.equal(sparse.outcome.manual, false)
  assert.equal(sparse.outcome.dryRun, false)
})

// ---------------------------------------------------------------------------
// createStatusResource: validation, same-origin, headers
// ---------------------------------------------------------------------------

test('the status resource answers 200 JSON with no-store for a valid session', async () => {
  const runtime = fakeRuntime(runtimeStatus({ phase: 'COMPRESSING', activeTask: { id: 't', startedAt: NOW - 10 } }))
  const resource = createStatusResource(runtime)
  const response = await resource(request(`http://example.test${VISUAL_STATUS_PATH}?sessionId=abc`))

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await jsonBody(response)
  assert.equal(body.ok, true)
  assert.equal(body.state, 'working')
  assert.equal(body.phase, 'COMPRESSING')
  assert.deepEqual(runtime.calls, ['abc'])
})

test('an untracked session still returns the idle payload', async () => {
  const resource = createStatusResource(fakeRuntime(null))
  const response = await resource(request(`http://example.test${VISUAL_STATUS_PATH}?sessionId=abc`))
  assert.equal(response.status, 200)
  const body = await jsonBody(response)
  assert.equal(body.state, 'idle')
  assert.equal(body.outcome, null)
})

test('invalid session ids are rejected with 400 before touching the runtime', async () => {
  const runtime = fakeRuntime(null)
  const resource = createStatusResource(runtime)
  const invalid = [
    `${VISUAL_STATUS_PATH}`, // missing
    `${VISUAL_STATUS_PATH}?sessionId=`,
    `${VISUAL_STATUS_PATH}?sessionId=a%2Fb`, // decoded to a/b
    `${VISUAL_STATUS_PATH}?sessionId=${'x'.repeat(129)}`,
    `${VISUAL_STATUS_PATH}?sessionId=has%20space`,
  ]
  for (const path of invalid) {
    const response = await resource(request(`http://example.test${path}`))
    assert.equal(response.status, 400, path)
    const body = await jsonBody(response)
    assert.equal(body.ok, false)
    assert.equal(body.error, 'invalid sessionId')
  }
  assert.deepEqual(runtime.calls, [], 'invalid requests must not query the runtime')

  // Valid character class and length boundary.
  for (const id of ['abc', 'A-Z_09', 'x'.repeat(128)]) {
    const response = await resource(request(`http://example.test${VISUAL_STATUS_PATH}?sessionId=${id}`))
    assert.equal(response.status, 200, id)
  }
})

test('a cross-origin request is forbidden and a same-origin one is allowed', async () => {
  const runtime = fakeRuntime(null)
  const resource = createStatusResource(runtime)
  const url = `http://example.test${VISUAL_STATUS_PATH}?sessionId=abc`

  const sameOrigin = await resource(request(url, { host: 'example.test', origin: 'http://example.test' }))
  assert.equal(sameOrigin.status, 200)

  for (const origin of ['https://evil.test', 'http://example.test.evil', 'not a url']) {
    const response = await resource(request(url, { host: 'example.test', origin }))
    assert.equal(response.status, 403, origin)
    assert.equal((await jsonBody(response)).error, 'forbidden')
  }

  // No Origin header (same-origin fetch or a non-browser client) is allowed.
  const withoutOrigin = await resource(request(url, { host: 'example.test' }))
  assert.equal(withoutOrigin.status, 200)
})

// ---------------------------------------------------------------------------
// index.js route registration
// ---------------------------------------------------------------------------

test('apply() registers the exact status route and dispose unregisters it', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { logLevel: 'debug' })

  assert.equal(ctx.injections.length, 1)
  assert.deepEqual(ctx.injections[0].names, ['webServer'])
  // The same injection also publishes the debug-logs and session-history endpoints.
  assert.equal(ctx.webServer.registered.length, 3)
  const entry = ctx.webServer.registered.find(
    (candidate) => candidate.definition.path === VISUAL_STATUS_PATH,
  )
  assert.ok(entry !== undefined, 'the status route must be registered')
  assert.equal(entry.definition.kind, 'exact')
  assert.equal(entry.definition.path, '/api/pre-compact/status')
  assert.equal(typeof entry.definition.resource, 'function')

  // The registered resource answers with idle for an untracked session.
  const response = await entry.definition.resource(
    request(`http://example.test${VISUAL_STATUS_PATH}?sessionId=abc`),
  )
  assert.equal(response.status, 200)
  assert.equal((await jsonBody(response)).state, 'idle')

  assert.equal(entry.disposed, false)
  await ctx.dispose()
  assert.equal(entry.disposed, true, 'the route disposer must run on plugin unload')
  assert.ok(ctx.webServer.registered.every((candidate) => candidate.disposed === true))
})

test('a profile without a web server still boots and only logs debug', async () => {
  const ctx = new FakeCtx({ withoutWebServer: true })
  assert.doesNotThrow(() => apply(ctx, { logLevel: 'debug' }))
  assert.equal(ctx.webServer, undefined)
  assert.equal(ctx.injections.length, 1)
  assert.ok(ctx.hasLog('web server unavailable'))
  await ctx.dispose()
})
