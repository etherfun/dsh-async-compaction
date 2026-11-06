/**
 * Native-policy resolution: reading the mounted backend's global policy, its
 * normalized per-target `modelPolicies`, and following the routed target's own
 * thresholds/retention.
 * @module test/native-policy.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import {
  DEFAULT_NATIVE_HEADROOM,
  DEFAULT_NATIVE_RATIO,
  DEFAULT_NATIVE_RETAIN_RATIO,
  readBackendPolicy,
  resolveNativePolicy,
} from '../src/native-policy.js'
import { FakeCtx, makeSession } from './fake-harness.js'

const CONTEXT_WINDOW = 200_000
const RESERVED = 1024 // FakeSession's request header maxTokens
const MESSAGE_BUDGET = CONTEXT_WINDOW - RESERVED // 198976

/** @param {Record<string, any>} backendConfig */
function backendCtx(backendConfig) {
  return new FakeCtx({ compaction: { config: backendConfig } })
}

/** @param {string} provider @param {string} model */
function routedSession(provider = 'target-provider', model = 'target-model') {
  const session = makeSession({ turns: 0, systemText: null })
  session.setRoute({ provider, model })
  return session
}

/** @param {FakeCtx} ctx @param {any} session @param {Record<string, any>} [configOverrides] */
function resolvePolicy(ctx, session, configOverrides = {}) {
  return resolveNativePolicy({ ctx, session, config: resolveConfig(configOverrides).config, now: 1000 })
}

// ---------------------------------------------------------------------------
// readBackendPolicy
// ---------------------------------------------------------------------------

test('readBackendPolicy normalizes modelPolicies and drops invalid entries/fields', () => {
  const engine = {
    config: {
      thresholdRatio: 0.7,
      headroomTokens: 1234,
      retainRatio: 0.1,
      retainTokens: 500,
      auto: true,
      modelPolicies: [
        { provider: 'a', model: 'b', thresholdRatio: 0.5, headroomTokens: 10, retainRatio: 0.2, retainTokens: 20 },
        // invalid numeric fields are dropped, the entry itself survives
        { provider: 'p', model: 'm', thresholdRatio: 0, headroomTokens: -1, retainRatio: 1, retainTokens: -1 },
        // invalid provider/model are dropped entirely
        null,
        'nope',
        {},
        { provider: '', model: 'm' },
        { provider: 'p', model: '' },
        { provider: 1, model: 'm' },
        { provider: 'p' },
      ],
    },
  }
  const policy = readBackendPolicy(engine)
  assert.ok(policy !== undefined)
  assert.equal(policy.ratio, 0.7)
  assert.equal(policy.headroom, 1234)
  assert.equal(policy.retainRatio, 0.1)
  assert.equal(policy.retainTokens, 500)
  assert.equal(policy.auto, true)
  assert.deepEqual(policy.modelPolicies, [
    { provider: 'a', model: 'b', thresholdRatio: 0.5, headroomTokens: 10, retainRatio: 0.2, retainTokens: 20 },
    { provider: 'p', model: 'm' },
  ])

  // A non-array modelPolicies simply contributes nothing.
  const noList = readBackendPolicy({ config: { thresholdRatio: 0.8, modelPolicies: 'nope' } })
  assert.equal(noList.modelPolicies, undefined)
  // An invalid global ratio still invalidates the whole backend policy.
  assert.equal(readBackendPolicy({ config: { thresholdRatio: 0 } }), undefined)
  assert.equal(readBackendPolicy(undefined), undefined)
})

// ---------------------------------------------------------------------------
// resolveNativePolicy: per-target policy
// ---------------------------------------------------------------------------

test('a matching modelPolicy drives threshold, headroom and retention', async () => {
  const ctx = backendCtx({
    thresholdRatio: 0.7,
    headroomTokens: 1000,
    retainRatio: 0.1,
    retainTokens: 500,
    modelPolicies: [
      {
        provider: 'target-provider',
        model: 'target-model',
        thresholdRatio: 0.5,
        headroomTokens: 2000,
        retainRatio: 0.25,
        retainTokens: 3000,
      },
    ],
  })
  const policy = await resolvePolicy(ctx, routedSession())

  assert.equal(policy.known, true)
  assert.equal(policy.source, 'backend-config')
  assert.equal(policy.thresholdRatio, 0.5)
  assert.equal(policy.headroomTokens, 2000)
  // floor(min(200000*0.5, 198976-2000))
  assert.equal(policy.thresholdTokens, 100_000)
  // the explicit target retainTokens wins over the target retainRatio
  assert.equal(policy.retainTokens, 3000)
  assert.deepEqual(policy.targetPolicy, { provider: 'target-provider', model: 'target-model' })
})

