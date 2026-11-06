/**
 * Read-only debug endpoint for the in-memory structured log buffer.
 *
 * `GET /api/pre-compact/logs?limit=100&level=info&sessionId=…&sinceSeq=…`
 * answers the newest records as JSON. It exposes exactly what the host logger
 * received (message + sanitized fields), never message content, and is meant
 * for local debugging through the Web GUI.
 * @module dsh-pre-compact/logs-endpoint
 */

import { jsonResponse, sameOriginAllowed } from './visual-status.js'

/** Exact HTTP route for the debug log endpoint. */
export const LOGS_PATH = '/api/pre-compact/logs'

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * @param {{ snapshot?: (options: Record<string, any>) => Array<Record<string, any>>, stats?: () => Record<string, any> }} logger
 */
export function createLogsResource(logger) {
  return function logsResource(request) {
    try {
      if (typeof logger?.snapshot !== 'function') {
        return jsonResponse(500, { ok: false, error: 'log buffer unavailable' })
      }
      if (!sameOriginAllowed(request)) return jsonResponse(403, { ok: false, error: 'forbidden' })
      const url = new URL(request?.url ?? LOGS_PATH, 'http://dsh.invalid')
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? 100 : Number(rawLimit)
      if (rawLimit !== null && (!Number.isFinite(limit) || limit < 1 || limit > 500)) {
        return jsonResponse(400, { ok: false, error: 'limit must be between 1 and 500' })
      }
      const level = url.searchParams.get('level')
      if (level !== null && !LEVELS.has(level)) {
        return jsonResponse(400, { ok: false, error: 'level must be debug, info, warn or error' })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId !== null && !SESSION_ID.test(sessionId)) {
        return jsonResponse(400, { ok: false, error: 'invalid sessionId' })
      }
      const rawSince = url.searchParams.get('sinceSeq')
      const sinceSeq = rawSince === null ? undefined : Number(rawSince)
      if (rawSince !== null && (!Number.isInteger(sinceSeq) || sinceSeq < 0)) {
        return jsonResponse(400, { ok: false, error: 'sinceSeq must be a non-negative integer' })
      }
      const records = logger.snapshot({
        limit: rawLimit === null ? 100 : Math.round(limit),
        ...(level === null ? {} : { level }),
        ...(sessionId === null ? {} : { sessionId }),
        ...(sinceSeq === undefined ? {} : { sinceSeq }),
      })
      const stats = typeof logger.stats === 'function' ? logger.stats() : { count: records.length, capacity: null }
      return jsonResponse(200, {
        ok: true,
        version: 1,
        now: Date.now(),
        count: records.length,
        capacity: stats.capacity ?? null,
        lastSeq: stats.lastSeq ?? null,
        records,
      })
    } catch {
      return jsonResponse(500, { ok: false, error: 'logs unavailable' })
    }
  }
}
