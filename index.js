/**
 * Background context pre-compaction for the DeepSeek Harness.
 *
 * The plugin observes context pressure, prepares a compaction summary in the
 * background (off the agent's critical path) and applies it atomically at a safe
 * execution boundary — before the native compaction mechanism has to stop the
 * agent. Native compaction stays mounted and unchanged as the final backstop.
 *
 * This entry file only wires host events and the `/precompact` command; the
 * runtime lives in `src/coordinator.js`.
 * @module dsh-pre-compact
 */

import { resolveConfig, unwrapConfigRefs } from './src/config.js'
import configSchema from './src/config-schema.js'
import { createRuntime, PHASE } from './src/coordinator.js'
import { createManualHook } from './src/manual-hook.js'
import { formatFields } from './src/log.js'
import { createHistoryResource, HISTORY_PATH } from './src/history-endpoint.js'
import { createLogsResource, LOGS_PATH } from './src/logs-endpoint.js'
import { createStatusResource, VISUAL_STATUS_PATH } from './src/visual-status.js'
import { errorChain, round } from './src/util.js'

export const name = 'pre-compact'

/**
 * Declarative Config when the host's schemastery is resolvable (copied or
 * published install); `undefined` for a locally linked checkout, where the
 * same defaults are validated by `resolveConfig()`.
 */
export const Config = configSchema

/**
 * The plugin intentionally declares no hard `inject`: a profile without a
 * token meter or a compaction backend still boots, and the plugin then stays
 * inert instead of failing activation.
 */

/** @param {any} ctx @param {Record<string, unknown>} [rawConfig] */
export function apply(ctx, rawConfig = {}) {
  // `.volatile()` options arrive as Cordis references; resolve their current
  // values now and re-read them on `loader/volatile-update` below.
  const { config, warnings } = resolveConfig(unwrapConfigRefs(rawConfig))
  const runtime = createRuntime(ctx, config, warnings)
  const manualHook = createManualHook({ ctx, runtime, log: runtime.log })

  ctx.effect(
    () => () => {
      // Restore the wrapped method first so a late `/compact` call can never
      // re-enter a disposing runtime, then release timers and pending requests.
      manualHook.restore()
      runtime.dispose()
    },
    'pre-compact runtime',
  )
  runtime.startTimer()

  // The Plugins page saves volatile options by rewriting the row config; the
  // Loader validates it and publishes this event without restarting the plugin.
  ctx.on('loader/volatile-update', () => {
    try {
      const next = resolveConfig(unwrapConfigRefs(rawConfig))
      for (const warning of next.warnings) runtime.log.warn(`configuration: ${warning}`)
      runtime.applyConfig(next.config)
    } catch (error) {
      runtime.log.warn('volatile configuration update failed; keeping the previous values', {
        error: errorChain(error),
      })
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      runtime.onSessionEvent(session, event)
    } catch (error) {
      runtime.log.warn('session/event handler failed', { error: errorChain(error) })
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      runtime.onSessionDisposed(session)
    } catch (error) {
      runtime.log.warn('session/disposed handler failed', { error: errorChain(error) })
    }
  })

  ctx.on('agent/created', (payload) => {
    try {
      manualHook.ensure(payload?.agent)
    } catch (error) {
      runtime.log.warn('agent/created hook failed', { error: errorChain(error) })
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      manualHook.ensure(payload?.agent)
      runtime.onPreStep(payload?.agent)
    } catch (error) {
      runtime.log.warn('pre-step hook failed', { error: errorChain(error) })
    }
    return next()
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      runtime.onTurnStopping(payload?.agent)
    } catch (error) {
      runtime.log.warn('turn-stopping hook failed', { error: errorChain(error) })
    }
  })

  ctx.on('agent/status', (payload) => {
    if (payload?.status !== 'idle') return
    try {
      runtime.onIdle(payload.agent)
    } catch (error) {
      runtime.log.warn('agent/status hook failed', { error: errorChain(error) })
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      runtime.onAgentDisposed(payload?.agent)
    } catch (error) {
      runtime.log.warn('agent/disposed hook failed', { error: errorChain(error) })
    }
  })

  if (config.statusCommand) registerStatusCommand(ctx, runtime)
  installVisualStatusRoute(ctx, runtime)
}

/**
 * Publish the read-only status the Web UI indicator polls.
 * @param {any} ctx
 * @param {ReturnType<typeof createRuntime>} runtime
 */
