import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSession, spawnPlugin, preStep, waitForPhase, agentIdle, statusText } from './fake-harness.js'

test('smoke: plugin boots and reaches READY through pre-step', async () => {
  const { ctx } = spawnPlugin({
    triggerMode: 'fixed',
    fixedThreshold: 0.05,
    minInterval: 60_000,    minShadowedTokens: 0,
  })
  const session = ctx.sessions.add(makeSession({ turns: 10, toolPairs: 1, turnOpen: true, extraTokens: 20000 }))
  const agent = ctx.agents.add({ session, status: 'idle', options: { provider: session.provider, model: session.model } })
  assert.equal(ctx.intervals.length, 1)
  await preStep(ctx, agent)
  const text = await waitForPhase(ctx, agent, 'READY')
  assert.match(text, /READY/)
  assert.equal(ctx.compaction.summarizeCalls.length, 1)
  assert.ok(ctx.compaction.summarizeCalls[0].input.messages.length > 2)
  await preStep(ctx, agent)
  const types = session.log.slice(-4).map((event) => event.type)
  assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  const status = await statusText(ctx, agent)
  assert.match(status, /COMPLETED/)
  await agentIdle(ctx, agent)
  await ctx.dispose()
})
