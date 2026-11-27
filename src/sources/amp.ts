import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  count,
  files,
  modelName,
  parseJson,
  record,
  timestamp,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { inferProvider } from './vendor'

const failure = 'Amp 기록을 읽지 못해 이번에는 빼고 올려요.'
type Event = { readonly ms: number; readonly row: UsageRow }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function validTime(...values: readonly unknown[]): number {
  return values.map(timestamp).find(Number.isFinite) ?? NaN
}
function parseThread(rawThread: unknown): Event[] {
  const thread = record(rawThread)
  if (!text(thread['id'])) return []
  const messages: unknown[] = Array.isArray(thread['messages'])
    ? thread['messages']
    : []
  const cache = new Map<number, Record<string, unknown>>()
  for (const raw of messages) {
    const message = record(raw)
    if (
      message['role'] === 'assistant' &&
      typeof message['messageId'] === 'number'
    )
      cache.set(message['messageId'], record(message['usage']))
  }
  const ledger = record(thread['usageLedger'])
  const hasLedger = Object.hasOwn(ledger, 'events')
  const entries: unknown[] = hasLedger
    ? Array.isArray(ledger['events'])
      ? ledger['events']
      : []
    : messages
  return entries.flatMap((raw) => {
    const message = record(raw)
    if (!hasLedger && message['role'] !== 'assistant') return []
    if (
      hasLedger &&
      (typeof message['tokens'] !== 'object' ||
        message['tokens'] === null ||
        Array.isArray(message['tokens']))
    )
      return []
    const usage = record(message['usage'])
    const model =
      text(hasLedger ? message['model'] : usage['model']) ??
      (!hasLedger ? text(message['model']) : undefined)
    const ms = hasLedger
      ? validTime(message['timestamp'], usage['timestamp'])
      : validTime(usage['timestamp'], message['timestamp'])
    if (!model || !Number.isFinite(ms)) return []
    const tokens = hasLedger ? record(message['tokens']) : usage
    const linked =
      hasLedger && typeof message['toMessageId'] === 'number'
        ? (cache.get(message['toMessageId']) ?? {})
        : usage
    const rawParts = {
      input: tokens[hasLedger ? 'input' : 'inputTokens'],
      output: tokens[hasLedger ? 'output' : 'outputTokens'],
      cacheRead: linked['cacheReadInputTokens'],
      cacheWrite: linked['cacheCreationInputTokens'],
    }
    const sum = Object.values(rawParts).reduce<number>(
      (subtotal, value) => subtotal + count(value),
      0,
    )
    const total = Math.max(
      sum,
      count(tokens[hasLedger ? 'total' : 'totalTokens']),
    )
    if (total === 0) return []
    const parts: Partial<
      Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>
    > = {}
    if (sum > 0)
      for (const key of [
        'input',
        'output',
        'cacheRead',
        'cacheWrite',
      ] as const) {
        const part = rawParts[key]
        if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)
          parts[key] = part
      }
    return [
      {
        ms,
        row: {
          date: kstDateOf(ms),
          tool: 'amp',
          model: modelName(model),
          provider: inferProvider(model),
          tokens: total,
          ...parts,
        },
      },
    ]
  })
}

export async function readAmp(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['AMP_DATA_DIR'],
      [join(options.home, '.local/share/amp')],
      options.home,
    )
    const rows: UsageRow[] = []
    for (const root of roots) {
      const threads = await listRoots(
        undefined,
        [join(root, 'threads')],
        options.home,
      )
      for (const dir of threads)
        for await (const path of files(dir)) {
          if (!path.endsWith('.json')) continue
          try {
            if ((await stat(path)).mtimeMs < options.sinceMs) continue
            for (const event of parseThread(
              parseJson(await readFile(path, 'utf8')),
            ))
              if (event.ms >= options.sinceMs) rows.push(event.row)
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(
                String(error.code),
              )
            )
              continue
            throw error
          }
        }
    }
    return capped(rows, failure)
  } catch (error) {
    return unsupported(error, failure)
  }
}
