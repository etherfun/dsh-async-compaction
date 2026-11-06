/**
 * Browser half of the pre-compact bundle. It registers three things:
 *
 * 1. A settings card on the bundle page (`plugins.bundle.config`), right under
 *    the package description instead of the row's separate Configure page. The
 *    card binds the row's Host settings namespace (`pre-compact`) through
 *    `ctx.configForms`, so it reads and writes the same document the row form
 *    would, with a staged draft and a revision-fenced save.
 *
 *    The card edits only the asynchronous-scheduling knobs: whether and when a
 *    background pre-compaction runs, plus the fixed/adaptive trigger estimates.
 *    Compaction semantics are deliberately not configurable here — the retained
 *    range, the summary model and the accepted reduction belong to the running
 *    compaction backend (or to another compaction plugin), so this card never
 *    overrides them. `logLevel`, `logBufferSize` and `statusCommand` stay in
 *    `cordis.patch.yml`: they are diagnostics/registration concerns, not card
 *    options.
 *
 *    Every value is a plain JSON value. Ratio fields are edited as percentages
 *    (the schema stores 0–1); token/second fields are edited as non-negative
 *    numbers.
 *
 * 2. A read-only status indicator in `conversation.composer.dock`, next to the
 *    token meter. It polls the Host's `GET /api/pre-compact/status` resource so
 *    a run that has not emitted any compaction event yet (snapshotting or
 *    summarizing) is still visible to the person waiting for it.
 *
 * 3. A right-sidebar tab (`sidebar.right.pane.tab`) with the context gauge, the
 *    per-step usage trend and the recent-compaction table, fed by the Host's
 *    `GET /api/pre-compact/history` resource. A conversation-header chip opens
 *    it. The chart model is a pure function so the geometry can be tested
 *    without a DOM.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-pre-compact',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'preCompact'
    const SETTINGS_NAMESPACE = 'pre-compact'
    const BUNDLE = '@local/dsh-pre-compact'

    /** Host resource the composer-dock indicator polls; the payload is documented below. */
    const STATUS_PATH = '/api/pre-compact/status'
    const POLL_INTERVAL_MS = 1200
    const INDICATOR_STYLE_ID = 'pre-compact-indicator-style'
    const INDICATOR_CSS =
      '@keyframes pre-compact-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}' +
      '@media (prefers-reduced-motion: reduce){.pre-compact-indicator-dot{animation:none !important}}'

    /** Host resource and cadence behind the right-sidebar panel. */
    const HISTORY_PATH = '/api/pre-compact/history'
    const VIEW_POLL_INTERVAL_MS = 2500
    const CHART_WIDTH = 720
    const CHART_HEIGHT = 168
    const CHART_PADDING = Object.freeze({ left: 52, right: 14, top: 14, bottom: 28 })
    const CHART_MAX_TICKS = 6
    const HISTORY_ROWS = 10

    /** Right-sidebar tab type identity: the body, title and opener all use it. */
    const TAB_ID = '@local/dsh-pre-compact/context'
    const TAB_KIND = 'pre-compact'

    /** Existing strategy labels reused by the panel's status chips. */
    const STRATEGY_LABEL_KEYS = Object.freeze({
      safe: 'strategySafe',
      'end-of-turn': 'strategyEndOfTurn',
      'idle-only': 'strategyIdleOnly',
    })

    /**
     * The card's own defaults, in the card's units: ratios are percentages.
     * Mirrors `src/config.js` DEFAULTS for every key the card edits (all except
     * `logLevel`, `logBufferSize` and `statusCommand`). Compaction semantics
     * (retain range, summary model, reduction floor, model filters) are not
     * card fields.
     */
    const DEFAULT_DRAFT = Object.freeze({
      enabled: true,
      triggerMode: 'fixed',
      applyStrategy: 'safe',
      dryRun: false,

      fixedThreshold: 70,
      nativeThreshold: 'auto',
      autoAdjustFixedThreshold: true,

      minThreshold: 50,
      maxThreshold: 75,
      fallbackThreshold: 65,

      minInterval: 60000,
      minShadowedTokens: 1024,

      hookManualCompact: true,
    })

    /** One descriptor per editable field; the card's single source of truth. */
    const FIELD_SPECS = Object.freeze({
      enabled: { kind: 'bool' },
      triggerMode: {
        kind: 'select',
        options: [
          { value: 'fixed', labelKey: 'triggerFixed' },
          { value: 'adaptive', labelKey: 'triggerAdaptive' },
        ],
      },
      applyStrategy: {
        kind: 'select',
        options: [
          { value: 'safe', labelKey: 'strategySafe' },
          { value: 'end-of-turn', labelKey: 'strategyEndOfTurn' },
          { value: 'idle-only', labelKey: 'strategyIdleOnly' },
        ],
      },
      dryRun: { kind: 'bool', hintKey: 'dryRunHint' },

      fixedThreshold: { kind: 'percent', min: 1, max: 100, step: 0.5, hintKey: 'fixedThresholdHint' },
      nativeThreshold: { kind: 'native', min: 1, max: 100, step: 0.5, customDefault: 70, hintKey: 'nativeThresholdHint' },
      autoAdjustFixedThreshold: { kind: 'bool', hintKey: 'autoAdjustFixedThresholdHint' },

      minThreshold: { kind: 'percent', min: 1, max: 100, step: 0.5, hintKey: 'minThresholdHint' },
      maxThreshold: { kind: 'percent', min: 1, max: 100, step: 0.5 },
      fallbackThreshold: { kind: 'percent', min: 1, max: 100, step: 0.5, hintKey: 'fallbackThresholdHint' },

      minInterval: { kind: 'int', min: 0, step: 1, hintKey: 'minIntervalHint' },
      minShadowedTokens: { kind: 'int', min: 0, step: 1, hintKey: 'minShadowedTokensHint' },

      hookManualCompact: { kind: 'bool', hintKey: 'hookManualCompactHint' },
    })

    /** Field keys in card order; also the order of the saved operations. */
    const DRAFT_KEYS = Object.freeze(Object.keys(FIELD_SPECS))

    /** The card's sections; a mode section is active only for its trigger mode. */
    const SECTIONS = Object.freeze([
      { id: 'base', titleKey: 'sectionBase', fields: ['enabled', 'triggerMode', 'applyStrategy', 'dryRun'] },
      {
        id: 'fixed',
        titleKey: 'sectionFixed',
        hintKey: 'sectionFixedHint',
        activeWhen: 'fixed',
        fields: ['fixedThreshold', 'nativeThreshold', 'autoAdjustFixedThreshold'],
      },
      {
        id: 'adaptive',
        titleKey: 'sectionAdaptive',
        hintKey: 'sectionAdaptiveHint',
        activeWhen: 'adaptive',
        fields: ['minThreshold', 'maxThreshold', 'fallbackThreshold'],
      },
      {
        id: 'schedule',
        titleKey: 'sectionSchedule',
        fields: ['minInterval', 'minShadowedTokens'],
      },
      {
        id: 'manual',
        titleKey: 'sectionManual',
        hintKey: 'sectionManualHint',
        fields: ['hookManualCompact'],
      },
    ])

    /** DICT keys the card renders outside the field/section descriptors. */
    const COMMON_KEYS = Object.freeze([
      'summary',
      'scopeHint',
      'statusHint',
      'wrapperNote',
      'save',
      'saving',
      'discard',
      'restoreDefaults',
      'saved',
      'restored',
      'saveFailed',
      'loading',
      'unavailable',
      'readOnly',
      'dirty',
      'fixErrors',
      'invalidNumber',
      'invalidRange',
      'minAboveMax',
      'nativeAuto',
      'nativeCustom',
      'indicatorWorking',
      'indicatorWorkingManual',
      'indicatorReady',
      'indicatorDone',
      'indicatorDoneManual',
      'indicatorFailed',
      'viewLabel',
      'viewTitle',
      'viewLoading',
      'viewEmpty',
      'viewError',
      'viewFooter',
      'viewStateIdle',
      'viewStateWorking',
      'viewStateReady',
      'viewStateDone',
      'viewStateFailed',
      'viewModeFixed',
      'viewModeAdaptive',
      'viewEnabled',
      'viewPaused',
      'viewStrategyLabel',
      'openPanel',
      'gaugeCurrent',
      'gaugeTrigger',
      'gaugeNative',
      'stepLabel',
      'statsCompactions',
      'statsSavedTime',
      'statsSavedTimeHint',
      'statsAvgDuration',
      'statsFreedTokens',
      'statsToTrigger',
      'statsPastTrigger',
      'chartTitle',
      'chartEmpty',
      'chartStepUnknown',
      'chartTrigger',
      'chartNative',
      'kindManual',
      'kindAuto',
      'chartAriaStep',
      'chartAriaNoStep',
      'chartEventsOne',
      'chartEventsMany',
      'historyTitle',
      'historyEmpty',
      'historyStep',
      'historyKind',
      'historyReason',
      'historyTokens',
      'historyReduction',
      'historySavedTime',
    ])

    const DICT = {
      en: {
        summary: 'Pre-compaction trigger thresholds and asynchronous scheduling.',
        scopeHint:
          'This plugin only decides when compaction runs and how it is scheduled asynchronously; the retained range, summary model and summary quality belong to the active compaction backend (or another compaction plugin) and are not changed here.',
        statusHint: 'Runtime state is read with `/precompact status` in chat; this card only edits configuration.',
        wrapperNote: 'Saved values take effect immediately through the Host volatile-config update.',
        sectionBase: 'Basics',
        sectionFixed: 'Fixed mode',
        sectionFixedHint: 'Only used while the trigger mode is “fixed”.',
        sectionAdaptive: 'Adaptive mode',
        sectionAdaptiveHint:
          'Only the clamp window and the no-data fallback are configurable; the growth/duration/burst/EMA/sampling estimates are fixed internal defaults.',
        sectionSchedule: 'Scheduling',
        sectionManual: 'Manual /compact',
        sectionManualHint:
          'A taken-over `/compact` follows native semantics: only the last surface node is kept, and timeout/lifecycle belong to the native compaction backend — this plugin sets no timeout.',
        enabled: 'Enable pre-compaction',
        triggerMode: 'Trigger mode',
        applyStrategy: 'Apply strategy',
        dryRun: 'Dry run (measure only)',
        fixedThreshold: 'Fixed threshold (%)',
        nativeThreshold: 'Native compaction threshold',
        autoAdjustFixedThreshold: 'Auto-adjust the fixed threshold',
        minThreshold: 'Adaptive minimum (%)',
        maxThreshold: 'Adaptive maximum (%)',
        fallbackThreshold: 'Fallback threshold (%)',
        minInterval: 'Minimum interval between attempts (ms)',
        minShadowedTokens: 'Minimum shadowed tokens',
        hookManualCompact: 'Take over the manual /compact path',
        triggerFixed: 'Fixed threshold',
        triggerAdaptive: 'Adaptive',
        strategySafe: 'Safe (apply at a safe point)',
        strategyEndOfTurn: 'End of turn',
        strategyIdleOnly: 'Idle only',
        nativeAuto: 'Follow the native backend',
        nativeCustom: 'Custom percentage',
        indicatorWorking: 'Compacting context in the background…',
        indicatorWorkingManual: 'Handling /compact in the background…',
        indicatorReady: 'Background compaction is ready; waiting to apply…',
        indicatorDone: 'Background compaction complete',
        indicatorDoneManual: 'Manual compaction complete',
        indicatorFailed: 'Background compaction did not complete; the original context was kept',
        viewLabel: 'Pre-compaction',
        viewTitle: 'Background pre-compaction',
        viewLoading: 'Loading compaction data…',
        viewEmpty: 'This session is not monitored yet; it appears after the agent runs a step.',
        viewError: 'Status data is temporarily unavailable',
        viewFooter:
          'Data comes from this plugin’s Host (/api/pre-compact/history); full diagnostics with /precompact status; only since this plugin loaded.',
        viewStateIdle: 'Idle',
        viewStateWorking: 'Working',
        viewStateReady: 'Ready',
        viewStateDone: 'Done',
        viewStateFailed: 'Failed',
        viewModeFixed: 'Fixed',
        viewModeAdaptive: 'Adaptive',
        viewEnabled: 'Enabled',
        viewPaused: 'Paused',
        viewStrategyLabel: 'Apply strategy',
        openPanel: 'Open the background pre-compaction panel',
        gaugeCurrent: 'Now',
        gaugeTrigger: 'Trigger',
        gaugeNative: 'Native',
        stepLabel: 'Step',
        statsCompactions: 'Compactions',
        statsSavedTime: 'Saved time',
        statsSavedTimeHint:
          'Cumulative time the main agent was not blocked while summaries ran in the background; equal to the synchronous wait native compaction would have added.',
        statsAvgDuration: 'Avg summary',
        statsFreedTokens: 'Freed tokens',
        statsToTrigger: 'To trigger',
        statsPastTrigger: 'Past trigger',
        chartTitle: 'Context usage by step',
        chartEmpty: 'No samples yet',
        chartStepUnknown: 'Unknown step',
        chartTrigger: 'Trigger threshold',
        chartNative: 'Native threshold',
        kindManual: 'Manual',
        kindAuto: 'Automatic',
        chartAriaStep:
          'Context usage by step: now step {step} at {percent}, trigger {trigger}, native {native}, {events}, saved ≈ {saved}',
        chartAriaNoStep:
          'Context usage by step: now {percent}, trigger {trigger}, native {native}, {events}, saved ≈ {saved}',
        chartEventsOne: '1 background compaction',
        chartEventsMany: '{count} background compactions',
        historyTitle: 'Recent compactions',
        historyEmpty: 'No compactions recorded yet',
        historyStep: 'Step',
        historyKind: 'Kind',
        historyReason: 'Trigger reason',
        historyTokens: 'Tokens (shadowed → framed)',
        historyReduction: 'Reduction',
        historySavedTime: 'Saved time',
        dryRunHint: 'Summarize and log the expected reduction, but never apply it (one summary request is still spent).',
        fixedThresholdHint: 'Share of the context window that starts pre-compaction.',
        nativeThresholdHint: 'The threshold native compaction uses; auto follows the mounted backend, a percentage overrides it.',
        autoAdjustFixedThresholdHint: 'Pull the fixed trigger below the native threshold when the two would collide.',
        minThresholdHint: 'Percent of the context window; the minimum must not be above the maximum.',
        fallbackThresholdHint: 'Used while there is not enough growth history yet.',
        minIntervalHint: 'Do not start another attempt sooner than this.',
        minShadowedTokensHint:
          'Skip an automatic run when the history it would replace prices below this many tokens. Automatic triggers only; manual /compact ignores it; 0 disables the gate.',
        hookManualCompactHint: 'Summarize manual /compact requests off the critical path too.',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard changes',
        restoreDefaults: 'Restore defaults',
        saved: 'Saved — the Host applies it immediately.',
        restored: 'Defaults loaded into the draft; save to apply them.',
        saveFailed: 'Could not save the settings.',
        loading: 'Loading configuration…',
        unavailable: 'The Host does not expose this configuration right now.',
        readOnly: 'This configuration is read-only.',
        dirty: 'Unsaved changes',
        fixErrors: 'Fix the highlighted values before saving.',
        invalidNumber: 'Enter a number.',
        invalidRange: 'Out of range',
        minAboveMax: 'The adaptive minimum must not be above the maximum.',
      },
      zh: {
        summary: '预压缩的触发阈值与异步调度设置。',
        scopeHint:
          '本插件只接管压缩的时机与异步执行；保留区间、摘要模型与摘要质量由当前压缩后端（或其它压缩插件）决定，这里不改写它们。',
        statusHint: '运行状态请在聊天里用 `/precompact status` 查看；本卡片只修改配置。',
        wrapperNote: '保存后通过宿主的易变配置更新立即生效。',
        sectionBase: '基础',
        sectionFixed: '固定模式',
        sectionFixedHint: '仅在触发模式为「固定」时生效。',
        sectionAdaptive: '自适应模式',
        sectionAdaptiveHint:
          '只配置夹取窗口与无数据回退；预测用的增长/耗时/突发/EMA/采样参数都是内部固定默认值，无需配置。',
        sectionSchedule: '调度',
        sectionManual: '手动 /compact',
        sectionManualHint:
          '被接管的 `/compact` 走原生语义：只保留最后一个 surface 节点，超时与生命周期由原生压缩后端负责，本插件不设超时。',
        enabled: '启用后台预压缩',
        triggerMode: '触发模式',
        applyStrategy: '应用策略',
        dryRun: '演练模式（只测算）',
        fixedThreshold: '固定阈值（%）',
        nativeThreshold: '原生压缩阈值',
        autoAdjustFixedThreshold: '自动微调固定阈值',
        minThreshold: '自适应下限（%）',
        maxThreshold: '自适应上限（%）',
        fallbackThreshold: '回退阈值（%）',
        minInterval: '两次尝试的最小间隔（ms）',
        minShadowedTokens: '最小被遮蔽 tokens',
        hookManualCompact: '接管手动 /compact',
        triggerFixed: '固定阈值',
        triggerAdaptive: '自适应',
        strategySafe: '安全（在安全时机应用）',
        strategyEndOfTurn: '回合结束时',
        strategyIdleOnly: '仅空闲时',
        nativeAuto: '跟随原生后端',
        nativeCustom: '自定义百分比',
        indicatorWorking: '正在后台压缩上下文…',
        indicatorWorkingManual: '正在后台处理 /compact…',
        indicatorReady: '后台压缩已就绪，等待应用…',
        indicatorDone: '后台压缩完成',
        indicatorDoneManual: '手动压缩完成',
        indicatorFailed: '后台压缩未完成，已保留原上下文',
        viewLabel: '预压缩',
        viewTitle: '后台预压缩',
        viewLoading: '正在读取压缩数据…',
        viewEmpty: '本会话尚未被监控；Agent 运行一个 step 后才会出现数据。',
        viewError: '状态数据暂时不可用',
        viewFooter:
          '数据来自本插件 Host（/api/pre-compact/history）；完整诊断用 /precompact status；仅统计自插件本次加载以来。',
        viewStateIdle: '空闲',
        viewStateWorking: '进行中',
        viewStateReady: '已就绪',
        viewStateDone: '已完成',
        viewStateFailed: '失败',
        viewModeFixed: '固定',
        viewModeAdaptive: '自适应',
        viewEnabled: '已启用',
        viewPaused: '已暂停',
        viewStrategyLabel: '应用策略',
        openPanel: '打开后台预压缩面板',
        gaugeCurrent: '当前',
        gaugeTrigger: '触发',
        gaugeNative: '原生',
        stepLabel: '步',
        statsCompactions: '已压缩次数',
        statsSavedTime: '累计节省时间',
        statsSavedTimeHint: '后台摘要运行期间主 Agent 未被阻塞的累计时长，等同于原生压缩会同步等待的时间。',
        statsAvgDuration: '平均摘要耗时',
        statsFreedTokens: '累计释放 tokens',
        statsToTrigger: '距触发',
        statsPastTrigger: '已超过触发',
        chartTitle: '上下文用量（按步）',
        chartEmpty: '暂无采样数据',
        chartStepUnknown: '未知步骤',
        chartTrigger: '触发阈值',
        chartNative: '原生阈值',
        kindManual: '手动',
        kindAuto: '自动',
        chartAriaStep:
          '上下文用量（按步）：当前步 {step} 占用 {percent}，触发 {trigger}，原生 {native}，{events}，节省 ≈ {saved}',
        chartAriaNoStep:
          '上下文用量（按步）：当前占用 {percent}，触发 {trigger}，原生 {native}，{events}，节省 ≈ {saved}',
        chartEventsOne: '1 次后台压缩',
        chartEventsMany: '{count} 次后台压缩',
        historyTitle: '最近压缩记录',
        historyEmpty: '还没有压缩记录',
        historyStep: '步骤',
        historyKind: '方式',
        historyReason: '触发原因',
        historyTokens: 'tokens（遮蔽 → 摘要）',
        historyReduction: '压缩率',
        historySavedTime: '节省时间',
        dryRunHint: '真正生成摘要并记录预计压缩幅度，但不写入会话历史（仍会消耗一次摘要请求）。',
        fixedThresholdHint: '上下文窗口的占用比例，达到后开始后台预压缩。',
        nativeThresholdHint: '原生压缩使用的阈值；auto 跟随已挂载后端，百分比则覆盖它。',
        autoAdjustFixedThresholdHint: '固定触发点会撞上原生阈值时，自动把它压到原生阈值之下。',
        minThresholdHint: '占上下文窗口的百分比；下限不得高于上限。',
        fallbackThresholdHint: '增长历史不足时使用的阈值。',
        minIntervalHint: '两次尝试之间至少间隔这么久。',
        minShadowedTokensHint:
          '一次自动预压缩要替换的历史消息总 tokens 低于此值时不启动。只影响自动触发；手动 /compact 不受限；0 = 关闭此门。',
        hookManualCompactHint: '手动 /compact 请求也走后台摘要，不阻塞当前回合。',
        save: '保存',
        saving: '保存中…',
        discard: '放弃更改',
        restoreDefaults: '恢复默认',
        saved: '已保存 —— 宿主会立即生效。',
        restored: '已把默认值载入草稿；保存后才会生效。',
        saveFailed: '设置保存失败。',
        loading: '正在读取配置…',
        unavailable: '宿主当前没有提供这个配置。',
        readOnly: '此配置为只读。',
        dirty: '有未保存的修改',
        fixErrors: '请先修正标红的数值再保存。',
        invalidNumber: '请输入数字。',
        invalidRange: '超出范围',
        minAboveMax: '自适应下限不得高于上限。',
      },
    }

    const styles = {
      root: { color: 'var(--dsw-alias-label-primary, #1f2328)', fontSize: '13px' },
      hint: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px', margin: '0 0 14px' },
      scope: {
        margin: '0 0 10px',
        padding: '8px 10px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      section: { margin: '0 0 18px' },
      heading: {
        margin: '0 0 10px',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 230px) minmax(0, 1fr)',
        gap: '9px 16px',
        alignItems: 'start',
      },
      gridOff: { opacity: 0.45 },
      label: { color: 'var(--dsw-alias-label-primary, #1f2328)', paddingTop: '6px', wordBreak: 'break-word' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        font: 'inherit',
      },
      fieldHint: { margin: '4px 0 0', color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '11.5px', lineHeight: 1.45 },
      fieldError: { margin: '4px 0 0', color: 'var(--dsw-alias-danger, #d1242f)', fontSize: '11.5px', lineHeight: 1.45 },
      nativeRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      nativeSelect: { flex: '0 0 auto', width: 'auto', minWidth: '170px' },
      nativeValue: { flex: '0 1 130px', width: '130px' },
      indicator: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      indicatorDot: {
        display: 'inline-block',
        flex: '0 0 auto',
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-accent, #4d6bfe)',
        animation: 'pre-compact-pulse 1.4s ease-in-out infinite',
      },
      indicatorDotReady: {
        animation: 'none',
        background: 'var(--dsw-alias-warning, #9a6700)',
      },
      indicatorDotFailed: {
        animation: 'none',
        background: 'var(--dsw-alias-danger, #d1242f)',
      },
      indicatorReady: { color: 'var(--dsw-alias-warning, #9a6700)' },
      indicatorFailed: { color: 'var(--dsw-alias-danger, #d1242f)' },
      indicatorCheck: {
        display: 'inline-block',
        flex: '0 0 auto',
        color: 'var(--dsw-alias-accent, #4d6bfe)',
        fontSize: '12px',
        lineHeight: 1,
      },
      view: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '12px',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        fontSize: '13px',
      },
      viewHeader: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      viewTitle: { margin: 0, fontSize: '15px', fontWeight: 600 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        fontSize: '12px',
      },
      pillDot: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: '11.5px',
      },
      openButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      openIcon: { fontSize: '12px', lineHeight: 1 },
      errorDot: {
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-danger, #d1242f)',
      },
      gaugeBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
      },
      gaugeTrack: {
        position: 'relative',
        height: '10px',
        borderRadius: '5px',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
      },
      gaugeFill: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        borderRadius: '5px 0 0 5px',
        background: 'var(--dsw-alias-accent, #4d6bfe)',
        opacity: 0.55,
      },
      gaugeMarker: { position: 'absolute', top: '-2px', bottom: '-2px', width: 0 },
      gaugeLabels: {
        display: 'flex',
        gap: '14px',
        flexWrap: 'wrap',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      gaugeLabelTrigger: { color: 'var(--dsw-alias-warning, #9a6700)' },
      sectionTitle: {
        margin: 0,
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      chartBox: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        borderRadius: '8px',
        padding: '8px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      chartSvg: { display: 'block', width: '100%', height: 'auto' },
      statsRow: { display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px' },
      statsChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 9px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      },
      statsChipStrong: { color: 'var(--dsw-alias-label-primary, #1f2328)' },
      chartTickLabel: { fill: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '10px' },
      chartNote: { margin: 0, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '11px' },
      chartLegend: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        padding: '2px 4px 0',
      },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: '5px' },
      legendDash: { display: 'inline-block', width: '18px', height: 0 },
      legendDiamond: {
        display: 'inline-block',
        width: '7px',
        height: '7px',
        background: 'var(--dsw-alias-warning, #9a6700)',
        transform: 'rotate(45deg)',
      },
      legendCircle: {
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        border: '2px solid var(--dsw-alias-accent, #4d6bfe)',
      },
      emptyText: {
        margin: 0,
        padding: '16px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontSize: '12px',
        textAlign: 'center',
      },
      tableWrap: { overflowX: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        padding: '6px 8px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontWeight: 600,
        borderBottom: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        verticalAlign: 'top',
      },
      footer: { margin: 0, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '11px', lineHeight: 1.5 },
      warn: {
        margin: '0 0 12px',
        padding: '7px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-warning, #9a6700)',
        color: 'var(--dsw-alias-warning, #9a6700)',
        fontSize: '12px',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px', flexWrap: 'wrap' },
      primary: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #4d6bfe)',
        color: '#fff',
        font: 'inherit',
        cursor: 'pointer',
      },
      secondary: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        font: 'inherit',
        cursor: 'pointer',
      },
      error: { color: 'var(--dsw-alias-danger, #d1242f)', marginTop: '8px' },
      notice: { color: 'var(--dsw-alias-label-secondary, #6b7280)', marginTop: '8px' },
      dirty: { color: 'var(--dsw-alias-warning, #9a6700)', marginTop: '8px' },
    }

    /** A percent value rounded to two decimals, so 0.7 becomes 70 not 70.00000000000001. */
    function roundPercent(value) {
      return Math.round(value * 100) / 100
    }

    /** A ratio rounded to six decimals before it reaches the schema. */
    function roundRatio(value) {
      return Math.round(value * 1e6) / 1e6
    }

    /**
     * Project a host settings document into the card's editable draft.
     * Every card key gets a value; ratios arrive as 0–1 and become percentages.
     * @param {Record<string, unknown> | undefined} value
     */
    function toDraft(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const draft = {}
      for (const key of DRAFT_KEYS) {
        const spec = FIELD_SPECS[key]
        const fallback = DEFAULT_DRAFT[key]
        const raw = source[key]
        switch (spec.kind) {
          case 'bool':
            draft[key] = typeof raw === 'boolean' ? raw : fallback
            break
          case 'select':
            draft[key] = spec.options.some((option) => option.value === raw) ? raw : fallback
            break
          case 'string':
            draft[key] = typeof raw === 'string' ? raw : fallback
            break
          case 'percent':
            draft[key] = typeof raw === 'number' && Number.isFinite(raw) ? roundPercent(raw * 100) : fallback
            break
          case 'native':
            draft[key] =
              raw === undefined || raw === 'auto'
                ? 'auto'
                : typeof raw === 'number' && Number.isFinite(raw)
                  ? roundPercent(raw * 100)
                  : 'auto'
            break
          case 'int':
          case 'number':
            draft[key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
            break
          default:
            draft[key] = fallback
        }
      }
      return draft
    }

    /** Convert one draft value back into the schema's units. */
    function fromDraftValue(key, value) {
      const spec = FIELD_SPECS[key]
      switch (spec.kind) {
        case 'percent':
          return roundRatio(Number(value) / 100)
        case 'native':
          return value === 'auto' ? 'auto' : roundRatio(Number(value) / 100)
        case 'int':
          return Math.round(Number(value))
        case 'number':
          return Number(value)
        case 'bool':
          return value === true
        default:
          return value
      }
    }

    /** Convert a whole draft into the settings document the Host stores. */
    function fromDraft(draft) {
      const out = {}
      for (const key of DRAFT_KEYS) out[key] = fromDraftValue(key, draft[key])
      return out
    }

    /** The `set` operations a save submits: every card field, always. */
    function buildOps(draft) {
      return DRAFT_KEYS.map((key) => ({ op: 'set', path: [key], value: fromDraftValue(key, draft[key]) }))
    }

    /** A finite number from a draft value, or undefined for empty/NaN input. */
    function numericValue(value) {
      if (value === '' || value === null || value === undefined) return undefined
      const number = Number(value)
      return Number.isFinite(number) ? number : undefined
    }

    /**
     * Front-end validation. Returns problem objects so the card can both mark
     * the field and refuse to save. Empty input is invalid, never NaN.
     * @param {Record<string, unknown>} draft
     */
    function validateDraft(draft) {
      const problems = []
      for (const key of DRAFT_KEYS) {
        const spec = FIELD_SPECS[key]
        const numeric = spec.kind === 'percent' || spec.kind === 'int' || spec.kind === 'number'
        const nativeCustom = spec.kind === 'native' && draft[key] !== 'auto'
        if (!numeric && !nativeCustom) continue
        const number = numericValue(draft[key])
        if (number === undefined) {
          problems.push({ key, code: 'invalidNumber' })
          continue
        }
        if (spec.min !== undefined && number < spec.min) {
          problems.push({ key, code: 'invalidRange', min: spec.min, max: spec.max })
          continue
        }
        if (spec.max !== undefined && number > spec.max) {
          problems.push({ key, code: 'invalidRange', min: spec.min, max: spec.max })
        }
      }
      const min = numericValue(draft.minThreshold)
      const max = numericValue(draft.maxThreshold)
      if (min !== undefined && max !== undefined && min > max) {
        problems.push({ key: 'minThreshold', code: 'minAboveMax' })
      }
      return problems
    }

    /** Localized one-line text for a validation problem. */
    function problemText(t, problem) {
      const label = t(problem.key)
      switch (problem.code) {
        case 'invalidNumber':
          return `${label}: ${t('invalidNumber')}`
        case 'invalidRange':
          return `${label}: ${t('invalidRange')} (${problem.min}–${problem.max})`
        case 'minAboveMax':
          return t('minAboveMax')
        default:
          return `${label}: ${t('invalidNumber')}`
      }
    }

    /**
     * Add the pulse keyframes once per document. The rule is global and
     * idempotent, so duplicate inserts are pointless; it is intentionally not
     * removed on unmount, because another indicator instance may be mid-run.
     */
    function ensureIndicatorStyles() {
      if (typeof document === 'undefined' || document === null) return
      const head = document.head
      if (head === null || head === undefined) return
      if (typeof document.createElement !== 'function') return
      if (typeof document.getElementById === 'function' && document.getElementById(INDICATOR_STYLE_ID) !== null) return
      const sheet = document.createElement('style')
      sheet.id = INDICATOR_STYLE_ID
      sheet.textContent = INDICATOR_CSS
      if (typeof head.appendChild === 'function') head.appendChild(sheet)
    }

    /**
     * Map one `GET /api/pre-compact/status` payload to what the dock shows.
     * Pure on purpose: the component owns polling, this owns the wording.
     * @param {any} payload
     * @param {(key: string) => string} t
     * @returns {{ kind: 'working' | 'ready' | 'done' | 'failed' | null, text: string }}
     */
    function describeIndicator(payload, t) {
      const translate = typeof t === 'function' ? t : (key) => key
      const idle = { kind: null, text: '' }
      if (payload === null || typeof payload !== 'object' || payload.ok === false) return idle
      const outcome = payload.outcome !== null && typeof payload.outcome === 'object' ? payload.outcome : null
      switch (payload.state) {
        case 'working':
          return { kind: 'working', text: translate(payload.manual === true ? 'indicatorWorkingManual' : 'indicatorWorking') }
        case 'ready':
          return { kind: 'ready', text: translate('indicatorReady') }
        case 'done':
          return { kind: 'done', text: translate(outcome !== null && outcome.manual === true ? 'indicatorDoneManual' : 'indicatorDone') }
        case 'failed':
          return { kind: 'failed', text: translate('indicatorFailed') }
        default:
          return idle
      }
    }

    /** Compact token text for axis and table labels: 712340 → "712.3K", 1000000 → "1M". */
    function formatTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0'
      if (number >= 1e6) return `${trimDecimal(number / 1e6)}M`
      if (number >= 1e3) return `${trimDecimal(number / 1e3)}K`
      return String(Math.round(number))
    }

    function trimDecimal(value) {
      const rounded = Math.round(value * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }

    /** A 0–1 ratio as a readable percentage: 0.712 → "71%", 0.071 → "7.1%". */
    function formatPercent(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0%'
      const percent = Math.abs(number) * 100
      return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`
    }

    /** Durations for the stats row and history table: 12300 → "12.3s", 125000 → "2m 05s". */
    function formatDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1000) return `${Math.round(value)}ms`
      const seconds = value / 1000
      if (seconds < 60) {
        const rounded = Math.round(seconds * 10) / 10
        return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`
      }
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds % 60)
      return `${minutes}m ${String(rest).padStart(2, '0')}s`
    }

    /** Replace `{name}` placeholders in a localized template. */
    function fillTemplate(template, values) {
      return Object.entries(values).reduce(
        (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
        String(template),
      )
    }

    /** X-axis tick text: a step, the unknown-step category, or the index fallback. */
    function chartTickLabel(tick, t) {
      if (tick.kind === 'unknown') return t('chartStepUnknown')
      if (tick.kind === 'index') return `#${tick.index + 1}`
      return `${t('stepLabel')} ${tick.step}`
    }

    function clampNumber(value, min, max) {
      return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
    }

    function positiveNumber(value) {
      const number = Number(value)
      return Number.isFinite(number) && number > 0 ? number : undefined
    }

    /** A payload step as a number, or null when it is absent (Number(null) is 0). */
    function stepOf(value) {
      if (value === null || value === undefined || value === '') return null
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    /**
     * Map the history payload's `current.phase` to the five dock semantics.
     * @param {any} payload
     * @param {(key: string) => string} t
     * @returns {{ kind: 'idle' | 'working' | 'ready' | 'done' | 'failed', text: string }}
     */
    function describeViewState(payload, t) {
      const translate = typeof t === 'function' ? t : (key) => key
      const current =
        payload !== null && typeof payload === 'object' && payload.current !== null && typeof payload.current === 'object'
          ? payload.current
          : null
      if (current === null) return { kind: 'idle', text: translate('viewStateIdle') }
      switch (String(current.phase ?? '').toUpperCase()) {
        case 'SNAPSHOTTING':
        case 'COMPRESSING':
        case 'APPLYING':
          return { kind: 'working', text: translate('viewStateWorking') }
        case 'READY':
          return { kind: 'ready', text: translate('viewStateReady') }
        case 'COMPLETED':
        case 'DONE':
          return { kind: 'done', text: translate('viewStateDone') }
        case 'FAILED':
          return { kind: 'failed', text: translate('viewStateFailed') }
        default:
          return { kind: 'idle', text: translate('viewStateIdle') }
      }
    }

    /**
     * Shape a history payload into everything the inline SVG draws, without
     * touching the DOM or a translator. The Host's `steps` series is the
     * primary x axis (one upserted entry per step, already ascending); only a
     * missing/empty `steps` falls back to grouping raw `samples` by step, and
     * to sample order when no sample carries a step (reported as `stepUnknown`).
     * All coordinates are already in the chart's own viewBox.
     * @param {any} payload
     * @param {number} [width]
     * @param {number} [height]
     */
    function buildChartModel(payload, width, height) {
      const viewWidth = Number.isFinite(width) && width > 160 ? width : CHART_WIDTH
      const viewHeight = Number.isFinite(height) && height > 100 ? height : CHART_HEIGHT
      const plot = {
        left: CHART_PADDING.left,
        right: Math.max(CHART_PADDING.left + 60, viewWidth - CHART_PADDING.right),
        top: CHART_PADDING.top,
        bottom: Math.max(CHART_PADDING.top + 60, viewHeight - CHART_PADDING.bottom),
      }
      const empty = {
        width: viewWidth,
        height: viewHeight,
        plot,
        empty: true,
        axis: 'step',
        stepUnknown: false,
        sampleCount: 0,
        eventCount: 0,
        points: [],
        steps: [],
        linePath: '',
        areaPath: '',
        markers: [],
        ticks: [],
        yTicks: [{ y: plot.bottom, value: 0, kind: 'zero' }],
        maxY: 1,
        threshold: { trigger: 0, native: 0, triggerY: plot.bottom, nativeY: plot.bottom },
      }
      if (payload === null || typeof payload !== 'object') return empty

      const current = payload.current !== null && typeof payload.current === 'object' ? payload.current : null
      const readEntry = (entry) => {
        if (entry === null || typeof entry !== 'object') return null
        const tokens = Number(entry.tokens)
        if (!Number.isFinite(tokens) || tokens < 0) return null
        return {
          at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
          tokens,
          step: stepOf(entry.step),
          trigger: positiveNumber(entry.trigger),
          native: positiveNumber(entry.native),
        }
      }
      const samples = []
      for (const entry of Array.isArray(payload.samples) ? payload.samples : []) {
        const parsed = readEntry(entry)
        if (parsed !== null) samples.push(parsed)
      }
      // `steps` is the Host's own per-step series (one upserted entry per step,
      // ascending): it is the primary axis, so a single busy step can no longer
      // crowd the raw sample buffer and hide the rest of the run.
      const byStep = new Map()
      for (const entry of Array.isArray(payload.steps) ? payload.steps : []) {
        const parsed = readEntry(entry)
        if (parsed !== null && parsed.step !== null) byStep.set(parsed.step, parsed)
      }
      const orderedSteps = [...byStep.values()].sort((left, right) => left.step - right.step)
      const events = []
      for (const event of Array.isArray(payload.history) ? payload.history : []) {
        if (event === null || typeof event !== 'object') continue
        events.push({ manual: event.manual === true, step: stepOf(event.step) })
      }
      const lastSample = samples.length > 0 ? samples[samples.length - 1] : null
      const lastStep = orderedSteps.length > 0 ? orderedSteps[orderedSteps.length - 1] : null
      const trigger = positiveNumber(current?.triggerTokens) ?? lastStep?.trigger ?? lastSample?.trigger ?? 0
      const native = positiveNumber(current?.nativeThresholdTokens) ?? lastStep?.native ?? lastSample?.native ?? 0
      if (orderedSteps.length === 0 && samples.length === 0) {
        return {
          ...empty,
          eventCount: events.length,
          threshold: { trigger, native, triggerY: plot.bottom, nativeY: plot.bottom },
        }
      }

      // Prefer the Host's step series; only older/empty payloads fall back to
      // grouping raw samples (unknown step, then sample-order as last resort).
      let categories = []
      let fallbackByIndex = false
      if (orderedSteps.length > 0) {
        categories = orderedSteps.map((entry, index) => ({ kind: 'step', step: entry.step, index, sample: entry }))
      } else {
        const numericGroups = new Map()
        let unknownSample = null
        for (const sample of samples) {
          if (sample.step === null) unknownSample = sample
          else numericGroups.set(sample.step, sample)
        }
        fallbackByIndex = numericGroups.size === 0
        if (fallbackByIndex) {
          samples.forEach((sample, index) => categories.push({ kind: 'index', step: null, index, sample }))
        } else {
          if (unknownSample !== null) categories.push({ kind: 'unknown', step: null, index: 0, sample: unknownSample })
          const steps = [...numericGroups.keys()].sort((left, right) => left - right)
          for (const step of steps) {
            categories.push({ kind: 'step', step, index: categories.length, sample: numericGroups.get(step) })
          }
        }
      }

      const maxTokens = Math.max(...categories.map((category) => category.sample.tokens), trigger, native, 1)
      const maxY = maxTokens * 1.06
      const yFor = (value) => plot.bottom - (clampNumber(Number(value), 0, maxY) / maxY) * (plot.bottom - plot.top)
      const span = plot.right - plot.left
      const count = categories.length
      const xForIndex = (index) => (count <= 1 ? plot.left + span / 2 : plot.left + (index / (count - 1)) * span)

      const points = categories.map((category, index) => ({
        x: xForIndex(index),
        y: yFor(category.sample.tokens),
        step: category.step,
        kind: category.kind,
        index,
        tokens: category.sample.tokens,
        at: category.sample.at,
      }))
      const linePath = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${roundCoord(point.x)} ${roundCoord(point.y)}`)
        .join(' ')
      const areaPath =
        points.length < 2
          ? ''
          : `${linePath} L ${roundCoord(points[points.length - 1].x)} ${roundCoord(plot.bottom)} L ${roundCoord(points[0].x)} ${roundCoord(plot.bottom)} Z`

      // Only history entries whose step is actually on the axis get a marker;
      // unmatched or step-less entries stay out of the plot.
      const stepPositions = new Map()
      for (const category of categories) if (category.kind === 'step') stepPositions.set(category.step, xForIndex(category.index))
      const markers = []
      for (const event of events) {
        if (event.step === null) continue
        const x = stepPositions.get(event.step)
        if (x === undefined) continue
        markers.push({ x, step: event.step, kind: event.manual ? 'manual' : 'auto' })
      }

      // At most six category ticks, evenly sampled and always including the ends.
      const tickIndices = []
      if (count <= CHART_MAX_TICKS) {
        for (let index = 0; index < count; index += 1) tickIndices.push(index)
      } else {
        for (let step = 0; step < CHART_MAX_TICKS; step += 1) {
          const index = Math.round((step / (CHART_MAX_TICKS - 1)) * (count - 1))
          if (!tickIndices.includes(index)) tickIndices.push(index)
        }
      }
      const ticks = tickIndices.map((index) => {
        const category = categories[index]
        return { x: xForIndex(index), index, step: category.step, kind: category.kind }
      })

      const yTicks = [{ y: yFor(0), value: 0, kind: 'zero' }]
      if (trigger > 0) yTicks.push({ y: yFor(trigger), value: trigger, kind: 'trigger' })
      if (native > 0) yTicks.push({ y: yFor(native), value: native, kind: 'native' })

      return {
        width: viewWidth,
        height: viewHeight,
        plot,
        empty: false,
        axis: fallbackByIndex ? 'index' : 'step',
        stepUnknown: fallbackByIndex,
        sampleCount: samples.length,
        stepCount: orderedSteps.length,
        eventCount: events.length,
        points,
        steps: categories.filter((category) => category.kind === 'step').map((category) => category.step),
        linePath,
        areaPath,
        markers,
        ticks,
        yTicks,
        maxY,
        threshold: { trigger, native, triggerY: yFor(trigger), nativeY: yFor(native) },
      }
    }

    /**
     * Aggregate the numbers behind the dashboard's stat chips from one history
     * payload. Pure: no formatting, no DOM. `null` means "no data to show".
     * @param {any} payload
     * @returns {{ compactions: number, savedMs: number | null, averageMs: number | null, freedTokens: number | null, toTrigger: number | null }}
     */
    function buildStats(payload) {
      const empty = { compactions: 0, savedMs: null, averageMs: null, freedTokens: null, toTrigger: null }
      if (payload === null || typeof payload !== 'object') return empty
      const current = payload.current !== null && typeof payload.current === 'object' ? payload.current : null
      const rows = (Array.isArray(payload.history) ? payload.history : []).filter(
        (row) => row !== null && typeof row === 'object',
      )
      let savedMs = 0
      let durationCount = 0
      let freedTokens = null
      for (const row of rows) {
        const duration = Number(row.durationMs)
        if (Number.isFinite(duration) && duration >= 0) {
          savedMs += duration
          durationCount += 1
        }
        const shadowed = Number(row.shadowedTokens)
        const framed = Number(row.framedTokens)
        if (Number.isFinite(shadowed) && Number.isFinite(framed)) {
          freedTokens = (freedTokens ?? 0) + Math.max(0, shadowed - framed)
        }
      }
      const triggerTokens = positiveNumber(current?.triggerTokens)
      const currentTokens = Number(current?.currentTokens)
      const toTrigger =
        triggerTokens === undefined || !Number.isFinite(currentTokens) ? null : triggerTokens - currentTokens
      return {
        compactions: rows.length,
        savedMs: durationCount > 0 ? savedMs : null,
        averageMs: durationCount > 0 ? savedMs / durationCount : null,
        freedTokens,
        toTrigger,
      }
    }

    function roundCoord(value) {
      return Math.round(value * 100) / 100
    }

    function diamondPoints(cx, cy, size) {
      return `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`
    }

    function SettingsCard(props) {
      const { t, view, form } = props
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState(() => toDraft(form.getSnapshot().value))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        const unsubscribe = form.subscribe(() => setSnapshot(form.getSnapshot()))
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
      }, [form])
      React.useEffect(() => {
        setDraft(toDraft(form.getSnapshot().value))
        setError('')
      }, [form, snapshot.revision])

      if (view === 'summary') return h('span', null, t('summary'))
      if (snapshot.status === 'loading') return h('p', { style: styles.hint }, t('loading'))
      if (snapshot.status !== 'ready') return h('p', { style: styles.hint }, t('unavailable'))
      if (snapshot.writable === false) return h('p', { style: styles.hint }, t('readOnly'))

      const setValue = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))

      const problems = validateDraft(draft)
      const byKey = new Map()
      for (const problem of problems) {
        if (!byKey.has(problem.key)) byKey.set(problem.key, problem)
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(snapshot.value))
      const canSave = !busy && dirty && problems.length === 0

      const save = async () => {
        if (!canSave) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const ok = await form.mutate(buildOps(draft), snapshot.revision)
          if (!ok) setError(t('saveFailed'))
          else setNotice(t('saved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const discard = () => {
        setDraft(toDraft(form.getSnapshot().value))
        setError('')
        setNotice('')
      }

      const restoreDefaults = () => {
        setDraft({ ...DEFAULT_DRAFT })
        setError('')
        setNotice(t('restored'))
      }

      const control = (key, spec, disabled) => {
        const id = `pc-${key}`
        const value = draft[key]
        switch (spec.kind) {
          case 'bool':
            return h('input', {
              id,
              type: 'checkbox',
              checked: value === true,
              disabled,
              onChange: (event) => setValue(key)(event.target.checked),
            })
          case 'select':
            return h(
              'select',
              {
                id,
                value,
                disabled,
                style: styles.input,
                onChange: (event) => setValue(key)(event.target.value),
              },
              spec.options.map((option) => h('option', { key: option.value, value: option.value }, t(option.labelKey))),
            )
          case 'string':
            return h('input', {
              id,
              type: 'text',
              value,
              disabled,
              style: styles.input,
              onChange: (event) => setValue(key)(event.target.value),
            })
          case 'native': {
            const custom = value !== 'auto'
            return h(
              'div',
              { style: styles.nativeRow },
              h(
                'select',
                {
                  id,
                  value: custom ? 'custom' : 'auto',
                  disabled,
                  style: { ...styles.input, ...styles.nativeSelect },
                  onChange: (event) => {
                    if (event.target.value === 'auto') setValue(key)('auto')
                    else setValue(key)(custom ? value : spec.customDefault)
                  },
                },
                h('option', { value: 'auto' }, t('nativeAuto')),
                h('option', { value: 'custom' }, t('nativeCustom')),
              ),
              custom
                ? h('input', {
                    id: `${id}-value`,
                    type: 'number',
                    value,
                    min: spec.min,
                    max: spec.max,
                    step: spec.step,
                    disabled,
                    style: { ...styles.input, ...styles.nativeValue },
                    onChange: (event) => setValue(key)(event.target.value === '' ? '' : Number(event.target.value)),
                  })
                : null,
            )
          }
          case 'percent':
          case 'int':
          case 'number':
            return h('input', {
              id,
              type: 'number',
              value,
              min: spec.min,
              max: spec.max,
              step: spec.step,
              disabled,
              style: styles.input,
              onChange: (event) => setValue(key)(event.target.value === '' ? '' : Number(event.target.value)),
            })
          default:
            return null
        }
      }

      const row = (key, disabled) => {
        const spec = FIELD_SPECS[key]
        const problem = byKey.get(key)
        return h(
          React.Fragment,
          { key },
          h('label', { htmlFor: `pc-${key}`, style: styles.label }, t(key)),
          h(
            'div',
            null,
            control(key, spec, disabled),
            spec.hintKey === undefined ? null : h('p', { style: styles.fieldHint }, t(spec.hintKey)),
            problem === undefined ? null : h('p', { style: styles.fieldError }, problemText(t, problem)),
          ),
        )
      }

      const section = (spec) => {
        const active = spec.activeWhen === undefined || draft.triggerMode === spec.activeWhen
        return h(
          'section',
          { key: spec.id, style: styles.section },
          h('h4', { style: styles.heading }, t(spec.titleKey)),
          spec.hintKey === undefined ? null : h('p', { style: { ...styles.hint, margin: '0 0 10px' } }, t(spec.hintKey)),
          h('div', { style: active ? styles.grid : { ...styles.grid, ...styles.gridOff } }, spec.fields.map((key) => row(key, !active))),
        )
      }

      return h(
        'div',
        { style: styles.root },
        h('p', { style: styles.scope }, t('scopeHint')),
        h('p', { style: styles.hint }, t('statusHint')),
        problems.length === 0 ? null : h('p', { style: styles.warn }, t('fixErrors')),
        SECTIONS.map(section),
        h(
          'div',
          { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled: !canSave, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: styles.secondary, disabled: busy || !dirty, onClick: discard }, t('discard')),
          h('button', { type: 'button', style: styles.secondary, disabled: busy, onClick: restoreDefaults }, t('restoreDefaults')),
        ),
        error === '' ? null : h('p', { style: styles.error }, error),
        notice === '' ? null : h('p', { style: styles.notice }, notice),
        dirty ? h('p', { style: styles.dirty }, t('dirty')) : null,
        h('p', { style: { ...styles.hint, marginTop: '12px', marginBottom: 0 } }, t('wrapperNote')),
      )
    }

    /**
     * Composer-dock status next to the token meter. The Host exposes the run
     * state over a read-only HTTP resource because a run that is still
     * snapshotting or summarizing has not emitted any session event yet.
     */
    function Indicator(props) {
      const sessionId = props.sessionId
      const translate = typeof props.t === 'function' ? props.t : (key) => key
      const [payload, setPayload] = React.useState(null)

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        ensureIndicatorStyles()
        let disposed = false
        let controller = null
        const poll = () => {
          // A hidden tab keeps the timer but skips the network round trip.
          if (typeof document !== 'undefined' && document !== null && document.hidden === true) return
          if (controller !== null) controller.abort()
          const current = new AbortController()
          controller = current
          fetch(`${STATUS_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: current.signal,
          })
            .then((response) => {
              if (response === null || response === undefined || response.ok !== true) return undefined
              return response.json().catch(() => undefined)
            })
            .then((next) => {
              if (disposed || controller !== current) return
              if (next === undefined) return
              setPayload(next !== null && typeof next === 'object' && next.ok === true ? next : null)
            })
            .catch(() => {
              // A transient network error keeps the last known state; the next poll retries.
            })
        }
        poll()
        const timer = setInterval(poll, POLL_INTERVAL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
      }, [sessionId])

      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const described = describeIndicator(payload, translate)
      if (described.kind === null) return null

      const statusProps = { role: 'status', 'aria-live': 'polite', style: styles.indicator }
      if (described.kind === 'working') {
        return h(
          'span',
          statusProps,
          h('span', { 'aria-hidden': 'true', className: 'pre-compact-indicator-dot', style: styles.indicatorDot }),
          h('span', null, described.text),
        )
      }
      if (described.kind === 'done') {
        return h(
          'span',
          statusProps,
          h('span', { 'aria-hidden': 'true', style: styles.indicatorCheck }, '✓'),
          h('span', null, described.text),
        )
      }
      const failed = described.kind === 'failed'
      return h(
        'span',
        { ...statusProps, style: { ...styles.indicator, ...(failed ? styles.indicatorFailed : styles.indicatorReady) } },
        h('span', {
          'aria-hidden': 'true',
          className: 'pre-compact-indicator-dot',
          style: { ...styles.indicatorDot, ...(failed ? styles.indicatorDotFailed : styles.indicatorDotReady) },
        }),
        h('span', null, described.text),
      )
    }

    const VIEW_PILL_DOT_COLORS = Object.freeze({
      idle: 'var(--dsw-alias-label-secondary, #6b7280)',
      working: 'var(--dsw-alias-accent, #4d6bfe)',
      ready: 'var(--dsw-alias-warning, #9a6700)',
      done: 'var(--dsw-alias-accent, #4d6bfe)',
      failed: 'var(--dsw-alias-danger, #d1242f)',
    })

    /**
     * Poll one read-only JSON resource for a session. The component owns the
     * layout; this hook owns fetch/abort/visibility/cleanup.
     */
    function usePolledJson(path, sessionId, intervalMs) {
      const [state, setState] = React.useState({ payload: null, failed: false })
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        let disposed = false
        let controller = null
        const poll = () => {
          if (typeof document !== 'undefined' && document !== null && document.hidden === true) return
          if (controller !== null) controller.abort()
          const current = new AbortController()
          controller = current
          fetch(`${path}?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: current.signal,
          })
            .then((response) => {
              if (response === null || response === undefined || response.ok !== true) return undefined
              return response.json().catch(() => undefined)
            })
            .then((next) => {
              if (disposed || controller !== current) return
              if (next === undefined) {
                setState((previous) => ({ payload: previous.payload, failed: true }))
                return
              }
              setState(
                next !== null && typeof next === 'object' && next.ok === true
                  ? { payload: next, failed: false }
                  : { payload: null, failed: false },
              )
            })
            .catch(() => {
              if (!disposed && controller === current) setState((previous) => ({ payload: previous.payload, failed: true }))
            })
        }
        poll()
        const timer = setInterval(poll, intervalMs)
        return () => {
          disposed = true
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
      }, [path, intervalMs, sessionId])
      return state
    }

    /**
     * `sidebar.right.pane.tab` panel: one status row, the context gauge, the
     * stat chips, the per-step trend with compaction markers, and the
     * recent-compaction table. Laid out for the narrow sidebar column.
     */
    function CompactionPanel(props) {
      const sessionId = props.sessionId
      const translate = typeof props.t === 'function' ? props.t : (key) => DICT.en[key] ?? key
      const { payload, failed } = usePolledJson(HISTORY_PATH, sessionId, VIEW_POLL_INTERVAL_MS)

      if (typeof sessionId !== 'string' || sessionId.length === 0) return null

      const current = payload !== null && payload.current !== null && typeof payload.current === 'object' ? payload.current : null
      const samples = payload !== null && Array.isArray(payload.samples) ? payload.samples : []
      const history = payload !== null && Array.isArray(payload.history) ? payload.history : []
      const state = describeViewState(payload, translate)
      const pillColor = VIEW_PILL_DOT_COLORS[state.kind] ?? VIEW_PILL_DOT_COLORS.idle
      const currentStep = current === null ? null : stepOf(current.step)

      const contextWindow = current === null ? 0 : Number(current.contextWindow)
      const usageRatio =
        current === null
          ? 0
          : clampNumber(
              Number.isFinite(Number(current.usageRatio))
                ? Number(current.usageRatio)
                : contextWindow > 0
                  ? Number(current.currentTokens) / contextWindow
                  : 0,
              0,
              1,
            )
      const triggerRatio =
        current === null
          ? 0
          : clampNumber(
              Number.isFinite(Number(current.triggerRatio))
                ? Number(current.triggerRatio)
                : contextWindow > 0
                  ? Number(current.triggerTokens) / contextWindow
                  : 0,
              0,
              1,
            )
      const nativeRatio =
        current === null
          ? 0
          : clampNumber(
              Number.isFinite(Number(current.nativeThresholdRatio))
                ? Number(current.nativeThresholdRatio)
                : contextWindow > 0
                  ? Number(current.nativeThresholdTokens) / contextWindow
                  : 0,
              0,
              1,
            )

      const chart = buildChartModel(payload, CHART_WIDTH, CHART_HEIGHT)
      const stats = buildStats(payload)
      const savedText = stats.savedMs === null ? '—' : formatDuration(stats.savedMs)
      const averageText = stats.averageMs === null ? '—' : formatDuration(stats.averageMs)
      const freedText = stats.freedTokens === null ? '—' : formatTokens(stats.freedTokens)
      const eventCount = history.length
      const eventsText =
        eventCount === 1
          ? translate('chartEventsOne')
          : fillTemplate(translate('chartEventsMany'), { count: eventCount })
      const ariaValues = {
        percent: formatPercent(usageRatio),
        trigger: formatPercent(triggerRatio),
        native: formatPercent(nativeRatio),
        events: eventsText,
        saved: savedText,
      }
      const chartAria =
        currentStep === null
          ? fillTemplate(translate('chartAriaNoStep'), ariaValues)
          : fillTemplate(translate('chartAriaStep'), { ...ariaValues, step: currentStep })

      const statsRow =
        payload === null
          ? null
          : h(
              'div',
              { style: styles.statsRow },
              h('span', { style: styles.statsChip }, `${translate('statsCompactions')} ${stats.compactions}`),
              h(
                'span',
                { style: styles.statsChip, title: translate('statsSavedTimeHint') },
                `${translate('statsSavedTime')} ${savedText}`,
              ),
              h('span', { style: styles.statsChip }, `${translate('statsAvgDuration')} ${averageText}`),
              h('span', { style: styles.statsChip }, `${translate('statsFreedTokens')} ${freedText}`),
              stats.toTrigger === null
                ? null
                : h(
                    'span',
                    { style: styles.statsChip },
                    stats.toTrigger > 0
                      ? `${translate('statsToTrigger')} ${formatTokens(stats.toTrigger)}`
                      : translate('statsPastTrigger'),
                  ),
            )

      const modeKey =
        current === null
          ? undefined
          : current.mode === 'adaptive'
            ? 'viewModeAdaptive'
            : current.mode === 'fixed'
              ? 'viewModeFixed'
              : undefined
      const strategyKey = current === null ? undefined : STRATEGY_LABEL_KEYS[String(current.applyStrategy)]

      const header = h(
        'div',
        { style: styles.viewHeader },
        h('h3', { style: styles.viewTitle }, translate('viewTitle')),
        h(
          'span',
          { style: styles.pill },
          h('span', { 'aria-hidden': 'true', style: { ...styles.pillDot, background: pillColor } }),
          state.text,
        ),
        modeKey === undefined ? null : h('span', { style: styles.chip }, translate(modeKey)),
        current === null
          ? null
          : h('span', { style: styles.chip }, current.enabled === true ? translate('viewEnabled') : translate('viewPaused')),
        strategyKey === undefined
          ? null
          : h('span', { style: styles.chip }, `${translate('viewStrategyLabel')}: ${translate(strategyKey)}`),
        currentStep === null
          ? null
          : h('span', { style: styles.chip }, `${translate('stepLabel')} ${currentStep}`),
        failed
          ? h('span', {
              role: 'status',
              title: translate('viewError'),
              'aria-label': translate('viewError'),
              style: styles.errorDot,
            })
          : null,
      )

      const gauge =
        current === null || !(contextWindow > 0)
          ? null
          : h(
              'div',
              { style: styles.gaugeBlock },
              h(
                'div',
                { style: styles.gaugeTrack },
                h('div', { style: { ...styles.gaugeFill, width: `${(usageRatio * 100).toFixed(2)}%` } }),
                h('span', {
                  'aria-hidden': 'true',
                  style: {
                    ...styles.gaugeMarker,
                    left: `${(triggerRatio * 100).toFixed(2)}%`,
                    borderLeft: '1px dashed var(--dsw-alias-warning, #9a6700)',
                  },
                }),
                h('span', {
                  'aria-hidden': 'true',
                  style: {
                    ...styles.gaugeMarker,
                    left: `${(nativeRatio * 100).toFixed(2)}%`,
                    borderLeft: '1px solid var(--dsw-alias-label-secondary, #6b7280)',
                  },
                }),
              ),
              h(
                'div',
                { style: styles.gaugeLabels },
                h('span', null, `${translate('gaugeCurrent')} ${formatPercent(usageRatio)}`),
                h('span', { style: styles.gaugeLabelTrigger }, `${translate('gaugeTrigger')} ${formatPercent(triggerRatio)}`),
                h('span', null, `${translate('gaugeNative')} ${formatPercent(nativeRatio)}`),
              ),
            )

      const chartSection =
        payload === null
          ? null
          : h(
              'section',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('h4', { style: styles.sectionTitle }, translate('chartTitle')),
              chart.stepUnknown ? h('p', { style: styles.chartNote }, translate('chartStepUnknown')) : null,
              chart.empty
                ? h('div', { style: styles.chartBox }, h('p', { style: styles.emptyText }, translate('chartEmpty')))
                : h(
                    'div',
                    { style: styles.chartBox },
                    h(
                      'svg',
                      {
                        viewBox: `0 0 ${chart.width} ${chart.height}`,
                        preserveAspectRatio: 'xMidYMid meet',
                        role: 'img',
                        'aria-label': chartAria,
                        style: styles.chartSvg,
                      },
                      chart.yTicks.map((tick) =>
                        h(
                          'g',
                          { key: `y-${tick.kind}` },
                          h('line', {
                            x1: chart.plot.left,
                            x2: chart.plot.right,
                            y1: tick.y,
                            y2: tick.y,
                            style: {
                              stroke:
                                tick.kind === 'zero'
                                  ? 'var(--dsw-alias-border-1, #d0d7de)'
                                  : tick.kind === 'trigger'
                                    ? 'var(--dsw-alias-warning, #9a6700)'
                                    : 'var(--dsw-alias-label-secondary, #6b7280)',
                              strokeWidth: 1,
                              strokeDasharray: tick.kind === 'trigger' ? '6 4' : tick.kind === 'native' ? '2 4' : undefined,
                            },
                          }),
                          h(
                            'text',
                            { x: chart.plot.left - 8, y: tick.y + 3, textAnchor: 'end', style: styles.chartTickLabel },
                            formatTokens(tick.value),
                          ),
                        ),
                      ),
                      chart.ticks.map((tick, index) =>
                        h(
                          'text',
                          {
                            key: `x-${index}`,
                            x: tick.x,
                            y: chart.plot.bottom + 16,
                            textAnchor: 'middle',
                            style: styles.chartTickLabel,
                          },
                          chartTickLabel(tick, translate),
                        ),
                      ),
                      chart.areaPath === ''
                        ? null
                        : h('path', {
                            d: chart.areaPath,
                            style: { fill: 'var(--dsw-alias-accent, #4d6bfe)', fillOpacity: 0.14 },
                          }),
                      chart.linePath === ''
                        ? null
                        : h('path', {
                            d: chart.linePath,
                            style: {
                              fill: 'none',
                              stroke: 'var(--dsw-alias-accent, #4d6bfe)',
                              strokeWidth: 2,
                              strokeLinejoin: 'round',
                              strokeLinecap: 'round',
                            },
                          }),
                      chart.points.length === 1
                        ? h('circle', {
                            cx: chart.points[0].x,
                            cy: chart.points[0].y,
                            r: 3.5,
                            style: { fill: 'var(--dsw-alias-accent, #4d6bfe)' },
                          })
                        : null,
                      chart.markers.map((marker, index) =>
                        h(
                          'g',
                          { key: `marker-${index}` },
                          h('line', {
                            x1: marker.x,
                            x2: marker.x,
                            y1: chart.plot.top,
                            y2: chart.plot.bottom,
                            style: {
                              stroke:
                                marker.kind === 'manual'
                                  ? 'var(--dsw-alias-warning, #9a6700)'
                                  : 'var(--dsw-alias-accent, #4d6bfe)',
                              strokeWidth: 1,
                              strokeDasharray: '3 4',
                              opacity: 0.6,
                            },
                          }),
                          marker.kind === 'manual'
                            ? h('polygon', {
                                points: diamondPoints(marker.x, chart.plot.top + 5, 5),
                                style: { fill: 'var(--dsw-alias-warning, #9a6700)' },
                              })
                            : h('circle', {
                                cx: marker.x,
                                cy: chart.plot.top + 5,
                                r: 4,
                                style: {
                                  fill: 'var(--dsw-alias-bg-layer-1, #fff)',
                                  stroke: 'var(--dsw-alias-accent, #4d6bfe)',
                                  strokeWidth: 2,
                                },
                              }),
                        ),
                      ),
                    ),
                  ),
              chart.empty
                ? null
                : h(
                    'div',
                    { style: styles.chartLegend },
                    h(
                      'span',
                      { style: styles.legendItem },
                      h('span', {
                        'aria-hidden': 'true',
                        style: {
                          ...styles.legendDash,
                          borderTop: '2px dashed var(--dsw-alias-warning, #9a6700)',
                        },
                      }),
                      translate('chartTrigger'),
                    ),
                    h(
                      'span',
                      { style: styles.legendItem },
                      h('span', {
                        'aria-hidden': 'true',
                        style: {
                          ...styles.legendDash,
                          borderTop: '2px dotted var(--dsw-alias-label-secondary, #6b7280)',
                        },
                      }),
                      translate('chartNative'),
                    ),
                    h(
                      'span',
                      { style: styles.legendItem },
                      h('span', { 'aria-hidden': 'true', style: styles.legendDiamond }),
                      translate('kindManual'),
                    ),
                    h(
                      'span',
                      { style: styles.legendItem },
                      h('span', { 'aria-hidden': 'true', style: styles.legendCircle }),
                      translate('kindAuto'),
                    ),
                  ),
            )

      const rows = history
        .filter((row) => row !== null && typeof row === 'object' && Number.isFinite(Number(row.at)))
        .slice(-HISTORY_ROWS)
        .reverse()
      const tableSection =
        payload === null
          ? null
          : h(
              'section',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('h4', { style: styles.sectionTitle }, translate('historyTitle')),
              rows.length === 0
                ? h('p', { style: styles.emptyText }, translate('historyEmpty'))
                : h(
                    'div',
                    { style: styles.tableWrap },
                    h(
                      'table',
                      { style: styles.table },
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          [
                            'historyStep',
                            'historyKind',
                            'historyReason',
                            'historyTokens',
                            'historyReduction',
                            'historySavedTime',
                          ].map((key) => h('th', { key, style: styles.th }, translate(key))),
                        ),
                      ),
                      h(
                        'tbody',
                        null,
                        rows.map((row, index) =>
                          h(
                            'tr',
                            { key: `row-${index}` },
                            h(
                              'td',
                              { style: styles.td },
                              stepOf(row.step) === null ? '—' : `${translate('stepLabel')} ${stepOf(row.step)}`,
                            ),
                            h('td', { style: styles.td }, row.manual === true ? translate('kindManual') : translate('kindAuto')),
                            h('td', { style: styles.td }, String(row.trigger ?? '—')),
                            h(
                              'td',
                              { style: styles.td },
                              `${formatTokens(row.shadowedTokens)} → ${formatTokens(row.framedTokens)}`,
                            ),
                            h('td', { style: styles.td }, formatPercent(Number(row.reduction))),
                            h('td', { style: styles.td }, formatDuration(Number(row.durationMs))),
                          ),
                        ),
                      ),
                    ),
                  ),
            )

      const footer = h('p', { style: styles.footer }, translate('viewFooter'))

      if (payload === null) {
        return h('div', { style: styles.view }, header, h('p', { style: styles.emptyText }, translate('viewLoading')), footer)
      }
      if (current === null && samples.length === 0 && history.length === 0) {
        return h('div', { style: styles.view }, header, h('p', { style: styles.emptyText }, translate('viewEmpty')), footer)
      }
      return h('div', { style: styles.view }, header, gauge, statsRow, chartSection, tableSection, footer)
    }

    /**
     * Conversation-header chip that opens the sidebar panel for this session.
     * With no sidebar runtime (or no session) it is a silent no-op.
     */
    function OpenPanelButton(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => DICT.en[key] ?? key
      const sidebarRight = props.sidebarRight
      const open = () => {
        try {
          if (sidebarRight !== null && sidebarRight !== undefined && typeof sidebarRight.openTab === 'function') {
            sidebarRight.openTab(TAB_KIND)
          }
        } catch {
          // No session on screen, or no sidebar runtime: nothing to open.
        }
      }
      return h(
        'button',
        {
          type: 'button',
          style: styles.openButton,
          title: translate('openPanel'),
          'aria-label': translate('openPanel'),
          onClick: open,
        },
        h('span', { 'aria-hidden': 'true', style: styles.openIcon }, '▤'),
        h('span', null, translate('viewLabel')),
      )
    }

    return {
      // Exposed for the offline test harness only; the module loader ignores it.
      __internals: {
        NS,
        SETTINGS_NAMESPACE,
        BUNDLE,
        STATUS_PATH,
        POLL_INTERVAL_MS,
        HISTORY_PATH,
        VIEW_POLL_INTERVAL_MS,
        CHART_WIDTH,
        CHART_HEIGHT,
        CHART_MAX_TICKS,
        TAB_ID,
        TAB_KIND,
        HISTORY_ROWS,
        DICT,
        DEFAULT_DRAFT,
        FIELD_SPECS,
        SECTIONS,
        DRAFT_KEYS,
        COMMON_KEYS,
        toDraft,
        fromDraft,
        fromDraftValue,
        buildOps,
        roundPercent,
        validateDraft,
        problemText,
        describeIndicator,
        describeViewState,
        buildChartModel,
        buildStats,
        chartTickLabel,
        fillTemplate,
        stepOf,
        formatTokens,
        formatPercent,
        formatDuration,
      },
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))

        // The row's Host settings namespace is the single document; bind it
        // once and hand the same form to the bundle-page card.
        const form = ctx.configForms.get(SETTINGS_NAMESPACE)
        const Card = (props) => h(SettingsCard, { ...props, form })

        ctx.effect(() =>
          ctx.configForms.whileServed([SETTINGS_NAMESPACE], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: BUNDLE,
                  id: BUNDLE,
                  locale: NS,
                },
                Card,
              ),
            ),
          ),
        )

        // The dock entry sits left of the token ring in the composer footer.
        // `order: 0` keeps it ahead of the meter's own entry.
        ctx.effect(() =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'pre-compact',
                locale: NS,
                order: 0,
              },
              Indicator,
            ),
          ),
        )

        // The compact dashboard lives in the right sidebar as an extension tab.
        // Missing sidebar services only skip this feature; the settings card
        // and the composer indicator above keep working.
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (c) => {
          ctx.effect(() =>
            c.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => c.locale.bind(NS)('viewLabel'),
            }),
          )

          ctx.effect(() =>
            c.slots.inject('sidebar.right.pane.tab', () =>
              c.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                },
                CompactionPanel,
              ),
            ),
          )

          ctx.effect(() =>
            c.slots.inject('conversation.session.header.utilities', () =>
              c.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'pre-compact',
                  locale: NS,
                  order: 10,
                },
                (props) => h(OpenPanelButton, { ...props, sidebarRight: c.sidebarRight }),
              ),
            ),
          )
        })
      },
    }
  },
})
