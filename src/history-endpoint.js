/**
 * Read-only history resource for the session-view visualization.
 *
 * `GET /api/pre-compact/history?sessionId=…` returns the bounded context-token
 * series and the applied-compaction history the runtime keeps per session, plus
 * the current trigger/threshold figures. The session-view dashboard polls this;
 * the tiny composer indicator keeps using `/api/pre-compact/status`.
 * @module dsh-pre-compact/history-endpoint
 */

import { jsonResponse, sameOriginAllowed } from './visual-status.js'

/** Exact HTTP route for the visualization history. */
export const HISTORY_PATH = '/api/pre-compact/history'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * @param {{ statusFor: (sessionId: string) => any }} runtime
 */
export function createHistoryResource(runtime) {
  return function historyResource(request) {
    try {
      if (!sameOriginAllowed(request)) return jsonResponse(403, { ok: false, error: 'forbidden' })
      const url = new URL(request?.url ?? HISTORY_PATH, 'http://dsh.invalid')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!SESSION_ID.test(sessionId)) return jsonResponse(400, { ok: false, error: 'invalid sessionId' })
      const status = runtime.statusFor(sessionId)
      if (status === null || status === undefined) {
        return jsonResponse(200, {
          ok: true,
          version: 1,
          now: Date.now(),
          sessionId,
          current: null,
          samples: [],
          steps: [],
          history: [],
        })
      }
      return jsonResponse(200, {
        ok: true,
        version: 1,
        now: Date.now(),
        sessionId,
        current: {
          enabled: status.enabled,
          phase: status.phase,
          mode: status.mode,
          turn: status.turn ?? null,
          step: status.step ?? null,
          applyStrategy: status.applyStrategy,
          currentTokens: status.currentTokens,
          contextWindow: status.contextWindow,
          usageRatio: status.usageRatio,
          triggerTokens: status.triggerTokens,
          triggerRatio: status.triggerRatio,
          triggerReason: status.triggerReason,
          nativeThresholdTokens: status.nativeThresholdTokens,
          nativeThresholdRatio: status.nativeThresholdRatio,
          growthRateTokensPerSecond: status.growthRateTokensPerSecond,
          predictedDurationSeconds: status.predictedDurationSeconds,
          // Trimmed like the composer indicator: the dashboard needs the reason,
          // not the internal error chain.
          lastSkip:
            status.lastSkip === null || status.lastSkip === undefined
              ? null
              : { at: status.lastSkip.at, reason: status.lastSkip.reason },
          manualRequest:
            status.manualRequest === null || status.manualRequest === undefined
              ? null
              : {
                  id: status.manualRequest.id,
                  requestedAt: status.manualRequest.requestedAt,
                  retried: status.manualRequest.retried,
                },
          manualHook: status.manualHook,
          lastFailure:
            status.lastFailure === null || status.lastFailure === undefined
              ? null
              : { at: status.lastFailure.at, code: status.lastFailure.code },
        },
        samples: Array.isArray(status.samples) ? status.samples.map((sample) => ({ ...sample })) : [],
        steps: Array.isArray(status.steps) ? status.steps.map((sample) => ({ ...sample })) : [],
        history: Array.isArray(status.history) ? status.history.map((entry) => ({ ...entry })) : [],
      })
    } catch {
      return jsonResponse(500, { ok: false, error: 'history unavailable' })
    }
  }
}
