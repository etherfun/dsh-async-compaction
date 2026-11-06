/**
 * Offline tests for the browser half (`client.js`).
 *
 * `client.js` is the settings card the Plugins page mounts under
 * `plugins.bundle.config`: it reads every label from its own locale table and
 * writes the bound row form. The card only owns asynchronous-scheduling
 * options — compaction semantics (retained range, summary model, accepted
 * reduction, model filters), the manual `/compact` lifecycle, and the adaptive
 * prediction internals all belong to the running backend, so those keys must
 * never reappear here.
 *
 * The tests load the file the way the module loader does, then either exercise
 * the exported pure helpers (units conversion, validation, save operations,
 * coverage against `src/config.js` DEFAULTS) or render the card with a minimal
 * hook runtime — no DOM, no browser, no bundle.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULTS } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/** The 13 host keys the card is allowed to own, in card order. */
const CARD_FIELDS = [
  'enabled',
  'triggerMode',
  'applyStrategy',
  'dryRun',
  'fixedThreshold',
  'nativeThreshold',
  'autoAdjustFixedThreshold',
  'minThreshold',
  'maxThreshold',
  'fallbackThreshold',
  'minInterval',
  'minShadowedTokens',
  'hookManualCompact',
]

/** Compaction-semantics keys the plugin no longer owns (backend decides). */
const REMOVED_SEMANTIC = [
  'retainRatio',
  'retainTokens',
  'manualCompactRetainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxSummaryTokens',
  'minReductionRatio',
  'modelAllowlist',
  'modelDenylist',
]

/** Adaptive prediction internals and the manual timeout, now fixed constants. */
const REMOVED_TUNING = [
  'manualCompactTimeoutSeconds',
  'safetyMarginTokens',
  'compressionTimeMultiplier',
  'defaultCompressionSeconds',
  'defaultGrowthTokensPerSecond',
  'burstGrowthFactor',
  'emaAlpha',
  'growthSamplingInterval',
  'growthWindow',
]

/** The removed process-wide concurrency limit: one run per session, fixed. */
const REMOVED_CONCURRENCY = ['maxConcurrent']

/** Diagnostic/restart-only host keys the card never exposes. */
const HOST_ONLY = ['logBufferSize', 'logLevel', 'statusCommand']

const REMOVED_DICT_KEYS = [
  'retainRatioHint',
  'retainTokensHint',
  'manualCompactRetainTokensHint',
  'summarizationProviderHint',
  'summarizationModelHint',
  'maxSummaryTokensHint',
  'minReductionRatioHint',
  'modelAllowlistHint',
  'modelDenylistHint',
  'sectionSummary',
  'listPlaceholder',
  'providerModelPair',
  'safetyMarginTokensHint',
  'compressionTimeMultiplierHint',
  'defaultCompressionSecondsHint',
  'defaultGrowthTokensPerSecondHint',
  'burstGrowthFactorHint',
  'emaAlphaHint',
  'growthSamplingIntervalHint',
  'maxConcurrentHint',
  'growthWindowHint',
  'manualCompactTimeoutSecondsHint',
]

// --- minimal hook runtime ----------------------------------------------------
let hooks = []
let hookIndex = 0
let forceUpdate = false
let effectQueue = []

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const index = hookIndex++
    if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = hooks[index]
    return [
      slot.value,
      (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          forceUpdate = true
        }
      },
    ]
  },
  useEffect(fn, deps) {
    const index = hookIndex++
    const key = `effect:${index}`
    const fingerprint =
      deps === undefined ? 'always' : JSON.stringify(deps, (_key, value) => (typeof value === 'function' ? 'fn' : value))
    const previous = hooks[key]
    if (previous === undefined || previous.fingerprint !== fingerprint) {
      hooks[key] = { fingerprint, cleanup: previous?.cleanup }
      effectQueue.push({ key, fn })
    }
  },
}

/** Run every mounted effect cleanup (an unmount) before starting a new mount. */
function releaseHooks() {
  for (const slot of Object.values(hooks)) {
    if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') {
      const cleanup = slot.cleanup
      slot.cleanup = undefined
      cleanup()
    }
  }
  hooks = []
  effectQueue = []
  hookIndex = 0
  forceUpdate = false
}

/** Expand function components into their elements, like a React render tree. */
function expand(node) {
  if (node === null || node === undefined || node === false) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return node
}

/** Render passes until state settles, like React re-rendering on setState. */
function renderTree(Component, props) {
  let tree
  for (let pass = 0; pass < 12; pass += 1) {
    forceUpdate = false
    hookIndex = 0
    tree = expand(Component(props))
    if (effectQueue.length > 0) {
      const queue = effectQueue.splice(0)
      for (const entry of queue) {
        const slot = hooks[entry.key]
        if (slot !== undefined && typeof slot.cleanup === 'function') {
          const stale = slot.cleanup
          slot.cleanup = undefined
          stale()
        }
        if (slot === undefined || typeof entry.fn !== 'function') continue
        const cleanup = entry.fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      forceUpdate = true
    }
    if (!forceUpdate) break
  }
  return tree
}

// --- module loading ----------------------------------------------------------
const captured = []
globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } }

await import(pathToFileURL(clientPath).href)
assert.equal(captured.length, 1, 'client.js should register exactly one module')

const plugin = captured[0].factory((id) => {
  if (id === 'react') return React
  throw new Error(`the bundle should only require react, not ${id}`)
})

const internals = plugin.__internals

// --- fake host form ----------------------------------------------------------
const clone = (value) => structuredClone(value)
const snapshotOf = (overrides = {}) => ({
  status: 'ready',
  writable: true,
  revision: 1,
  value: clone(DEFAULTS),
  ...overrides,
})

const formState = {
  snapshot: snapshotOf(),
  listeners: new Set(),
  calls: [],
  failNext: false,
}

function resetForm(overrides = {}) {
  formState.snapshot = snapshotOf(overrides)
  formState.listeners.clear()
  formState.calls.length = 0
  formState.failNext = false
}

const form = {
  getSnapshot: () => formState.snapshot,
  subscribe: (fn) => {
    formState.listeners.add(fn)
    return () => formState.listeners.delete(fn)
  },
  mutate: async (operations, expectedRevision) => {
    formState.calls.push({ operations, expectedRevision })
    if (formState.failNext) {
      formState.failNext = false
      return false
    }
    if (expectedRevision !== formState.snapshot.revision) return false
    const value = { ...formState.snapshot.value }
    for (const operation of operations) {
      if (operation.op === 'set' && Array.isArray(operation.path) && operation.path.length === 1) {
        value[operation.path[0]] = operation.value
      }
    }
    formState.snapshot = { ...formState.snapshot, revision: formState.snapshot.revision + 1, value }
    for (const listener of [...formState.listeners]) listener()
    return true
  },
}

// --- apply the plugin to a fake client ctx -----------------------------------
const registered = []
const tabRegistrations = []
const openedTabs = []
const injectCalls = []
let localeNamespace
let localeTable
let servedNamespaces
let activeLanguage = 'en'

