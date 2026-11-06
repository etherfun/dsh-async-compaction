/**
 * `/precompact` command surface: registration, subcommands and live control.
 * @module test/command.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commandOf,
  eventsOfType,
  makeAgent,
  makeSession,
  preStep,
  runCommand,
  spawnPlugin,
  statusText,
  waitFor,
  waitForPhase,
} from './fake-harness.js'

const CONFIG = Object.freeze({
  triggerMode: 'fixed',
  fixedThreshold: 0.05,
  minInterval: 0,
  minShadowedTokens: 0,
  logLevel: 'debug',
})

/** @param {Record<string, any>} [overrides] */
function setup(overrides = {}) {
  const { ctx } = spawnPlugin({ ...CONFIG, ...overrides })
  const session = ctx.sessions.add(makeSession({ turns: 8, toolPairs: 1, turnOpen: true, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))
  return { ctx, session, agent }
}

test('the plugin registers /precompact with the host command registry', () => {
  const { ctx } = setup()
  const definitions = ctx.get('commands').list()
  assert.equal(definitions.length, 1)
  const definition = definitions[0]
  assert.equal(definition.name, 'precompact')
  assert.equal(definition.definitionId, 'dsh-pre-compact/command')
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.handler, 'function')
  ctx.dispose()
})

test('status reports the untracked state before the first event', async () => {
  const { ctx } = setup()
  const result = await runCommand(ctx, 'precompact', { rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /no state for this session yet/)
  await ctx.dispose()
})

test('status renders capacity, thresholds, trigger and phase', async () => {
  const { ctx, agent } = setup()
  await preStep(ctx, agent)
  const text = await waitForPhase(ctx, agent, 'READY')
  assert.match(text, /Background pre-compaction — enabled \(fixed mode, apply=safe\)/)
  assert.match(text, /Context: [\d,]+ \/ 200,000 \([\d.]+%\) over \d+ surface nodes/)
  assert.match(text, /Native threshold: 160,000 \(80%, source=backend-config\)/)
  assert.match(text, /Pre-compaction trigger: 10,000 \(5%; fixed-threshold\)/)
  assert.match(text, /Task state: READY \(ready to apply\)/)
  await ctx.dispose()
})

test('list shows every tracked session with its id', async () => {
  const { ctx, agent } = setup()
  const empty = await runCommand(ctx, 'precompact', { rawInput: 'list' })
  assert.match(empty.text, /No sessions are tracked yet\./)

  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')
  const listed = await runCommand(ctx, 'precompact', { rawInput: 'list' })
  assert.match(listed.text, /Session: /)
  assert.match(listed.text, new RegExp(agent.session.id))
  await ctx.dispose()
})

test('pause stops applying and resume re-enables it', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  const paused = await runCommand(ctx, 'precompact', { rawInput: 'pause' })
  assert.match(paused.text, /paused for this process/)
  assert.match(await statusText(ctx, agent), /paused \(fixed mode/)

  await preStep(ctx, agent)
  assert.equal(eventsOfType(session, 'compaction/end').length, 0)
  assert.match(await statusText(ctx, agent), /Task state: READY/)

  const resumed = await runCommand(ctx, 'precompact', { rawInput: 'resume' })
  assert.match(resumed.text, /resumed/)
  await preStep(ctx, agent)
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

test('dry-run then live: the first boundary is skipped, the next one commits', async () => {
  const { ctx, session, agent } = setup()
  await preStep(ctx, agent)
  await waitForPhase(ctx, agent, 'READY')

  const dry = await runCommand(ctx, 'precompact', { rawInput: 'dry-run' })
  assert.match(dry.text, /Dry-run enabled/)
  const logLength = session.log.length
  await preStep(ctx, agent)
  assert.equal(session.log.length, logLength, 'a dry run must not write events')
  assert.match(await statusText(ctx, agent), /Last result \(dry run\)/)

  const live = await runCommand(ctx, 'precompact', { rawInput: 'live' })
  assert.match(live.text, /Dry-run disabled/)

  // Growth past the anti-thrash floor, then a manual evaluation starts a real task.
  session.extraTokens += 5000
  const now = await runCommand(ctx, 'precompact', { rawInput: 'now', agent })
  assert.equal(now.kind, 'success')
  await waitForPhase(ctx, agent, 'READY')
  await preStep(ctx, agent)
  await waitFor(() => eventsOfType(session, 'compaction/end').length === 1)
  await ctx.dispose()
})

test('now requires an agent session', async () => {
  const { ctx } = setup()
  const result = await runCommand(ctx, 'precompact', { rawInput: 'now' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /requires an agent session/)
  await ctx.dispose()
})

test('an unknown subcommand returns the usage line', async () => {
  const { ctx } = setup()
  const result = await runCommand(ctx, 'precompact', { rawInput: 'frobnicate' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/precompact \[status\|list\|logs \[n\]\|pause\|resume\|dry-run\|live\|now\|compact\]/)
  await ctx.dispose()
})

test('/precompact logs prints the newest buffered records with a JSON hint', async () => {
  const { ctx } = setup()
  const result = await runCommand(ctx, 'precompact', { rawInput: 'logs' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Recent pre-compaction logs \(\d+ of \d+ buffered, capacity 500\):/m)
  assert.match(result.text, /#\d+ \d{2}:\d{2}:\d{2}\.\d{3} [A-Z]+ /, 'each record is #seq time LEVEL event')
  assert.match(result.text, /JSON: GET \/api\/pre-compact\/logs\?limit=…&level=…&sessionId=…&sinceSeq=…/)

  const lines = result.text.split('\n').filter((line) => line.startsWith('#'))
  const headerCount = Number(/\((\d+) of \d+ buffered/.exec(result.text)?.[1] ?? '0')
  assert.ok(headerCount >= 1, 'plugin activity is buffered')
  assert.equal(lines.length, headerCount, 'one line per displayed record')
  assert.ok(headerCount <= 30, 'the default display count is 30')
  await ctx.dispose()
})

test('/precompact logs [n] limits the displayed records', async () => {
  const { ctx } = setup()
  const all = await runCommand(ctx, 'precompact', { rawInput: 'logs' })
  const totalBuffered = Number(/of (\d+) buffered/.exec(all.text)?.[1] ?? '0')

  const limited = await runCommand(ctx, 'precompact', { rawInput: 'logs 5' })
  assert.equal(limited.kind, 'success')
  const shown = Number(/\((\d+) of \d+ buffered/.exec(limited.text)?.[1] ?? '0')
  assert.equal(shown, Math.min(5, totalBuffered))
  assert.match(limited.text, /of \d+ buffered, capacity 500/)
  await ctx.dispose()
})

test('/precompact logs explains an empty buffer (logBufferSize=0)', async () => {
  const { ctx } = setup({ logBufferSize: 0 })
  const result = await runCommand(ctx, 'precompact', { rawInput: 'logs' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No pre-compaction log records are buffered yet/)
  assert.match(result.text, /logBufferSize=0 disables the buffer; logLevel only controls the console/)
  await ctx.dispose()
})

test('statusCommand=false skips registration', () => {
  const { ctx } = setup({ statusCommand: false })
  assert.equal(commandOf(ctx, 'precompact'), undefined)
  assert.deepEqual(ctx.get('commands').list(), [])
  ctx.dispose()
})

test('a profile without a command registry still boots', () => {
  const { ctx } = spawnPlugin({ ...CONFIG }, { withoutCommands: true })
  assert.equal(commandOf(ctx, 'precompact'), undefined)
  // The runtime keeps working without the command surface.
  const session = ctx.sessions.add(makeSession({ turns: 8, toolPairs: 1, turnOpen: true, extraTokens: 20_000 }))
  const agent = ctx.agents.add(makeAgent(session))
  assert.doesNotThrow(() => preStep(ctx, agent))
  ctx.dispose()
})

test('disposal unregisters the command', async () => {
  const { ctx } = setup()
  assert.notEqual(commandOf(ctx, 'precompact'), undefined)
  await ctx.dispose()
  assert.equal(commandOf(ctx, 'precompact'), undefined)
})
