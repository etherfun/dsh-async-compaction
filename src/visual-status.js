/**
 * Read-only visual status for the Web UI indicator beside the context meter.
 *
 * The browser half polls this small JSON resource so it can show "background
 * compaction in progress" before any `compaction/*` event exists (the summary
 * runs off the session log), and "background compaction finished" for a short
 * window after the atomic commit. It exposes only aggregate counters — never
 * message content.
 * @module dsh-pre-compact/visual-status
 */

/** How long a finished compaction stays visible as the "done" state. */
export const DONE_WINDOW_MS = 8000
/** How long a failed compaction stays visible as the "failed" state. */
export const FAILED_WINDOW_MS = 8000

/** Exact HTTP route the browser half polls. */
export const VISUAL_STATUS_PATH = '/api/pre-compact/status'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Build the compact status payload the indicator renders.
 * @param {any} status - `runtime.statusFor(sessionId)` (null when untracked)
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function buildVisualStatus(status, now = Date.now()) {
  const last = status?.lastOutcome ?? null
  const active = status?.activeTask ?? null
  const ready = status?.readyResult ?? null
  const failure = status?.lastFailure ?? null

  const lastAt = typeof last?.at === 'number' ? last.at : null
  const failureAt = typeof failure?.at === 'number' ? failure.at : null
  const recentDone = last?.state === 'COMPLETED' && lastAt !== null && now - lastAt >= 0 && now - lastAt <= DONE_WINDOW_MS
  const failureIsNewer = failureAt !== null && (lastAt === null || failureAt > lastAt)
  const recentFailure =
    failure !== null && failureIsNewer && now - failureAt >= 0 && now - failureAt <= FAILED_WINDOW_MS

  let state = 'idle'
  if (active !== null) state = 'working'
  else if (ready !== null) state = 'ready'
  else if (recentFailure) state = 'failed'
  else if (recentDone) state = 'done'

  return {
    ok: true,
    version: 1,
    now,
    state,
    phase: status?.phase ?? 'IDLE',
    enabled: status?.enabled ?? null,
    manual: status?.manualRequest !== null && status?.manualRequest !== undefined,
    startedAt: typeof active?.startedAt === 'number' ? active.startedAt : null,
    outcome:
      last === null
        ? null
        : {
            state: last.state,
            at: lastAt,
            manual: last.manual === true,
            dryRun: last.dryRun === true,
            reduction: typeof last.reduction === 'number' ? last.reduction : null,
            shadowedTokens: typeof last.shadowedTokens === 'number' ? last.shadowedTokens : null,
          },
    failure:
      failure === null
        ? null
        : {
            at: failureAt,
            code: typeof failure.code === 'string' ? failure.code : 'failed',
          },
  }
}

/** @param {number} status @param {Record<string, any>} payload */
export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Same-origin check shared by the read-only debug endpoints: when the browser
 * sends an Origin it must name the request Host.
 * @param {any} request
 * @returns {boolean}
 */
export function sameOriginAllowed(request) {
  const host = request?.headers?.get?.('host') ?? null
  const origin = request?.headers?.get?.('origin') ?? null
  if (origin === null || host === null) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const json = jsonResponse

/**
 * Fetch-style resource answering `GET /api/pre-compact/status?sessionId=…`.
 * Same-origin only (a present Origin must match the request Host).
 * @param {{ statusFor: (sessionId: string) => any }} runtime
 */
export function createStatusResource(runtime) {
  return function statusResource(request) {
    try {
      const url = new URL(request?.url ?? VISUAL_STATUS_PATH, 'http://dsh.invalid')
      if (!sameOriginAllowed(request)) return json(403, { ok: false, error: 'forbidden' })
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!SESSION_ID.test(sessionId)) return json(400, { ok: false, error: 'invalid sessionId' })
      return json(200, buildVisualStatus(runtime.statusFor(sessionId)))
    } catch {
      return json(500, { ok: false, error: 'status unavailable' })
    }
  }
}