const fakeLocale = {
  register: (namespace, table) => {
    localeNamespace = namespace
    localeTable = table
  },
  // A fresh bound translator per call, like the Host's `locale.bind`.
  bind: (_namespace) => (key) => {
    const table = localeTable?.[activeLanguage]
    return typeof table?.[key] === 'string' ? table[key] : `@@MISSING:${key}`
  },
}
const fakeSlots = {
  inject: (_name, fn) => fn(),
  register: (spec, component) => {
    registered.push({ spec, component })
    return { dispose() {} }
  },
}
const fakeSidebar = {
  openTab: (kind) => openedTabs.push(kind),
}
const fakeTabs = {
  register: (spec) => {
    tabRegistrations.push(spec)
    return { dispose() {} }
  },
}

plugin.apply({
  effect: (fn) => fn(),
  locale: fakeLocale,
  configForms: {
    get: () => form,
    whileServed: (namespaces, fn) => {
      servedNamespaces = namespaces
      return fn()
    },
  },
  slots: fakeSlots,
  inject: (services, fn) => {
    injectCalls.push(services)
    fn({ locale: fakeLocale, slots: fakeSlots, sidebarRight: fakeSidebar, sidebarRightTabs: fakeTabs })
  },
})

const Card = registered.find((entry) => entry.spec.name === 'plugins.bundle.config').component

// --- rendering helpers -------------------------------------------------------
function translator(language) {
  const table = localeTable[language]
  return (key) => {
    const value = table?.[key]
    return typeof value === 'string' ? value : `@@MISSING:${key}`
  }
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object') textOf(node.props?.children, out)
  return out
}

const text = (tree) => textOf(tree).join(' ').replace(/\s+/g, ' ').trim()

function elements(root) {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    found.push(node)
    visit(node.props?.children)
  }
  visit(root)
  return found
}

const byId = (tree, id) => elements(tree).find((node) => node.props?.id === id)
const buttonWithText = (tree, label) =>
  elements(tree).find((node) => node.type === 'button' && textOf(node.props?.children).join(' ').trim() === label)

/** Mount a fresh card (fresh hooks) with a fresh form snapshot. */
function mount(language = 'en', overrides = {}) {
  releaseHooks()
  resetForm(overrides)
  const props = { t: translator(language), view: 'page' }
  const tree = renderTree(Card, props)
  return { tree, props, rerender: () => renderTree(Card, props) }
}

/** Mount any component with fresh hooks (used for the composer-dock indicator). */
function mountComponent(Component, props) {
  releaseHooks()
  const tree = renderTree(Component, props)
  return { tree, rerender: () => renderTree(Component, props) }
}

// --- module contract ---------------------------------------------------------
test('registers the settings card, dock indicator and right-sidebar seats', () => {
  assert.equal(captured[0].id, 'dsh-async-compaction')
  assert.equal(internals.NS, 'preCompact')
  assert.equal(internals.SETTINGS_NAMESPACE, 'pre-compact')
  assert.equal(internals.BUNDLE, 'dsh-async-compaction')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])
  assert.equal(localeNamespace, 'preCompact')
  assert.ok(localeTable.en, 'en dictionary')
  assert.ok(localeTable.zh, 'zh dictionary')
  assert.deepEqual(servedNamespaces, ['pre-compact'])
  assert.deepEqual(injectCalls, [['sidebarRight', 'sidebarRightTabs']])

  assert.equal(registered.length, 4)
  const config = registered.find((entry) => entry.spec.name === 'plugins.bundle.config')
  const dock = registered.find((entry) => entry.spec.name === 'conversation.composer.dock')
  const pane = registered.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')
  const opener = registered.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
  assert.ok(config, 'the bundle settings card registration')
  assert.ok(dock, 'the composer-dock indicator registration')
  assert.ok(pane, 'the right-sidebar panel body registration')
  assert.ok(opener, 'the conversation-header opener registration')
  assert.equal(
    registered.filter((entry) => entry.spec.name === 'conversation.view').length,
    0,
    'the old conversation-view tab is gone',
  )

  assert.equal(config.spec.key, 'dsh-async-compaction')
  assert.equal(config.spec.id, 'dsh-async-compaction')
  assert.equal(config.spec.locale, localeNamespace)

  assert.equal(dock.spec.id, 'pre-compact')
  assert.equal(dock.spec.locale, localeNamespace)
  assert.equal(dock.spec.order, 0)
  assert.equal(typeof dock.component, 'function')

  assert.equal(pane.spec.key, internals.TAB_ID)
  assert.equal(typeof pane.component, 'function')

  assert.equal(opener.spec.id, 'pre-compact')
  assert.equal(opener.spec.locale, localeNamespace)
  assert.equal(opener.spec.order, 10)
  assert.equal(typeof opener.component, 'function')

  // The tab type is registered as an extension, with a live title thunk.
  assert.equal(tabRegistrations.length, 1)
  const tab = tabRegistrations[0]
  assert.equal(tab.id, 'dsh-async-compaction/context')
  assert.equal(tab.kind, 'pre-compact')
  assert.equal(tab.priority, 'extension')
  assert.equal(typeof tab.title, 'function')
  assert.equal(tab.title(), 'Pre-compaction')
  activeLanguage = 'zh'
  assert.equal(tab.title(), '预压缩')
  activeLanguage = 'en'

  // The header chip opens the panel and labels itself for assistive tech.
  releaseHooks()
  const openerTree = renderTree(opener.component, { t: translator('en'), sessionId: 's1' })
  const button = elements(openerTree).find((node) => node.type === 'button')
  assert.ok(button, 'the header chip renders a button')
  assert.equal(button.props['aria-label'], 'Open the background pre-compaction panel')
  assert.equal(button.props.title, 'Open the background pre-compaction panel')
  assert.match(text(openerTree), /Pre-compaction/)
  button.props.onClick()
  assert.deepEqual(openedTabs, ['pre-compact'])
})

test('the sidebar feature is skipped when its services are absent', () => {
  const localRegistrations = []
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => () => 'x' },
    configForms: { get: () => form, whileServed: (_namespaces, fn) => fn() },
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec) => {
        localRegistrations.push(spec.name)
        return { dispose() {} }
      },
    },
    // Missing sidebar services: Cordis never runs the callback.
    inject: () => false,
  })
  assert.deepEqual(localRegistrations.sort(), ['conversation.composer.dock', 'plugins.bundle.config'])
})

