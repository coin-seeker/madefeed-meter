import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { count, jsonLines, modelName, record, timestamp } from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'

type SessionTool = 'pi' | 'omp' | 'omo'
type Entry = {
  readonly ms: number
  readonly row: UsageRow
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function eventTime(event: Record<string, unknown>, mtime: number): number {
  const iso =
    typeof event['timestamp'] === 'string' ? timestamp(event['timestamp']) : NaN
  if (Number.isFinite(iso)) return iso
  const numeric = record(event['message'])['timestamp']
  return typeof numeric === 'number' && Number.isFinite(numeric)
    ? numeric
    : mtime
}

export async function sessionHeader(
  path: string,
): Promise<Record<string, unknown>> {
  for await (const value of jsonLines(path)) {
    const header = record(value)
    return header['type'] === 'session' ? header : {}
  }
  return {}
}

export async function readPiSessions(
  paths: readonly string[],
  tool: SessionTool,
  options: SourceOptions,
): Promise<SourceResult> {
  // Mutable per-tool accumulator: forks/resumes may copy history across files.
  const entries = new Map<string, Entry>()
  for (const path of [...new Set(paths)].sort()) {
    const mtime = (await stat(path)).mtimeMs
    if (mtime < options.sinceMs) continue
    let session = basename(path, '.jsonl')
    let line = 0
    for await (const value of jsonLines(path)) {
      line += 1
      const event = record(value)
      if (line === 1 && event['type'] === 'session') {
        session = text(event['id']) || session
        continue
      }
      const message = record(event['message'])
      if (message['role'] !== 'assistant') continue
      const usage = record(message['usage'])
      const sum =
        count(usage['input']) +
        count(usage['output']) +
        count(usage['cacheRead']) +
        count(usage['cacheWrite'])
      if (sum === 0) continue
      const total = usage['totalTokens']
      const tokens =
        typeof total === 'number' && Number.isSafeInteger(total) && total >= 0
          ? total
          : sum
      const id = text(event['id'])
      const time = text(event['timestamp'])
      const key =
        text(message['responseId']) ||
        (id || time ? `${id}@${time}` : `${session}:${line}`)
      const ms = eventTime(event, mtime)
      const previous = entries.get(key)
      if (!previous || ms < previous.ms)
        entries.set(key, {
          ms,
          row: {
            date: kstDateOf(ms),
            tool,
            model: modelName(message['model']),
            tokens,
          },
        })
    }
  }
  return {
    supported: true,
    rows: [...entries.values()]
      .filter((entry) => entry.ms >= options.sinceMs)
      .map((entry) => entry.row),
  }
}
