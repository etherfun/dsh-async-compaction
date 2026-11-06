/**
 * Read-only debug log endpoint: parameter validation, same-origin guard,
 * response shape and the route registered by `apply()`.
 * @module test/logs-endpoint.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { HISTORY_PATH } from '../src/history-endpoint.js'
import { LOGS_PATH, createLogsResource } from '../src/logs-endpoint.js'
import { VISUAL_STATUS_PATH } from '../src/visual-status.js'
import { FakeCtx } from './fake-harness.js'

const RECORDS = [
  { seq: 1, at: 111, level: 'info', event: 'first', fields: { session: 'abc' } },
  { seq: 2, at: 222, level: 'warn', event: 'second', fields: { session: 'def' } },
]

/** Logger stub recording the options each snapshot call receives. */
function loggerStub(overrides = {}) {
  const calls = []
  return {
    calls,
    snapshot(options = {}) {
      calls.push(options)
      return RECORDS.slice(0, options.limit ?? 100)
    },
    stats() {
      return { capacity: 500, count: RECORDS.length, lastSeq: 2 }
    },
    ...overrides,
  }
}

/** @param {string} query @param {Record<string, string>} [headers] */
function request(query = '', headers = undefined) {
  return new Request(`http://example.test${LOGS_PATH}${query}`, headers === undefined ? undefined : { headers })
}

/** @param {Response} response */
async function jsonBody(response) {
  return JSON.parse(await response.text())
}

test('the logs endpoint returns the newest records with buffer statistics', async () => {
  const logger = loggerStub()
  const response = await createLogsResource(logger)(request())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await jsonBody(response)
  assert.equal(body.ok, true)
  assert.equal(body.version, 1)
  assert.equal(typeof body.now, 'number')
  assert.equal(body.count, RECORDS.length)
  assert.equal(body.capacity, 500)
  assert.equal(body.lastSeq, 2)
  assert.deepEqual(body.records, RECORDS)
  assert.deepEqual(logger.calls, [{ limit: 100 }])
  assert.equal(Object.hasOwn(logger.calls[0], 'level'), false)
})

test('the logs endpoint forwards limit/level/sessionId/sinceSeq to snapshot()', async () => {
  const logger = loggerStub()
  const response = await createLogsResource(logger)(
    request('?limit=2&level=warn&sessionId=abc&sinceSeq=5'),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(logger.calls, [{ limit: 2, level: 'warn', sessionId: 'abc', sinceSeq: 5 }])
})

test('limit is accepted at 1 and 500 and rejected outside the range', async () => {
  const logger = loggerStub()
  const resource = createLogsResource(logger)

  for (const limit of [1, 500]) {
    const response = await resource(request(`?limit=${limit}`))
    assert.equal(response.status, 200, `limit=${limit}`)
    assert.equal(logger.calls.at(-1).limit, limit)
  }

  for (const limit of ['0', '501', '-1', 'abc', '']) {
    const response = await resource(request(`?limit=${limit}`))
    assert.equal(response.status, 400, `limit=${limit}`)
    const body = await jsonBody(response)
    assert.equal(body.ok, false)
    assert.equal(body.error, 'limit must be between 1 and 500')
  }
})

test('level must be one of the four logger levels', async () => {
  const logger = loggerStub()
  const resource = createLogsResource(logger)

  for (const level of ['debug', 'info', 'warn', 'error']) {
    const response = await resource(request(`?level=${level}`))
    assert.equal(response.status, 200, level)
    assert.equal(logger.calls.at(-1).level, level)
  }
  for (const level of ['trace', 'WARN', '']) {
    const response = await resource(request(`?level=${level}`))
    assert.equal(response.status, 400, level)
    assert.equal((await jsonBody(response)).error, 'level must be debug, info, warn or error')
  }
})

test('sessionId must satisfy the shared id shape', async () => {
  const logger = loggerStub()
  const resource = createLogsResource(logger)

  assert.equal((await resource(request('?sessionId=abc_123-X'))).status, 200)
  assert.equal(logger.calls.at(-1).sessionId, 'abc_123-X')

  for (const id of ['', 'has%20space', 'a%2Fb', 'x'.repeat(129)]) {
    const response = await resource(request(`?sessionId=${id}`))
    assert.equal(response.status, 400, id)
    assert.equal((await jsonBody(response)).error, 'invalid sessionId')
  }
})

test('sinceSeq must be a non-negative integer', async () => {
  const logger = loggerStub()
  const resource = createLogsResource(logger)

  assert.equal((await resource(request('?sinceSeq=0'))).status, 200)
  assert.equal(logger.calls.at(-1).sinceSeq, 0)

  // An empty value coerces to 0 (Number('')), which the validator accepts.
  assert.equal((await resource(request('?sinceSeq='))).status, 200)
  assert.equal(logger.calls.at(-1).sinceSeq, 0)

  for (const since of ['-1', '1.5', 'abc']) {
    const response = await resource(request(`?sinceSeq=${since}`))
    assert.equal(response.status, 400, since)
    assert.equal((await jsonBody(response)).error, 'sinceSeq must be a non-negative integer')
  }
})

test('the logs endpoint enforces the same-origin guard', async () => {
  const logger = loggerStub()
  const resource = createLogsResource(logger)

  assert.equal((await resource(request('', { host: 'example.test', origin: 'http://example.test' }))).status, 200)
  assert.equal((await resource(request('', { host: 'example.test' }))).status, 200)
  for (const origin of ['https://evil.test', 'not a url']) {
    const response = await resource(request('', { host: 'example.test', origin }))
    assert.equal(response.status, 403, origin)
    assert.equal((await jsonBody(response)).error, 'forbidden')
  }
})

test('a logger without snapshot reports 500 instead of crashing', async () => {
  const response = await createLogsResource({ stats: () => ({ capacity: 1 }) })(request())
  assert.equal(response.status, 500)
  assert.equal((await jsonBody(response)).error, 'log buffer unavailable')
})

test('a logger without stats still answers with null capacity and lastSeq', async () => {
  const response = await createLogsResource({ snapshot: () => RECORDS })(request())
  assert.equal(response.status, 200)
  const body = await jsonBody(response)
  assert.equal(body.capacity, null)
  assert.equal(body.lastSeq, null)
  assert.deepEqual(body.records, RECORDS)
})

test('apply() registers all read-only routes and dispose unregisters each', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { logLevel: 'debug', logBufferSize: 10 })

  const routes = ctx.webServer.routes
  assert.equal(routes.length, 3)
  assert.deepEqual(routes.map((route) => route.path).sort(), [HISTORY_PATH, LOGS_PATH, VISUAL_STATUS_PATH].sort())
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.resource, 'function')
  }

  // The logs route serves the live buffer through the plugin logger.
  const logsRoute = routes.find((route) => route.path === LOGS_PATH)
  const response = await logsRoute.resource(new Request(`http://example.test${LOGS_PATH}?limit=5`))
  assert.equal(response.status, 200)
  const body = await jsonBody(response)
  assert.equal(body.ok, true)
  assert.ok(body.capacity >= 0)
  assert.ok(Array.isArray(body.records))

  const entries = ctx.webServer.registered
  assert.ok(entries.every((entry) => entry.disposed === false))
  await ctx.dispose()
  assert.ok(entries.every((entry) => entry.disposed === true), 'both route disposers must run')
})