test('describeIndicator maps every status payload to localized text', () => {
  const en = translator('en')
  const zh = translator('zh')
  const enCases = [
    [null, null, ''],
    [{ ok: true, state: 'idle' }, null, ''],
    [{ ok: true, state: 'working' }, 'working', 'Compacting context in the background…'],
    [{ ok: true, state: 'working', manual: true }, 'working', 'Handling /compact in the background…'],
    [{ ok: true, state: 'ready' }, 'ready', 'Background compaction is ready; waiting to apply…'],
    [{ ok: true, state: 'done', outcome: { manual: false } }, 'done', 'Background compaction complete'],
    [{ ok: true, state: 'done', outcome: { manual: true } }, 'done', 'Manual compaction complete'],
    [
      { ok: true, state: 'failed', failure: { at: 1, code: 'small-reduction' } },
      'failed',
      'Background compaction did not complete; the original context was kept',
    ],
    [{ ok: false, state: 'working' }, null, ''],
    [{ ok: true, state: 'unexpected' }, null, ''],
  ]
  for (const [payload, kind, expected] of enCases) {
    const described = internals.describeIndicator(payload, en)
    assert.equal(described.kind, kind)
    assert.equal(described.text, expected)
  }

  const zhCases = [
    [{ ok: true, state: 'working' }, 'working', '正在后台压缩上下文…'],
    [{ ok: true, state: 'working', manual: true }, 'working', '正在后台处理 /compact…'],
    [{ ok: true, state: 'ready' }, 'ready', '后台压缩已就绪，等待应用…'],
    [{ ok: true, state: 'done' }, 'done', '后台压缩完成'],
    [{ ok: true, state: 'done', outcome: { manual: true } }, 'done', '手动压缩完成'],
    [{ ok: true, state: 'failed' }, 'failed', '后台压缩未完成，已保留原上下文'],
    [{ ok: true, state: 'idle' }, null, ''],
  ]
  for (const [payload, kind, expected] of zhCases) {
    const described = internals.describeIndicator(payload, zh)
    assert.equal(described.kind, kind)
    assert.equal(described.text, expected)
  }

  // Both dictionaries carry every indicator string.
  for (const key of [
    'indicatorWorking',
    'indicatorWorkingManual',
    'indicatorReady',
    'indicatorDone',
    'indicatorDoneManual',
    'indicatorFailed',
  ]) {
    assert.equal(typeof localeTable.en[key], 'string', `en.${key}`)
    assert.equal(typeof localeTable.zh[key], 'string', `zh.${key}`)
  }
})

test('describeViewState maps the five current phases to short localized labels', () => {
  const en = translator('en')
  const zh = translator('zh')
  const cases = [
    [null, 'idle', 'Idle'],
    [{ current: null }, 'idle', 'Idle'],
    [{ current: { phase: 'SNAPSHOTTING' } }, 'working', 'Working'],
    [{ current: { phase: 'COMPRESSING' } }, 'working', 'Working'],
    [{ current: { phase: 'APPLYING' } }, 'working', 'Working'],
    [{ current: { phase: 'READY' } }, 'ready', 'Ready'],
    [{ current: { phase: 'COMPLETED' } }, 'done', 'Done'],
    [{ current: { phase: 'FAILED' } }, 'failed', 'Failed'],
    [{ current: { phase: 'unknown-phase' } }, 'idle', 'Idle'],
  ]
  for (const [payload, kind, label] of cases) {
    const described = internals.describeViewState(payload, en)
    assert.equal(described.kind, kind, JSON.stringify(payload))
    assert.equal(described.text, label)
  }
  const zhCases = [
    [{ current: { phase: 'COMPRESSING' } }, 'working', '进行中'],
    [{ current: { phase: 'READY' } }, 'ready', '已就绪'],
    [{ current: { phase: 'COMPLETED' } }, 'done', '已完成'],
    [{ current: { phase: 'FAILED' } }, 'failed', '失败'],
    [null, 'idle', '空闲'],
  ]
  for (const [payload, kind, label] of zhCases) {
    const described = internals.describeViewState(payload, zh)
    assert.equal(described.kind, kind)
    assert.equal(described.text, label)
  }
})

test('buildChartModel aggregates samples by step and places history markers', () => {
  const payload = {
    ok: true,
    current: {
      phase: 'COMPRESSING',
      contextWindow: 1000000,
      currentTokens: 712340,
      triggerTokens: 700000,
      nativeThresholdTokens: 800000,
      step: 3,
    },
    samples: [
      // Out of order on purpose: step 2 first, then two samples of step 1.
      { at: 100, tokens: 200000, trigger: 700000, native: 800000, step: 2 },
      { at: 200, tokens: 300000, trigger: 700000, native: 800000, step: 1 },
      { at: 300, tokens: 340000, trigger: 700000, native: 800000, step: 1 },
      { at: 400, tokens: 500000, trigger: 700000, native: 800000, step: 3 },
    ],
    history: [
      { step: 2, manual: true },
      { step: 3, manual: false },
      { step: 99, manual: false },
      { step: null, manual: false },
    ],
  }
  const model = internals.buildChartModel(payload, 720, 168)
  assert.equal(model.empty, false)
  assert.equal(model.axis, 'step')
  assert.equal(model.stepUnknown, false)
  assert.equal(model.sampleCount, 4)
  assert.equal(model.eventCount, 4)
  assert.deepEqual(model.steps, [1, 2, 3])
  // The last sample of a step wins, and steps are sorted ascending.
  assert.deepEqual(
    model.points.map((point) => [point.step, point.tokens]),
    [
      [1, 340000],
      [2, 200000],
      [3, 500000],
    ],
  )
  assert.deepEqual(model.plot, { left: 52, right: 706, top: 14, bottom: 140 })
  assert.equal(model.points[0].x, model.plot.left)
  assert.equal(model.points[2].x, model.plot.right)
  assert.ok(Math.abs(model.points[1].x - (model.plot.left + model.plot.right) / 2) < 1e-9)
  for (const point of model.points) {
    assert.ok(point.x >= model.plot.left && point.x <= model.plot.right)
    assert.ok(point.y >= model.plot.top && point.y <= model.plot.bottom)
  }
  // y follows the aggregated token counts: 500K is highest on screen, 200K lowest.
  assert.ok(model.points[2].y < model.points[0].y && model.points[0].y < model.points[1].y)

  const ratio = (value) => (model.plot.bottom - value) / (model.plot.bottom - model.plot.top)
  assert.ok(Math.abs(ratio(model.points[0].y) - 340000 / model.maxY) < 1e-9)
  assert.ok(Math.abs(ratio(model.points[1].y) - 200000 / model.maxY) < 1e-9)
  assert.ok(Math.abs(ratio(model.points[2].y) - 500000 / model.maxY) < 1e-9)
  assert.ok(Math.abs(ratio(model.threshold.triggerY) - 700000 / model.maxY) < 1e-9)
  assert.ok(Math.abs(ratio(model.threshold.nativeY) - 800000 / model.maxY) < 1e-9)
  assert.ok(model.threshold.triggerY > model.threshold.nativeY, 'trigger sits below native')
  assert.deepEqual(model.yTicks.map((tick) => tick.kind), ['zero', 'trigger', 'native'])

  // Only history entries matching a step on the axis become markers.
  assert.deepEqual(model.markers.map((marker) => [marker.step, marker.kind]), [[2, 'manual'], [3, 'auto']])
  for (const marker of model.markers) {
    const point = model.points.find((candidate) => candidate.step === marker.step)
    assert.equal(marker.x, point.x)
  }
  assert.deepEqual(model.ticks.map((tick) => [tick.kind, tick.step]), [['step', 1], ['step', 2], ['step', 3]])
  assert.equal(internals.chartTickLabel(model.ticks[0], translator('en')), 'Step 1')
  assert.equal(internals.chartTickLabel(model.ticks[0], translator('zh')), '步 1')
  assert.match(model.linePath, /^M .* L /)
  assert.match(model.areaPath, /Z$/)
})

