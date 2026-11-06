/**
 * Structured logging: the console line, the in-memory ring buffer, snapshot
 * filtering, field sanitisation and the display formatter.
 * @module test/log.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LOG_BUFFER_SIZE, createLogger, formatFields, sanitizeFields } from '../src/log.js'
import { FakeCtx } from './fake-harness.js'

/** @param {Record<string, any>} [overrides] */
function loggerWith(overrides = {}) {
  const ctx = new FakeCtx()
  const config = { logLevel: 'debug', logBufferSize: 10, ...overrides }
  const log = createLogger(ctx, config)
  return { ctx, config, log }
}

// ---------------------------------------------------------------------------
// ring buffer
// ---------------------------------------------------------------------------

test('the ring buffer keeps the last N records with continuous sequence numbers', () => {
  const { log } = loggerWith({ logBufferSize: 3 })
  for (let index = 0; index < 5; index += 1) log.info(`event-${index}`, { session: 's1', index })

  const records = log.snapshot({ limit: 10 })
  assert.deepEqual(records.map((record) => record.seq), [3, 4, 5])
  assert.deepEqual(records.map((record) => record.event), ['event-2', 'event-3', 'event-4'])
  assert.deepEqual(log.stats(), { capacity: 3, count: 3, lastSeq: 5 })
})

test('logBufferSize=0 disables the buffer and clears what was already recorded', () => {
  const { config, log } = loggerWith({ logBufferSize: 2 })
  log.info('a')
  log.info('b')
  assert.deepEqual(log.stats(), { capacity: 2, count: 2, lastSeq: 2 })

  config.logBufferSize = 0
  log.info('c')
  assert.deepEqual(log.snapshot({ limit: 10 }), [])
  // A disabled buffer does not consume sequence numbers either.
  assert.deepEqual(log.stats(), { capacity: 0, count: 0, lastSeq: 2 })
})

test('a volatile capacity change applies to the next emit and trims the buffer', () => {
  const { config, log } = loggerWith({ logBufferSize: 3 })
  log.info('a')
  log.info('b')
  log.info('c')
  assert.equal(log.snapshot({ limit: 10 }).length, 3)

  config.logBufferSize = 1
  log.info('d')
  assert.deepEqual(log.snapshot({ limit: 10 }).map((record) => record.event), ['d'])
  assert.deepEqual(log.stats(), { capacity: 1, count: 1, lastSeq: 4 })

  // Re-enabling starts recording again.
  config.logBufferSize = 3
  log.info('e')
  assert.deepEqual(log.snapshot({ limit: 10 }).map((record) => record.event), ['d', 'e'])
})

test('the default capacity is 500', () => {
  assert.equal(DEFAULT_LOG_BUFFER_SIZE, 500)
  const ctx = new FakeCtx()
  const log = createLogger(ctx, { logLevel: 'info' })
  assert.equal(log.stats().capacity, DEFAULT_LOG_BUFFER_SIZE)
})

test('the console honours logLevel while the buffer records every level', () => {
  const ctx = new FakeCtx()
  const log = createLogger(ctx, { logLevel: 'error', logBufferSize: 10 })
  log.debug('d')
  log.info('i')
  log.warn('w')
  log.error('e')

  assert.equal(ctx.logs.length, 1, 'only error reaches the console logger')
  assert.match(ctx.logs[0], /^error: \[pre-compact\] e$/)
  const records = log.snapshot({ limit: 10 })
  assert.deepEqual(records.map((record) => record.level), ['debug', 'info', 'warn', 'error'])
  assert.deepEqual(records.map((record) => record.event), ['d', 'i', 'w', 'e'])
})

test('the console line keeps the [pre-compact] message key=value shape', () => {
  const ctx = new FakeCtx()
  const log = createLogger(ctx, { logLevel: 'debug', logBufferSize: 10 })
  log.info('background pre-compaction ready', { session: 'abc', tokens: 12, note: 'has space' })
  assert.equal(ctx.logs.length, 1)
  assert.equal(ctx.logs[0], 'info: [pre-compact] background pre-compaction ready session=abc tokens=12 note="has space"')
})

test('a logger throwing does not disturb the caller', () => {
  const ctx = new FakeCtx()
  ctx.logger.info = () => {
    throw new Error('logger exploded')
  }
  const log = createLogger(ctx, { logLevel: 'debug', logBufferSize: 10 })
  assert.doesNotThrow(() => log.info('still recorded', { session: 's' }))
  assert.equal(log.snapshot().length, 1)
})

// ---------------------------------------------------------------------------
// snapshot filtering
// ---------------------------------------------------------------------------

test('snapshot filters by minimum level', () => {
  const { log } = loggerWith()
  log.debug('d')
  log.info('i')
  log.warn('w')
  log.error('e')

  assert.deepEqual(log.snapshot({ level: 'warn' }).map((record) => record.level), ['warn', 'error'])
  assert.deepEqual(log.snapshot({ level: 'debug' }).map((record) => record.level), ['debug', 'info', 'warn', 'error'])
  // An unknown level means "no minimum" (the default).
  assert.equal(log.snapshot({ level: 'nope' }).length, 4)
})

test('snapshot filters by exact session id', () => {
  const { log } = loggerWith()
  log.info('one', { session: 's1', value: 1 })
  log.info('two', { session: 's2', value: 2 })
  log.info('three', { value: 3 })
  log.info('four', { session: 's10' })

  assert.deepEqual(log.snapshot({ sessionId: 's1' }).map((record) => record.event), ['one'])
  assert.deepEqual(log.snapshot({ sessionId: 's10' }).map((record) => record.event), ['four'])
  assert.deepEqual(log.snapshot({ sessionId: 'missing' }), [])
  assert.equal(log.snapshot().length, 4)
})