test('without a matching modelPolicy the backend global policy applies', async () => {
  const ctx = backendCtx({
    thresholdRatio: 0.6,
    headroomTokens: 5000,
    retainRatio: 0.1,
    retainTokens: 7000,
    modelPolicies: [{ provider: 'other-provider', model: 'other-model', thresholdRatio: 0.2, retainTokens: 1 }],
  })
  const policy = await resolvePolicy(ctx, routedSession())

  assert.equal(policy.source, 'backend-config')
  assert.equal(policy.thresholdRatio, 0.6)
  assert.equal(policy.headroomTokens, 5000)
  // floor(min(200000*0.6, 198976-5000))
  assert.equal(policy.thresholdTokens, 120_000)
  assert.equal(policy.retainTokens, 7000)
  assert.equal(Object.hasOwn(policy, 'targetPolicy'), false, 'no target policy is reported without a match')
})

test('a target policy with only retainRatio derives retention from the message budget and clamps it', async () => {
  const ctx = backendCtx({
    thresholdRatio: 0.8,
    headroomTokens: 0,
    retainRatio: 0.1,
    // no global retainTokens, so the target's retainRatio is what applies
    retainTokens: undefined,
    modelPolicies: [{ provider: 'target-provider', model: 'target-model', retainRatio: 0.25 }],
  })
  const policy = await resolvePolicy(ctx, routedSession())

  assert.equal(policy.thresholdTokens, 160_000) // global ratio .8, headroom 0
  const expectedRaw = Math.floor(MESSAGE_BUDGET * 0.25)
  const expectedClamp = Math.floor(160_000 * 0.9)
  assert.equal(policy.retainTokens, Math.min(expectedRaw, expectedClamp))
  assert.equal(policy.retainTokens, expectedRaw)
  // The target ratio (0.25) is used, not the backend global ratio (0.1).
  assert.notEqual(policy.retainTokens, Math.floor(MESSAGE_BUDGET * 0.1))
  assert.deepEqual(policy.targetPolicy, { provider: 'target-provider', model: 'target-model' })
})

test('an explicit nativeThreshold override still beats the target policy', async () => {
  const ctx = backendCtx({
    thresholdRatio: 0.7,
    headroomTokens: 1000,
    retainTokens: 500,
    modelPolicies: [
      { provider: 'target-provider', model: 'target-model', thresholdRatio: 0.5, headroomTokens: 2000, retainTokens: 3000 },
    ],
  })
  const policy = await resolvePolicy(ctx, routedSession(), { nativeThreshold: 0.3 })

  assert.equal(policy.source, 'override')
  assert.equal(policy.thresholdRatio, 0.3)
  // An override also forces headroom 0 (the pressure budget is the plain cap).
  assert.equal(policy.headroomTokens, 0)
  assert.equal(policy.thresholdTokens, 60_000) // floor(min(200000*0.3, 198976))
  // Retention still follows the target policy; only the threshold was overridden.
  assert.equal(policy.retainTokens, 3000)
  assert.deepEqual(policy.targetPolicy, { provider: 'target-provider', model: 'target-model' })
})

test('documented fallback defaults are exported and used without a backend policy', async () => {
  assert.equal(DEFAULT_NATIVE_RATIO, 0.8)
  assert.equal(DEFAULT_NATIVE_HEADROOM, 65536)
  assert.equal(DEFAULT_NATIVE_RETAIN_RATIO, 0.16)

  const ctx = new FakeCtx()
  ctx.provide('compaction', undefined)
  const policy = await resolvePolicy(ctx, routedSession())

  assert.equal(policy.source, 'defaults')
  assert.equal(policy.thresholdRatio, DEFAULT_NATIVE_RATIO)
  assert.equal(policy.headroomTokens, DEFAULT_NATIVE_HEADROOM)
  // floor(min(200000*0.8, 198976-65536))
  assert.equal(policy.thresholdTokens, 133_440)
  const expectedRaw = Math.floor(MESSAGE_BUDGET * DEFAULT_NATIVE_RETAIN_RATIO)
  assert.equal(policy.retainTokens, Math.min(expectedRaw, Math.floor(133_440 * 0.9)))
})

test('a target retainRatio beats a global retainTokens, like the backend (REPORT #5 fixed)', async () => {
  const ctx = backendCtx({
    thresholdRatio: 0.8,
    headroomTokens: 0,
    // The backend resolves an exact-model `retainRatio` over this global budget
    // (`resolveTargetPolicy` → `resolveRetention(override, inherited)`).
    retainTokens: 8000,
    modelPolicies: [{ provider: 'target-provider', model: 'target-model', retainRatio: 0.25 }],
  })
  const policy = await resolvePolicy(ctx, routedSession())
  const expected = Math.min(Math.floor(MESSAGE_BUDGET * 0.25), Math.floor(160_000 * 0.9))
  assert.equal(policy.retainTokens, expected)
  assert.equal(policy.retainTokens, 49_744)
})