test('buildChartModel prefers the Host step series and renders every step', () => {
  const steps = Array.from({ length: 10 }, (_, index) => ({
    at: 1000 + index * 1000,
    tokens: 100000 + index * 20000,
    trigger: 700000,
    native: 800000,
    step: index + 1,
  }))
  const payload = {
    ok: true,
    current: { triggerTokens: 700000, nativeThresholdTokens: 800000, step: 10 },
    // A busy raw buffer that only covers three steps: the chart must still show
    // all ten steps because `steps` is the primary series.
    samples: [
      { at: 1000, tokens: 100000, step: 1 },
      { at: 5000, tokens: 140000, step: 5 },
      { at: 10000, tokens: 300000, step: 10 },
    ],
    steps,
    history: [
      { step: 4, manual: true },
      { step: 10, manual: false },
      { step: 77, manual: false },
    ],
  }
  const model = internals.buildChartModel(payload, 720, 168)
  assert.equal(model.empty, false)
  assert.equal(model.axis, 'step')
  assert.equal(model.stepUnknown, false)
  assert.deepEqual(model.steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(model.points.length, 10)
  assert.equal(model.stepCount, 10)
  for (let index = 1; index < model.points.length; index += 1) {
    assert.ok(model.points[index].x > model.points[index - 1].x, 'x is monotonic across steps')
  }
  for (const point of model.points) assert.ok(point.x >= model.plot.left && point.x <= model.plot.right)
  assert.equal(model.ticks.length, 6)
  assert.equal(model.ticks[0].step, 1)
  assert.equal(model.ticks[5].step, 10)
  assert.equal(model.ticks[0].x, model.plot.left)
  assert.equal(model.ticks[5].x, model.plot.right)
  assert.deepEqual(model.markers.map((marker) => [marker.step, marker.kind]), [[4, 'manual'], [10, 'auto']])

  // The Host upserts per step; a duplicate must still collapse to the last entry.
  const deduped = internals.buildChartModel({
    ok: true,
    steps: [
      { tokens: 100, step: 1 },
      { tokens: 200, step: 2 },
      { tokens: 300, step: 1 },
    ],
  })
  assert.deepEqual(deduped.steps, [1, 2])
  assert.deepEqual(
    deduped.points.map((point) => [point.step, point.tokens]),
    [
      [1, 300],
      [2, 200],
    ],
  )

  // An empty `steps` array falls back to the legacy sample-derived axis.
  const fallback = internals.buildChartModel({
    ok: true,
    steps: [],
    samples: [
      { tokens: 100, step: 3 },
      { tokens: 200, step: 1 },
    ],
  })
  assert.deepEqual(fallback.steps, [1, 3])
})

test('buildChartModel caps the step ticks at six and keeps both ends', () => {
  const samples = Array.from({ length: 12 }, (_, index) => ({ at: index, tokens: 1000 * (index + 1), step: index + 1 }))
  const model = internals.buildChartModel({ ok: true, samples })
  assert.equal(model.points.length, 12)
  assert.equal(model.ticks.length, 6)
  assert.equal(model.ticks[0].step, 1)
  assert.equal(model.ticks[5].step, 12)
  assert.equal(model.ticks[0].x, model.plot.left)
  assert.equal(model.ticks[5].x, model.plot.right)
  for (const tick of model.ticks) assert.ok(tick.x >= model.plot.left && tick.x <= model.plot.right)
})

test('buildChartModel falls back to sample order when no step is known', () => {
  const empty = internals.buildChartModel(null)
  assert.equal(empty.empty, true)
  assert.equal(empty.axis, 'step')
  assert.deepEqual(empty.points, [])
  assert.equal(empty.linePath, '')
  assert.equal(empty.areaPath, '')
  assert.equal(empty.markers.length, 0)
  assert.equal(empty.ticks.length, 0)
  assert.equal(empty.yTicks.length, 1)
  assert.equal(empty.yTicks[0].kind, 'zero')

  const onlyCurrent = internals.buildChartModel({
    ok: true,
    current: { triggerTokens: 700000, nativeThresholdTokens: 800000 },
    samples: [],
    history: [{ step: 3 }],
  })
  assert.equal(onlyCurrent.empty, true)
  assert.equal(onlyCurrent.threshold.trigger, 700000)
  assert.equal(onlyCurrent.eventCount, 1)

  // No sample carries a step → sample-order axis, reported as unknown.
  const fallback = internals.buildChartModel({
    ok: true,
    samples: [
      { at: 1, tokens: 100, step: null },
      { at: 2, tokens: 200 },
      { at: 3, tokens: 150, step: 'nope' },
    ],
    history: [{ step: 1, manual: true }],
  })
  assert.equal(fallback.empty, false)
  assert.equal(fallback.axis, 'index')
  assert.equal(fallback.stepUnknown, true)
  assert.deepEqual(fallback.steps, [])
  assert.deepEqual(
    fallback.points.map((point) => [point.kind, point.index, point.step]),
    [
      ['index', 0, null],
      ['index', 1, null],
      ['index', 2, null],
    ],
  )
  assert.deepEqual(fallback.ticks.map((tick) => tick.kind), ['index', 'index', 'index'])
  assert.equal(fallback.markers.length, 0, 'step-less samples cannot anchor a marker')
  assert.equal(fallback.points[0].x, fallback.plot.left)
  assert.equal(fallback.points[2].x, fallback.plot.right)

  // A mixed series keeps real steps and puts null-step samples in one unknown category.
  const mixed = internals.buildChartModel({
    ok: true,
    samples: [
      { at: 1, tokens: 100, step: null },
      { at: 2, tokens: 200, step: 1 },
      { at: 3, tokens: 300, step: null },
    ],
  })
  assert.equal(mixed.axis, 'step')
  assert.deepEqual(mixed.steps, [1])
  assert.deepEqual(
    mixed.points.map((point) => [point.kind, point.step, point.tokens]),
    [
      ['unknown', null, 300],
      ['step', 1, 200],
    ],
  )
  assert.deepEqual(mixed.ticks.map((tick) => tick.kind), ['unknown', 'step'])
  assert.equal(internals.chartTickLabel(mixed.ticks[0], translator('en')), 'Unknown step')
  assert.equal(internals.chartTickLabel(mixed.ticks[1], translator('en')), 'Step 1')
  assert.equal(internals.chartTickLabel({ kind: 'index', index: 2 }, translator('en')), '#3')

  // A single step collapses to one centered point.
  const singleStep = internals.buildChartModel({
    ok: true,
    samples: [
      { step: 5, tokens: 100 },
      { step: 5, tokens: 200 },
    ],
  })
  assert.equal(singleStep.points.length, 1)
  assert.equal(singleStep.points[0].x, (singleStep.plot.left + singleStep.plot.right) / 2)
  assert.equal(singleStep.areaPath, '')
  assert.equal(singleStep.ticks.length, 1)
})

test('buildStats aggregates saved time, averages, freed tokens and trigger distance', () => {
  const empty = { compactions: 0, savedMs: null, averageMs: null, freedTokens: null, toTrigger: null }
  assert.deepEqual(internals.buildStats(null), empty)
  assert.deepEqual(internals.buildStats({ history: [] }), empty)
  assert.deepEqual(internals.buildStats({ history: [{}, { durationMs: 'nope' }] }), { ...empty, compactions: 2 })

  const stats = internals.buildStats({
    current: { triggerTokens: 700000, currentTokens: 712340 },
    history: [
      { durationMs: 51200, shadowedTokens: 18000, framedTokens: 2400 },
      { durationMs: 33000, shadowedTokens: 26000, framedTokens: 41000 },
      { durationMs: 10000, shadowedTokens: 5000, framedTokens: 5000 },
      { durationMs: 'bad', shadowedTokens: 1000, framedTokens: 2000 },
    ],
  })
  assert.equal(stats.compactions, 4)
  assert.equal(stats.savedMs, 94200)
  assert.equal(stats.averageMs, 94200 / 3)
  // Freed tokens never go negative, and malformed durations are simply skipped.
  assert.equal(stats.freedTokens, 15600)
  assert.equal(stats.toTrigger, -12340)

  const positive = internals.buildStats({ current: { triggerTokens: 700000, currentTokens: 650000 } })
  assert.equal(positive.toTrigger, 50000)
  assert.equal(positive.savedMs, null)
  assert.equal(positive.averageMs, null)
  assert.equal(positive.freedTokens, null)

  // The chips and the saved-time column format like this.
  assert.equal(internals.formatDuration(12300), '12.3s')
  assert.equal(internals.formatDuration(125000), '2m 05s')
  assert.equal(internals.formatDuration(51200), '51.2s')
  assert.equal(internals.formatDuration(500), '500ms')
})

// --- locale completeness -----------------------------------------------------
test('every string the card renders has an en and a zh translation', () => {
  const required = new Set(internals.COMMON_KEYS)
  for (const [key, spec] of Object.entries(internals.FIELD_SPECS)) {
    required.add(key)
    if (spec.hintKey !== undefined) required.add(spec.hintKey)
    for (const option of spec.options ?? []) required.add(option.labelKey)
  }
  for (const section of internals.SECTIONS) {
    required.add(section.titleKey)
    if (section.hintKey !== undefined) required.add(section.hintKey)
  }
  const enKeys = Object.keys(localeTable.en).sort()
  const zhKeys = Object.keys(localeTable.zh).sort()
  assert.deepEqual(enKeys, zhKeys, 'en and zh must contain the same keys')
  assert.deepEqual(enKeys, [...required].sort(), 'the dictionary must hold exactly the keys the card renders')
})

// --- scope: scheduling knobs only -------------------------------------------
test('the card owns exactly the scheduling keys and no fixed internals', () => {
  const cardKeys = Object.keys(internals.FIELD_SPECS).sort()
  assert.deepEqual(cardKeys, [...CARD_FIELDS].sort(), 'the card field set is fixed')
  assert.deepEqual(Object.keys(internals.DEFAULT_DRAFT).sort(), cardKeys)

  const hostKeys = Object.keys(DEFAULTS).sort()
  assert.equal(hostKeys.length, 16, 'the host configuration has 16 keys')
  assert.deepEqual(
    hostKeys.filter((key) => !cardKeys.includes(key)),
    [...HOST_ONLY].sort(),
    'only the diagnostics/registration keys stay out of the card',
  )
  for (const key of HOST_ONLY) {
    assert.equal(key in internals.FIELD_SPECS, false, `${key} must not be a card field`)
    assert.equal(key in internals.DEFAULT_DRAFT, false, `${key} must not be a card default`)
    assert.equal(key in localeTable.en, false, `${key} must not be a rendered en key`)
    assert.equal(key in localeTable.zh, false, `${key} must not be a rendered zh key`)
  }
  assert.equal('logBufferSize' in internals.FIELD_SPECS, false)

  for (const key of [...REMOVED_SEMANTIC, ...REMOVED_TUNING, ...REMOVED_CONCURRENCY]) {
    assert.equal(key in internals.FIELD_SPECS, false, `${key} must not be a card field`)
    assert.equal(key in internals.DEFAULT_DRAFT, false, `${key} must not be a card default`)
    assert.equal(key in localeTable.en, false, `${key} must not have an en label`)
    assert.equal(key in localeTable.zh, false, `${key} must not have a zh label`)
  }
  for (const key of REMOVED_DICT_KEYS) {
    assert.equal(key in localeTable.en, false, `${key} must be gone from en`)
    assert.equal(key in localeTable.zh, false, `${key} must be gone from zh`)
  }
  for (const spec of Object.values(internals.FIELD_SPECS)) {
    assert.notEqual(spec.kind, 'list', 'the comma-separated list field type is gone')
  }

  const sections = new Map(internals.SECTIONS.map((section) => [section.id, section]))
  assert.deepEqual(sections.get('adaptive').fields, ['minThreshold', 'maxThreshold', 'fallbackThreshold'])
  assert.deepEqual(sections.get('manual').fields, ['hookManualCompact'])
  assert.deepEqual(sections.get('schedule').fields, ['minInterval', 'minShadowedTokens'])
})

// --- consistency with src/config.js -----------------------------------------
test('the card defaults are the config defaults in the card units', () => {
  assert.deepEqual(internals.DEFAULT_DRAFT, internals.toDraft(DEFAULTS))
  const roundTrip = internals.fromDraft(internals.DEFAULT_DRAFT)
  for (const key of CARD_FIELDS) assert.deepEqual(roundTrip[key], DEFAULTS[key], `${key} should round-trip`)
})

// --- unit conversion ---------------------------------------------------------
test('ratios round-trip through percentages', () => {
  assert.equal(internals.toDraft({ fixedThreshold: 0.7 }).fixedThreshold, 70)
  assert.equal(internals.toDraft({ minThreshold: 0.55 }).minThreshold, 55)
  assert.equal(internals.toDraft({}).fixedThreshold, 70)
  assert.equal(internals.fromDraftValue('fixedThreshold', 70), 0.7)
  assert.equal(internals.fromDraftValue('fallbackThreshold', 65), 0.65)
  assert.equal(internals.fromDraftValue('nativeThreshold', 'auto'), 'auto')
  assert.equal(internals.fromDraftValue('nativeThreshold', 60), 0.6)
  assert.equal(internals.fromDraftValue('minShadowedTokens', 12.6), 13)
})

// --- validation --------------------------------------------------------------
test('validation rejects empty, unparseable, out-of-range and inverted values', () => {
  const base = internals.DEFAULT_DRAFT
  const codes = (draft) =>
    internals
      .validateDraft(draft)
      .map((problem) => `${problem.key}:${problem.code}`)
      .sort()

  assert.deepEqual(internals.validateDraft({ ...base }), [])
  assert.deepEqual(codes({ ...base, fixedThreshold: '' }), ['fixedThreshold:invalidNumber'])
  assert.deepEqual(codes({ ...base, minInterval: 'abc' }), ['minInterval:invalidNumber'])
  assert.deepEqual(codes({ ...base, fixedThreshold: 0.5 }), ['fixedThreshold:invalidRange'])
  assert.deepEqual(codes({ ...base, minInterval: -1 }), ['minInterval:invalidRange'])
  assert.deepEqual(codes({ ...base, minThreshold: 90 }), ['minThreshold:minAboveMax'])
  assert.deepEqual(codes({ ...base, nativeThreshold: '' }), ['nativeThreshold:invalidNumber'])
  assert.deepEqual(codes({ ...base, nativeThreshold: 'auto' }), [])
})

test('validation problem text is localized', () => {
  const en = translator('en')
  const zh = translator('zh')
  assert.match(internals.problemText(en, { key: 'fixedThreshold', code: 'invalidNumber' }), /Fixed threshold \(%\): Enter a number/)
  assert.match(internals.problemText(zh, { key: 'fixedThreshold', code: 'invalidRange', min: 1, max: 100 }), /固定阈值（%）: 超出范围/)
  assert.match(internals.problemText(en, { key: 'minThreshold', code: 'minAboveMax' }), /minimum must not be above/)
})

// --- save operations ---------------------------------------------------------
test('a save submits one set operation per card field in schema units', () => {
  const ops = internals.buildOps({ ...internals.DEFAULT_DRAFT })
  assert.equal(ops.length, 13)
  assert.equal(ops.length, internals.DRAFT_KEYS.length)
  for (const operation of ops) {
    assert.equal(operation.op, 'set')
    assert.equal(operation.path.length, 1)
  }
  const byKey = new Map(ops.map((operation) => [operation.path[0], operation.value]))
  assert.deepEqual([...byKey.keys()].sort(), [...CARD_FIELDS].sort())
  assert.equal(byKey.get('fixedThreshold'), 0.7)
  assert.equal(byKey.get('nativeThreshold'), 'auto')
  assert.equal(byKey.has('logLevel'), false)
  assert.equal(byKey.has('logBufferSize'), false)
  assert.equal(byKey.has('statusCommand'), false)
  assert.equal(byKey.has('maxConcurrent'), false)
  for (const key of [...REMOVED_SEMANTIC, ...REMOVED_TUNING, ...REMOVED_CONCURRENCY, ...HOST_ONLY]) {
    assert.equal(byKey.has(key), false, `${key} must never be written`)
  }
  // Every converted value must satisfy the Host schema's documented ranges.
  for (const [key, spec] of Object.entries(internals.FIELD_SPECS)) {
    const value = byKey.get(key)
    if (spec.kind === 'percent') {
      assert.ok(value > 0 && value <= 1, `${key} should be a (0, 1] ratio, got ${value}`)
    }
    if (spec.kind === 'int') {
      assert.ok(Number.isInteger(value), `${key} should be an integer, got ${value}`)
    }
  }
})

// --- rendering ---------------------------------------------------------------
test('renders every field, label and control in both languages', () => {
  for (const language of ['en', 'zh']) {
    const { tree } = mount(language)
    const content = text(tree)
    assert.equal(content.match(/@@MISSING:[\w.]+/g), null, `missing locale keys in ${language}`)
    for (const key of CARD_FIELDS) {
      assert.ok(content.includes(localeTable[language][key]), `${language} should show the label for ${key}`)
      assert.ok(byId(tree, `pc-${key}`), `${language} should render a control for ${key}`)
    }
    for (const key of [...REMOVED_SEMANTIC, ...REMOVED_TUNING, ...REMOVED_CONCURRENCY, ...HOST_ONLY]) {
      assert.equal(byId(tree, `pc-${key}`), undefined, `${language} must not render ${key}`)
    }
    assert.doesNotMatch(content, /logBufferSize/, `${language} must not mention the log buffer`)
    assert.doesNotMatch(content, /maxConcurrent/, `${language} must not mention the concurrency limit`)
  }
})

test('states the scope boundary and the fixed adaptive/manual semantics', () => {
  const en = text(mount('en').tree)
  assert.match(en, /only decides when compaction runs/)
  assert.match(en, /retained range, summary model and summary quality belong to the active compaction backend/)
  assert.match(en, /\/precompact status/)
  assert.match(en, /Only the clamp window and the no-data fallback are configurable/)
  assert.match(en, /fixed internal defaults/)
  assert.match(en, /follows native semantics/)
  assert.match(en, /this plugin sets no timeout/)
  assert.doesNotMatch(en, /Manual \/compact timeout/)

  const zh = text(mount('zh').tree)
  assert.match(zh, /只接管压缩的时机与异步执行/)
  assert.match(zh, /保留区间、摘要模型与摘要质量由当前压缩后端/)
  assert.match(zh, /\/precompact status/)
  assert.match(zh, /只配置夹取窗口与无数据回退/)
  assert.match(zh, /内部固定默认值/)
  assert.match(zh, /走原生语义/)
  assert.match(zh, /本插件不设超时/)
  assert.doesNotMatch(zh, /手动 \/compact 超时/)
})

test('the inactive mode section is dimmed and disabled', () => {
  const { tree, rerender } = mount('en')
  assert.equal(byId(tree, 'pc-fixedThreshold').props.disabled, false)
  assert.equal(byId(tree, 'pc-minThreshold').props.disabled, true)
  byId(tree, 'pc-triggerMode').props.onChange({ target: { value: 'adaptive' } })
  const next = rerender()
  assert.equal(byId(next, 'pc-fixedThreshold').props.disabled, true)
  assert.equal(byId(next, 'pc-minThreshold').props.disabled, false)
})

test('nativeThreshold switches between auto and a custom percentage', () => {
  const { tree, rerender } = mount('en')
  assert.equal(byId(tree, 'pc-nativeThreshold').props.value, 'auto')
  assert.equal(byId(tree, 'pc-nativeThreshold-value'), undefined)
  byId(tree, 'pc-nativeThreshold').props.onChange({ target: { value: 'custom' } })
  const custom = rerender()
  const customInput = byId(custom, 'pc-nativeThreshold-value')
  assert.ok(customInput, 'a custom threshold shows the number input')
  assert.equal(customInput.props.value, 70)
  customInput.props.onChange({ target: { value: '60' } })
  const edited = rerender()
  const saveButton = buttonWithText(edited, 'Save')
  assert.equal(saveButton.props.disabled, false)
})

test('renders the loading, unavailable, read-only and summary states', () => {
  assert.match(text(mount('en', { status: 'loading' }).tree), /Loading configuration/)
  assert.match(text(mount('en', { status: 'unavailable' }).tree), /does not expose this configuration/)
  assert.match(text(mount('en', { writable: false }).tree), /read-only/)

  releaseHooks()
  const summary = renderTree(Card, { t: translator('en'), view: 'summary' })
  assert.match(text(summary), /Pre-compaction trigger thresholds and asynchronous scheduling/)
})

// --- interactions ------------------------------------------------------------
test('saves the edited draft with the snapshot revision', async () => {
  const { tree, rerender } = mount('en')
  byId(tree, 'pc-fixedThreshold').props.onChange({ target: { value: '80' } })
  let next = rerender()
  const saveButton = buttonWithText(next, 'Save')
  assert.equal(saveButton.props.disabled, false)
  await saveButton.props.onClick()
  next = rerender()

  assert.equal(formState.calls.length, 1)
  const call = formState.calls[0]
  assert.equal(call.expectedRevision, 1)
  assert.equal(call.operations.length, 13)
  const byKey = new Map(call.operations.map((operation) => [operation.path[0], operation.value]))
  assert.equal(byKey.get('fixedThreshold'), 0.8)
  assert.equal(byKey.has('manualCompactTimeoutSeconds'), false)
  assert.equal(byKey.has('emaAlpha'), false)
  assert.equal(formState.snapshot.revision, 2)
  assert.equal(formState.snapshot.value.fixedThreshold, 0.8)
  assert.match(text(next), /Saved/)
  assert.equal(buttonWithText(next, 'Save').props.disabled, true)
})

test('blocks saving while a number is cleared and marks the field', () => {
  const { tree, rerender } = mount('en')
  byId(tree, 'pc-fixedThreshold').props.onChange({ target: { value: '' } })
  const next = rerender()
  assert.match(text(next), /Fixed threshold \(%\): Enter a number/)
  assert.match(text(next), /Fix the highlighted values/)
  assert.equal(buttonWithText(next, 'Save').props.disabled, true)
  assert.equal(formState.calls.length, 0)
})

test('refuses to save when the adaptive minimum is above the maximum', () => {
  const { tree, rerender } = mount('en')
  byId(tree, 'pc-minThreshold').props.onChange({ target: { value: '90' } })
  const next = rerender()
  assert.match(text(next), /adaptive minimum must not be above the maximum/)
  assert.equal(buttonWithText(next, 'Save').props.disabled, true)
  assert.equal(formState.calls.length, 0)
})

test('restore defaults fills the draft and waits for a save', async () => {
  const { tree, rerender } = mount('en', { value: { ...clone(DEFAULTS), fixedThreshold: 0.4 } })
  assert.equal(buttonWithText(tree, 'Save').props.disabled, true, 'the mounted state is clean')
  buttonWithText(tree, 'Restore defaults').props.onClick()
  const next = rerender()
  assert.match(text(next), /Defaults loaded into the draft/)
  assert.equal(formState.calls.length, 0, 'restoring must not write')
  const saveButton = buttonWithText(next, 'Save')
  assert.equal(saveButton.props.disabled, false)
  await saveButton.props.onClick()
  assert.equal(formState.calls[0].operations.length, 13)
  const byKey = new Map(formState.calls[0].operations.map((operation) => [operation.path[0], operation.value]))
  assert.equal(byKey.get('fixedThreshold'), 0.7)
})

test('discard drops the staged edits', () => {
  const { tree, rerender } = mount('en', { value: { ...clone(DEFAULTS), fixedThreshold: 0.4 } })
  byId(tree, 'pc-fixedThreshold').props.onChange({ target: { value: '90' } })
  const edited = rerender()
  assert.equal(buttonWithText(edited, 'Save').props.disabled, false)
  assert.match(text(edited), /Unsaved changes/)
  buttonWithText(edited, 'Discard changes').props.onClick()
  const discarded = rerender()
  assert.equal(byId(discarded, 'pc-fixedThreshold').props.value, 40)
  assert.equal(buttonWithText(discarded, 'Save').props.disabled, true)
  assert.doesNotMatch(text(discarded), /Unsaved changes/)
})

test('reports a failed save', async () => {
  const { tree, rerender } = mount('en', { value: { ...clone(DEFAULTS), fixedThreshold: 0.4 } })
  byId(tree, 'pc-fixedThreshold').props.onChange({ target: { value: '90' } })
  const next = rerender()
  formState.failNext = true
  await buttonWithText(next, 'Save').props.onClick()
  assert.match(text(rerender()), /Could not save the settings/)
})

// --- composer-dock indicator -------------------------------------------------
test('the dock indicator polls the status resource and follows visibility', async () => {
  const Indicator = registered.find((entry) => entry.spec.name === 'conversation.composer.dock').component
  const calls = []
  const intervals = []
  const cleared = []
  const original = {
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    document: globalThis.document,
  }
  const payload = {
    ok: true,
    version: 1,
    state: 'working',
    manual: false,
    enabled: true,
    outcome: null,
    failure: null,
  }
  globalThis.fetch = (url, options) => {
    calls.push({ url: String(url), options })
    return Promise.resolve({ ok: true, json: async () => payload })
  }
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  globalThis.clearInterval = (id) => cleared.push(id)
  globalThis.document = { hidden: false }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  try {
    // No session: nothing to show, no polling at all.
    const empty = mountComponent(Indicator, { sessionId: '', t: translator('en') })
    assert.equal(empty.tree, null)
    assert.equal(calls.length, 0)
    assert.equal(intervals.length, 0)

    const mounted = mountComponent(Indicator, { sessionId: 'session-1', t: translator('en') })
    assert.equal(calls.length, 1, 'polls immediately on mount')
    assert.equal(calls[0].url, '/api/pre-compact/status?sessionId=session-1')
    assert.equal(calls[0].options.method, 'GET')
    assert.equal(calls[0].options.cache, 'no-store')
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.ok(calls[0].options.signal, 'the request carries an AbortSignal')
    assert.equal(intervals.length, 1, 'starts one interval')
    assert.equal(intervals[0].ms, internals.POLL_INTERVAL_MS)
    assert.equal(internals.POLL_INTERVAL_MS, 1200)

    await flush()
    const rendered = mounted.rerender()
    assert.match(text(rendered), /Compacting context in the background/)
    const statusNode = elements(rendered).find((node) => node.props?.role === 'status')
    assert.ok(statusNode, 'renders a role=status element')
    assert.equal(statusNode.props['aria-live'], 'polite')

    // A hidden document keeps the timer but skips the request.
    globalThis.document.hidden = true
    intervals[0].fn()
    await flush()
    assert.equal(calls.length, 1, 'no request while hidden')

    // Visible again: the next tick polls.
    globalThis.document.hidden = false
    intervals[0].fn()
    await flush()
    assert.equal(calls.length, 2, 'polls again when visible')

    // A completed manual run shows the check mark and the manual wording.
    payload.state = 'done'
    payload.outcome = { manual: true }
    intervals[0].fn()
    await flush()
    const doneTree = mounted.rerender()
    assert.match(text(doneTree), /Manual compaction complete/)
    assert.ok(text(doneTree).includes('✓'))

    // Back to idle: the indicator disappears.
    payload.state = 'idle'
    payload.outcome = null
    intervals[0].fn()
    await flush()
    assert.equal(mounted.rerender(), null)
  } finally {
    releaseHooks()
    assert.ok(cleared.length >= 1, 'unmount clears the interval')
    globalThis.fetch = original.fetch
    globalThis.setInterval = original.setInterval
    globalThis.clearInterval = original.clearInterval
    if (original.document === undefined) delete globalThis.document
    else globalThis.document = original.document
  }
})

// --- right-sidebar panel -------------------------------------------------------
test('the sidebar panel polls history, renders the panel and keeps data on failure', async () => {
  const CompactionPanel = registered.find((entry) => entry.spec.name === 'sidebar.right.pane.tab').component
  const calls = []
  const intervals = []
  const cleared = []
  const original = {
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    document: globalThis.document,
  }
  const payload = {
    ok: true,
    version: 1,
    now: 100000,
    sessionId: 'session-1',
    current: {
      enabled: true,
      phase: 'COMPRESSING',
      mode: 'fixed',
      applyStrategy: 'safe',
      currentTokens: 712340,
      contextWindow: 1000000,
      usageRatio: 0.712,
      triggerTokens: 700000,
      triggerRatio: 0.7,
      nativeThresholdTokens: 800000,
      nativeThresholdRatio: 0.8,
      step: 2,
    },
    samples: [
      { at: 40000, tokens: 512000, trigger: 700000, native: 800000, step: 1 },
      { at: 60000, tokens: 640000, trigger: 700000, native: 800000, step: 2 },
      { at: 70000, tokens: 700000, trigger: 700000, native: 800000, step: 2 },
      { at: 80000, tokens: 712340, trigger: 700000, native: 800000, step: 3 },
    ],
    steps: [
      { at: 40000, tokens: 512000, trigger: 700000, native: 800000, step: 1 },
      { at: 70000, tokens: 700000, trigger: 700000, native: 800000, step: 2 },
      { at: 80000, tokens: 712340, trigger: 700000, native: 800000, step: 3 },
    ],
    history: [
      {
        at: 90000,
        step: 2,
        manual: false,
        trigger: 'fixed-threshold',
        shadowedTokens: 18000,
        framedTokens: 2400,
        reduction: 0.867,
        durationMs: 51200,
      },
    ],
  }
  let fail = false
  globalThis.fetch = (url, options) => {
    calls.push({ url: String(url), options })
    if (fail) return Promise.reject(new Error('network down'))
    return Promise.resolve({ ok: true, json: async () => payload })
  }
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  globalThis.clearInterval = (id) => cleared.push(id)
  globalThis.document = { hidden: false }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  try {
    const mounted = mountComponent(CompactionPanel, { sessionId: 'session-1', t: translator('en') })
    assert.equal(calls.length, 1, 'polls immediately on mount')
    assert.equal(calls[0].url, '/api/pre-compact/history?sessionId=session-1')
    assert.equal(calls[0].options.method, 'GET')
    assert.equal(calls[0].options.cache, 'no-store')
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.ok(calls[0].options.signal)
    assert.equal(intervals.length, 1)
    assert.equal(intervals[0].ms, 2500)
    assert.equal(internals.VIEW_POLL_INTERVAL_MS, 2500)

    await flush()
    let tree = mounted.rerender()
    const content = text(tree)
    for (const token of [
      'Background pre-compaction',
      'Working',
      'Fixed',
      'Enabled',
      'Apply strategy: Safe',
      'Now 71%',
      'Trigger 70%',
      'Native 80%',
      'Context usage by step',
      'Step 1',
      'Step 3',
      'Compactions 1',
      'Saved time 51.2s',
      'Avg summary 51.2s',
      'Freed tokens 15.6K',
      'Past trigger',
      'Recent compactions',
      'Step 2',
      'Automatic',
      'fixed-threshold',
      '18K → 2.4K',
      '87%',
      '51.2s',
      '/api/pre-compact/history',
    ]) {
      assert.ok(content.includes(token), `panel should show ${token}`)
    }

    const svg = elements(tree).find((node) => node.type === 'svg')
    assert.ok(svg, 'renders an inline svg chart')
    assert.equal(svg.props.role, 'img')
    assert.equal(svg.props.viewBox, '0 0 720 168')
    assert.match(
      svg.props['aria-label'],
      /Context usage by step: now step 2 at 71%, trigger 70%, native 80%, 1 background compaction, saved ≈ 51.2s/,
    )
    assert.ok(elements(svg).filter((node) => node.type === 'path').length >= 2, 'area and line paths')
    assert.ok(elements(svg).some((node) => node.type === 'circle'), 'history marker drawn')

    // Sidebar layout: full width, no width/height caps, horizontally scrollable table.
    assert.ok(internals.CHART_HEIGHT <= 180, 'the chart viewBox stays compact')
    const panelRoot = elements(tree).find(
      (node) => node.props?.style?.padding === '12px' && node.props?.style?.flexDirection === 'column',
    )
    assert.ok(panelRoot, 'renders the sidebar panel root')
    assert.equal(panelRoot.props.style.width, '100%')
    assert.equal(panelRoot.props.style.minWidth, 0)
    assert.equal(panelRoot.props.style.boxSizing, 'border-box')
    assert.equal(panelRoot.props.style.gap, '12px')
    const chartBox = elements(tree).find(
      (node) => node.props?.style?.borderRadius === '8px' && node.props?.style?.padding === '8px',
    )
    assert.ok(chartBox, 'renders the chart container')
    assert.equal(chartBox.props.style.width, '100%')
    assert.equal(chartBox.props.style.maxWidth, undefined, 'the sidebar chart has no width cap')
    assert.equal(chartBox.props.style.maxHeight, undefined, 'the sidebar chart has no height cap')
    const tableWrap = elements(tree).find((node) => node.props?.style?.overflowX === 'auto')
    assert.ok(tableWrap, 'the history table scrolls horizontally when narrow')

    const headers = elements(tree)
      .filter((node) => node.type === 'th')
      .map((node) => textOf(node.props.children).join(' ').trim())
    assert.ok(headers.includes('Step'), 'the table is ordered by step')
    assert.ok(headers.includes('Saved time'), 'the table has a saved-time column')
    assert.equal(headers.includes('Duration'), false, 'the old duration column is merged away')
    assert.equal(headers.includes('Turn'), false, 'the old turn column is gone')

    // A trigger still ahead renders the distance chip instead of "past trigger".
    const savedCurrentTokens = payload.current.currentTokens
    payload.current.currentTokens = 650000
    assert.match(text(mounted.rerender()), /To trigger 50K/)
    payload.current.currentTokens = savedCurrentTokens

    // A hidden document keeps the timer but skips the request.
    globalThis.document.hidden = true
    intervals[0].fn()
    await flush()
    assert.equal(calls.length, 1, 'no request while hidden')
    globalThis.document.hidden = false
    intervals[0].fn()
    await flush()
    assert.equal(calls.length, 2, 'polls again when visible')

    // Unmonitored session: one empty-state line, no chart/table.
    payload.current = null
    payload.samples = []
    payload.steps = []
    payload.history = []
    intervals[0].fn()
    await flush()
    tree = mounted.rerender()
    assert.match(text(tree), /not monitored yet/)
    assert.equal(elements(tree).find((node) => node.type === 'svg'), undefined)

    // Back to data, then a failed poll keeps the last data and adds the dot.
    payload.current = {
      enabled: true,
      phase: 'READY',
      mode: 'fixed',
      applyStrategy: 'safe',
      currentTokens: 700000,
      contextWindow: 1000000,
      usageRatio: 0.7,
      triggerTokens: 700000,
      triggerRatio: 0.7,
      nativeThresholdTokens: 800000,
      nativeThresholdRatio: 0.8,
      step: 3,
    }
    payload.samples = [
      { at: 40000, tokens: 512000, trigger: 700000, native: 800000, step: 1 },
      { at: 80000, tokens: 700000, trigger: 700000, native: 800000, step: 3 },
    ]
    payload.steps = [
      { at: 40000, tokens: 512000, trigger: 700000, native: 800000, step: 1 },
      { at: 80000, tokens: 700000, trigger: 700000, native: 800000, step: 3 },
    ]
    payload.history = [
      {
        at: 90000,
        step: 3,
        manual: false,
        trigger: 'fixed-threshold',
        shadowedTokens: 18000,
        framedTokens: 2400,
        reduction: 0.867,
        durationMs: 51200,
      },
    ]
    intervals[0].fn()
    await flush()
    tree = mounted.rerender()
    assert.match(text(tree), /Background pre-compaction/)

    fail = true
    intervals[0].fn()
    await flush()
    tree = mounted.rerender()
    const errorDot = elements(tree).find((node) => node.props?.title === 'Status data is temporarily unavailable')
    assert.ok(errorDot, 'renders the silent error dot')
    assert.match(text(tree), /Background pre-compaction/, 'last data stays rendered')
  } finally {
    releaseHooks()
    assert.ok(cleared.length >= 1, 'unmount clears the interval')
    globalThis.fetch = original.fetch
    globalThis.setInterval = original.setInterval
    globalThis.clearInterval = original.clearInterval
    if (original.document === undefined) delete globalThis.document
    else globalThis.document = original.document
  }
})
