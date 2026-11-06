// Ad-hoc contract test for the browser half: capture the module factory, call
// `apply` against a fake client context, and check the four registrations
// (settings card, composer indicator, right-sidebar tab body, header button).
// Usage: node scripts/smoke-client.mjs
let captured
const effects = []
const registrations = []
const locales = []
const tabTypes = []
const opened = []
const injectedServices = []

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment',
}

const formStub = {
  getSnapshot: () => ({ status: 'ready', value: { enabled: true }, revision: 1, writable: true }),
  subscribe: () => () => {},
  mutate: async () => true,
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  locale: {
    register(ns, dict) {
      locales.push({ ns, dict })
      return () => {}
    },
    bind: (ns) => (key) => {
      const dict = locales.find((item) => item.ns === ns)?.dict ?? {}
      return dict.zh?.[key] ?? key
    },
  },
  configForms: {
    get(ns) {
      if (ns !== 'pre-compact') throw new Error(`unexpected settings namespace: ${ns}`)
      return formStub
    },
    whileServed(namespaces, callback) {
      if (!Array.isArray(namespaces) || namespaces[0] !== 'pre-compact') throw new Error('unexpected whileServed namespaces')
      return callback()
    },
  },
  slots: {
    inject(key, callback) {
      const expected = new Set([
        'plugins.bundle.config',
        'conversation.composer.dock',
        'sidebar.right.pane.tab',
        'conversation.session.header.utilities',
      ])
      if (!expected.has(key)) throw new Error(`unexpected inject key: ${key}`)
      return callback()
    },
    register(definition, component) {
      registrations.push({ definition, component })
      return () => {}
    },
  },
  inject(services, callback) {
    injectedServices.push(services)
    const child = {
      ...ctx,
      sidebarRightTabs: {
        register(definition) {
          tabTypes.push(definition)
          return () => {}
        },
      },
      sidebarRight: {
        openTab(kind) {
          opened.push(kind)
        },
      },
    }
    return callback(child)
  },
}

await import('../client.js')
if (captured === undefined) {
  console.error('FAILED: client.js did not call window.__ModuleLoader__.load')
  process.exit(1)
}
console.log('module id:', captured.id)
const mod = captured.factory((specifier) => {
  if (specifier === 'react') return ReactStub
  throw new Error(`unexpected require: ${specifier}`)
})
console.log('inject:', mod.inject.join(','))
if (mod.inject.join(',') !== 'slots,locale,configForms') {
  console.error('FAILED: unexpected top-level inject list')
  process.exit(1)
}
mod.apply(ctx)
const byName = (name) => registrations.filter((item) => item.definition?.name === name)
const entry = byName('plugins.bundle.config')[0]
const dock = byName('conversation.composer.dock')[0]
const body = byName('sidebar.right.pane.tab')[0]
const button = byName('conversation.session.header.utilities')[0]
const tab = tabTypes[0]
const view = byName('conversation.view')[0]
console.log('registered slots:', registrations.map((item) => item.definition?.name).join(', '))
console.log('config slot key:', entry?.definition?.key, '| locale:', entry?.definition?.locale)
console.log('dock slot id:', dock?.definition?.id, '| order:', dock?.definition?.order)
console.log('tab type:', tab?.id, '| kind:', tab?.kind, '| priority:', tab?.priority, '| title:', tab?.title?.())
console.log('tab body key:', body?.definition?.key)
console.log('header button id/order:', button?.definition?.id, button?.definition?.order)
console.log('injected services:', injectedServices.map((list) => list.join('+')).join(','))
console.log('locale namespaces:', locales.map((item) => item.ns).join(','))
let buttonElement = typeof button?.component === 'function' ? button.component({ t: (key) => key, sessionId: 's' }) : null
if (buttonElement !== null && typeof buttonElement.type === 'function') {
  buttonElement = buttonElement.type(buttonElement.props)
}
const onClick = buttonElement?.props?.onClick
if (typeof onClick === 'function') onClick()
const dict = locales[0]?.dict
const dictOk = dict !== undefined && typeof dict.en === 'object' && typeof dict.zh === 'object'
const ok =
  captured.id === 'dsh-async-compaction' &&
  registrations.length === 4 &&
  entry?.definition?.name === 'plugins.bundle.config' &&
  entry?.definition?.key === 'dsh-async-compaction' &&
  entry?.definition?.locale === 'preCompact' &&
  typeof entry?.component === 'function' &&
  dock?.definition?.id === 'pre-compact' &&
  dock?.definition?.order === 0 &&
  typeof dock?.component === 'function' &&
  tab?.id === 'dsh-async-compaction/context' &&
  tab?.kind === 'pre-compact' &&
  tab?.priority === 'extension' &&
  typeof tab?.title === 'function' &&
  typeof tab.title() === 'string' &&
  body?.definition?.name === 'sidebar.right.pane.tab' &&
  body?.definition?.key === 'dsh-async-compaction/context' &&
  typeof body?.component === 'function' &&
  button?.definition?.name === 'conversation.session.header.utilities' &&
  button?.definition?.id === 'pre-compact' &&
  button?.definition?.locale === 'preCompact' &&
  typeof button?.component === 'function' &&
  view === undefined &&
  opened.includes('pre-compact') &&
  injectedServices.length === 1 &&
  injectedServices[0].join(',') === 'sidebarRight,sidebarRightTabs' &&
  dictOk &&
  locales[0]?.ns === 'preCompact'
if (!ok) {
  console.error('FAILED: browser half contract mismatch')
  process.exit(1)
}
const internals = mod.__internals ?? {}
console.log('exposed internals:', Object.keys(internals).join(','))
console.log('CLIENT CONTRACT OK')
process.exit(0)
