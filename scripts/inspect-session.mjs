// Inspect one persisted DSH session artifact (concatenated zstd frames).
// Usage: node scripts/inspect-session.mjs <sessionId> [--json]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('DSH_HOME is not set')
  process.exit(1)
}
const sessionId = process.argv[2]
const asJson = process.argv.includes('--json')
if (!sessionId) {
  console.error('usage: node scripts/inspect-session.mjs <sessionId> [--json]')
  process.exit(1)
}

const sessionsRoot = path.join(DSH_HOME, 'sessions')
let artifact
for (const workspace of fs.readdirSync(sessionsRoot)) {
  const candidate = path.join(sessionsRoot, workspace, sessionId, 'session.v4.jsonl.zstd')
  if (fs.existsSync(candidate)) {
    artifact = candidate
    break
  }
}
if (!artifact) {
  console.error('session artifact not found for', sessionId)
  process.exit(1)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = fs.readFileSync(artifact)
const offsets = []
let cursor = 0
while ((cursor = buf.indexOf(MAGIC, cursor)) !== -1) {
  offsets.push(cursor)
  cursor += 4
}
let text = ''
for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
  try {
    text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch (error) {
    console.error('frame', index, 'could not be decoded:', error.message)
  }
}
const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
const events = []
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    // ignore partial trailing line
  }
}

const counts = {}
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1

// Rebuild the surface by replaying surfaceOp metadata.
const surface = []
let replacements = 0
const compactionIds = []
for (const event of events) {
  const surfaceTypes = ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']
  if (!surfaceTypes.includes(event.type)) continue
  if (event.surfaceOp === 'append') surface.push(event.seq)
  else if (event.surfaceOp?.op === 'replace') {
    const startIdx = surface.indexOf(event.surfaceOp.startSeq)
    const endIdx = surface.indexOf(event.surfaceOp.endSeq)
    if (startIdx >= 0 && endIdx >= startIdx) surface.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements += 1
  }
}
for (const event of events) {
  if (event.type === 'compaction/start') compactionIds.push(event.data?.compactionId)
}

const summary = {
  artifact,
  bytes: buf.length,
  frames: offsets.length,
  events: events.length,
  counts,
  surfaceNodes: surface.length,
  replacements,
  compactions: {
    starts: counts['compaction/start'] ?? 0,
    summaries: counts['compaction/summary'] ?? 0,
    ends: counts['compaction/end'] ?? 0,
    ids: compactionIds,
    summaryPayloads: events
      .filter((event) => event.type === 'compaction/summary')
      .map((event) => ({
        seq: event.seq,
        compactionId: event.data?.compactionId,
        shadowedCount: Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs.length : null,
        shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
        shadowedRange: event.data?.shadowedRange ?? null,
        provider: event.data?.provider,
        model: event.data?.model,
        summaryChars: Array.isArray(event.data?.summary) ? event.data.summary.reduce((total, block) => total + String(block.text ?? '').length, 0) : null,
      })),
  },
  checkpointReplacements: events
    .filter((event) => event.type === 'user/message' && event.surfaceOp && event.surfaceOp !== 'append')
    .map((event) => ({
      seq: event.seq,
      startSeq: event.surfaceOp.startSeq,
      endSeq: event.surfaceOp.endSeq,
      sourceKind: event.data?.source?.kind,
      compactionId: event.data?.source?.compactionId,
      sourceEventSeqs: event.sourceEventSeqs,
      textStart: Array.isArray(event.data?.content) ? String(event.data.content[0]?.text ?? '').slice(0, 60) : null,
    })),
  tailTypes: events.slice(-8).map((event) => event.type),
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log('artifact:', artifact)
  console.log('events:', summary.events, 'surface nodes:', summary.surfaceNodes, 'replacements:', summary.replacements)
  console.log('compaction starts/summaries/ends:', summary.compactions.starts, summary.compactions.summaries, summary.compactions.ends)
  for (const payload of summary.compactions.summaryPayloads) {
    console.log('  summary seq', payload.seq, 'shadowed nodes:', payload.shadowedCount, 'shadowed tokens:', payload.shadowedTokenCount, 'range:', JSON.stringify(payload.shadowedRange), 'model:', `${payload.provider}/${payload.model}`, 'summary chars:', payload.summaryChars)
  }
  for (const replacement of summary.checkpointReplacements) {
    console.log('  replace seq', replacement.seq, 'covers', replacement.startSeq, '-', replacement.endSeq, 'source:', replacement.sourceKind, 'sources:', replacement.sourceEventSeqs?.length)
  }
  console.log('tail types:', summary.tailTypes.join(','))
}