function installVisualStatusRoute(ctx, runtime) {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
        runtime.log.debug('web server unavailable; the context-meter indicator stays hidden')
        return
      }
      webCtx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: VISUAL_STATUS_PATH,
            resource: createStatusResource(runtime),
          }),
        'pre-compact: visual status route',
      )
      webCtx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: LOGS_PATH,
            resource: createLogsResource(runtime.log),
          }),
        'pre-compact: debug logs route',
      )
      webCtx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: HISTORY_PATH,
            resource: createHistoryResource(runtime),
          }),
        'pre-compact: visualization history route',
      )
    })
  } catch (error) {
    runtime.log.debug('visual status route is unavailable', { error: errorChain(error) })
  }
}

/**
 * `/precompact [status|list|pause|resume|dry-run|live|now]`
 * @param {any} ctx
 * @param {ReturnType<typeof createRuntime>} runtime
 */
function registerStatusCommand(ctx, runtime) {
  const commands = ctx.get?.('commands')
  if (commands === undefined || commands === null || typeof commands.register !== 'function') {
    runtime.log.debug('command registry unavailable; /precompact is not registered')
    return
  }
  const disposer = commands.register({
    definitionId: 'dsh-pre-compact/command',
    name: 'precompact',
    description: 'Inspect or control background context pre-compaction',
    /** @param {any} invocation */
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [subcommand = 'status'] = raw.split(/\s+/).filter((part) => part.length > 0)
      try {
        switch (subcommand) {
          case 'status':
            return { kind: 'success', text: renderStatus(runtime.statusFor(invocation?.agent?.session?.id)) }
          case 'list': {
            const rows = runtime.statuses()
            if (rows.length === 0) return { kind: 'success', text: 'No sessions are tracked yet.' }
            return { kind: 'success', text: rows.map((row) => renderStatus(row, true)).join('\n\n') }
          }
          case 'pause':
            runtime.setEnabled(false)
            return { kind: 'success', text: 'Background pre-compaction paused for this process.' }
          case 'resume':
            runtime.setEnabled(true)
            return { kind: 'success', text: 'Background pre-compaction resumed.' }
          case 'dry-run':
            runtime.config.dryRun = true
            return { kind: 'success', text: 'Dry-run enabled: results are computed and logged but never applied.' }
          case 'live':
            runtime.config.dryRun = false
            return { kind: 'success', text: 'Dry-run disabled: results are applied at the next safe boundary.' }
          case 'now': {
            if (invocation?.agent === undefined) return { kind: 'error', text: 'This command requires an agent session.' }
            await runtime.forceEvaluate(invocation.agent)
            return { kind: 'success', text: renderStatus(runtime.statusFor(invocation.agent.session.id)) }
          }
          case 'compact': {
            if (invocation?.agent === undefined) return { kind: 'error', text: 'This command requires an agent session.' }
            const request = runtime.tryManualCompaction(invocation.agent, {
              signal: invocation.signal,
              sourceCommandId: invocation.commandId,
            })
            if (request === undefined) {
              return {
                kind: 'error',
                text: 'Background compaction is unavailable (disabled, dry-run, or hookManualCompact=false); use /compact.',
              }
            }
            try {
              const result = await request
              if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
              return {
                kind: 'success',
                text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) in the background.`,
                ...(Number.isSafeInteger(result.summarySeq) ? { sourceEventSeq: result.summarySeq } : {}),
              }
            } catch (error) {
              return { kind: 'error', text: `precompact: ${errorChain(error)}` }
            }
          }
          case 'logs': {
            const requested = Number(String(raw.split(/\s+/)[1] ?? ''))
            const count = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.round(requested))) : 30
            return { kind: 'success', text: renderLogs(runtime.log, count) }
          }
          default:
            return {
              kind: 'error',
              text: 'Usage: /precompact [status|list|logs [n]|pause|resume|dry-run|live|now|compact]',
            }
        }
      } catch (error) {
        return { kind: 'error', text: `precompact failed: ${errorChain(error)}` }
      }
    },
  })
  if (typeof disposer === 'function') ctx.effect(() => () => disposer(), 'pre-compact command')
}

/**
 * Render the most recent structured log records for `/precompact logs [n]`.
 * @param {any} logger
 * @param {number} count
 */
function renderLogs(logger, count) {
  const records = logger.snapshot({ limit: count })
  const stats = typeof logger.stats === 'function' ? logger.stats() : { count: records.length, capacity: null }
  if (records.length === 0) {
    return 'No pre-compaction log records are buffered yet (logBufferSize=0 disables the buffer; logLevel only controls the console).'
  }
  const time = (at) =>
    typeof at === 'number' ? new Date(at).toISOString().slice(11, 23) : '??:??:??.???'
  const lines = [
    `Recent pre-compaction logs (${records.length} of ${stats.count} buffered, capacity ${stats.capacity ?? 'unknown'}):`,
  ]
  for (const record of records) {
    const level = String(record.level ?? 'info').toUpperCase().padEnd(5)
    const fields = record.fields === undefined ? '' : formatFields(record.fields)
    lines.push(`#${record.seq} ${time(record.at)} ${level} ${record.event}${fields.length === 0 ? '' : ` ${fields}`}`)
  }
  lines.push('JSON: GET /api/pre-compact/logs?limit=…&level=…&sessionId=…&sinceSeq=…')
  return lines.join('\n')
}

/**
 * @param {ReturnType<typeof createRuntime>['statusFor'] extends (id: string) => infer R ? R : any} status
 * @param {boolean} [compact]
 */
function renderStatus(status, compact = false) {
  if (status === null || status === undefined) {
    return 'Background pre-compaction: no state for this session yet (it starts monitoring on the first agent step).'
  }
  const percent = (value) => (typeof value === 'number' ? `${round(value * 100, 1)}%` : 'unknown')
  const tokens = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : 'unknown')
  const lines = [
    `Background pre-compaction — ${status.enabled ? 'enabled' : 'paused'} (${status.mode} mode, apply=${status.applyStrategy})`,
    `Context: ${tokens(status.currentTokens)} / ${tokens(status.contextWindow)} (${percent(status.usageRatio)}) over ${status.surfaceNodes} surface nodes`,
    `Native threshold: ${tokens(status.nativeThresholdTokens)} (${percent(status.nativeThresholdRatio)}, source=${status.nativeSource ?? 'unknown'})`,
    `Pre-compaction trigger: ${tokens(status.triggerTokens)} (${percent(status.triggerRatio)}; ${status.triggerReason ?? 'not evaluated yet'})`,
    `Growth: ${status.growthRateTokensPerSecond === null ? 'unknown' : `${round(status.growthRateTokensPerSecond, 1)} tokens/s`}; predicted compression ${status.predictedDurationSeconds === null ? 'unknown' : `${round(status.predictedDurationSeconds, 1)}s`} (${status.durationObservations} sample(s))`,
    `Task state: ${status.phase}${status.hasActiveTask ? ' (compressing)' : ''}${status.hasReadyResult ? ' (ready to apply)' : ''}`,
  ]
  if (status.manualRequest !== null && status.manualRequest !== undefined) {
    lines.push(
      `Manual request: queued ${status.manualRequest.id}${status.manualRequest.retried === true ? ' (retried once)' : ''}; waiting for a safe boundary`,
    )
  }
  if (status.manualHook !== null && status.manualHook !== undefined) {
    lines.push(
      `Manual /compact hook: ${status.manualHook.state}${status.manualHook.detail === undefined ? '' : ` (${status.manualHook.detail})`}`,
    )
  }
  if (status.lastSkip !== null && status.lastSkip !== undefined) {
    lines.push(`Last skip: ${status.lastSkip.reason}`)
  }
  if (status.lastOutcome !== null && status.lastOutcome !== undefined) {
    const outcome = status.lastOutcome
    if (outcome.dryRun === true) {
      lines.push(
        `Last result (dry run): would shadow ${outcome.shadowedCount} nodes (${tokens(outcome.shadowedTokens)} tokens) into ${tokens(outcome.framedTokens)} framed tokens`,
      )
    } else if (outcome.state === PHASE.COMPLETED) {
      lines.push(
        `Last result: shadowed ${outcome.shadowedCount} nodes (${tokens(outcome.shadowedTokens)} tokens) into ${tokens(outcome.framedTokens)} framed tokens; reduction ${percent(outcome.reduction)}; ~${tokens(outcome.totalAfterEstimate)} tokens after`,
      )
    } else {
      lines.push(`Last result: ${outcome.state}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`)
    }
  }
  if (status.lastFailure !== null && status.lastFailure !== undefined) {
    lines.push(`Last failure: ${status.lastFailure.code} — ${status.lastFailure.message}`)
  }
  if (status.lastMeasureError !== null && status.lastMeasureError !== undefined) {
    lines.push(`Measurement problem: ${status.lastMeasureError.message}`)
  }
  if (compact) lines.push(`Session: ${status.sessionId}`)
  return lines.join('\n')
}