test('snapshot applies sinceSeq, returns ascending order and the last N records', () => {
  const { log } = loggerWith({ logBufferSize: 100 })
  for (let index = 1; index <= 6; index += 1) log.info(`event-${index}`)

  assert.deepEqual(log.snapshot({ sinceSeq: 2 }).map((record) => record.seq), [3, 4, 5, 6])
  assert.deepEqual(log.snapshot({ limit: 2 }).map((record) => record.seq), [5, 6])
  assert.deepEqual(log.snapshot({ limit: 3, sinceSeq: 3 }).map((record) => record.seq), [4, 5, 6])
  // limit is clamped to at least 1.
  assert.deepEqual(log.snapshot({ limit: 0 }).map((record) => record.seq), [6])
})

test('snapshot defaults to the newest 100 records', () => {
  const { log } = loggerWith({ logBufferSize: 200 })
  for (let index = 1; index <= 105; index += 1) log.info(`event-${index}`)
  const records = log.snapshot()
  assert.equal(records.length, 100)
  assert.equal(records[0].seq, 6)
  assert.equal(records.at(-1).seq, 105)
})

test('clear() empties the buffer without resetting the sequence counter', () => {
  const { log } = loggerWith()
  log.info('a')
  log.info('b')
  log.clear()
  assert.deepEqual(log.stats(), { capacity: 10, count: 0, lastSeq: 2 })
  log.info('c')
  assert.deepEqual(log.snapshot().map((record) => record.seq), [3])
})

test('records carry exactly seq/at/level/event/fields with sanitized fields', () => {
  const { log } = loggerWith()
  log.warn('test event', {
    session: 's1',
    long: 'a'.repeat(400),
    error: Object.assign(new Error('boom'), { code: 'E_BOOM' }),
  })
  const [record] = log.snapshot()
  assert.deepEqual(Object.keys(record).sort(), ['at', 'event', 'fields', 'level', 'seq'])
  assert.equal(typeof record.at, 'number')
  assert.equal(record.event, 'test event')
  assert.equal(record.level, 'warn')
  assert.equal(record.fields.session, 's1')
  assert.equal(record.fields.long.length, 301)
  assert.ok(record.fields.long.endsWith('…'))
  assert.deepEqual(record.fields.error, { name: 'Error', message: 'boom', code: 'E_BOOM' })
})

// ---------------------------------------------------------------------------
// sanitizeFields
// ---------------------------------------------------------------------------

test('sanitizeFields truncates long strings and long arrays', () => {
  const longString = sanitizeFields({ value: 'x'.repeat(500) }).value
  assert.equal(longString.length, 301)
  assert.equal(longString, `${'x'.repeat(300)}…`)

  const array = sanitizeFields({ list: Array.from({ length: 25 }, (_, index) => index) }).list
  assert.equal(array.length, 21)
  assert.deepEqual(array.slice(-1), ['…5 more'])
})

test('sanitizeFields bounds object depth and marks cycles', () => {
  // Strings are never depth-limited; an object at depth 3 is.
  assert.deepEqual(sanitizeFields({ a: { b: { c: { d: { e: 'deep' } } } } }), {
    a: { b: { c: { d: '[depth]' } } },
  })

  const cyclic = { name: 'root' }
  cyclic.self = cyclic
  assert.deepEqual(sanitizeFields({ cyclic }), { cyclic: { name: 'root', self: '[cyclic]' } })

  // Undefined values disappear from nested objects instead of being recorded.
  assert.deepEqual(sanitizeFields({ nested: { keep: 1, drop: undefined } }), { nested: { keep: 1 } })
})

test('sanitizeFields keeps only the Error name/message/code', () => {
  const error = Object.assign(new TypeError('bad input'), { code: 42, stack: 'secret stack', extra: 'secret' })
  assert.deepEqual(sanitizeFields({ error }), { error: { name: 'TypeError', message: 'bad input', code: 42 } })
  assert.deepEqual(sanitizeFields({ error: new Error('no code') }), { error: { name: 'Error', message: 'no code' } })
})

test('sanitizeFields safely renders bigint/function/symbol and drops undefined', () => {
  const fn = () => 'x'
  const fields = sanitizeFields({
    undef: undefined,
    big: 12n,
    fn,
    sym: Symbol('s'),
    nested: [12n, undefined, () => 1],
  })
  assert.deepEqual(fields, {
    big: '12n',
    fn: '[function]',
    sym: '[symbol]',
    // Array slots are positional: an undefined item stays undefined.
    nested: ['12n', undefined, '[function]'],
  })
  assert.deepEqual(sanitizeFields(null), {})
  assert.deepEqual(sanitizeFields('not-an-object'), {})
  assert.deepEqual(sanitizeFields(undefined), {})
})

// ---------------------------------------------------------------------------
// formatFields
// ---------------------------------------------------------------------------

test('formatFields renders primitives, null, arrays and quoted strings', () => {
  assert.equal(formatFields({ a: 1, b: 'plain' }), 'a=1 b=plain')
  assert.equal(formatFields({ a: 1, b: null, c: [1, 2], d: undefined }), 'a=1 b=null c=[1,2]')
  assert.equal(formatFields({ note: 'has space' }), 'note="has space"')
  assert.equal(formatFields({ expr: 'a=b' }), 'expr="a=b"')
  assert.equal(formatFields({ quote: 'say "hi"' }), 'quote="say \\"hi\\""')
  assert.equal(formatFields({ obj: { a: 1 } }), 'obj=[object Object]')
  assert.equal(formatFields({}), '')
})
