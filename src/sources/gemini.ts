import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  files,
  jsonLines,
  modelName,
  parseJson,
  record,
  timestamp,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { inferProvider } from './vendor'

type Event = {
  readonly ms: number
  readonly model: string
  readonly tokens: number
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly reasoning?: number
}
type Context = {
  readonly model?: string
  readonly ms: number
  readonly stats: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function time(value: unknown, fallback: number): number {
  const ms = typeof value === 'string' ? timestamp(value) : NaN
  return Number.isFinite(ms) ? ms : fallback
}
function token(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(Math.max(0, value))
    : undefined
}
function event(raw: unknown, context: Context): Event | undefined {
  const data = record(raw)
  const model = text(data['model']) ?? context.model
  const rawTokens = data['tokens']
  if (
    !model ||
    typeof rawTokens !== 'object' ||
    rawTokens === null ||
    Array.isArray(rawTokens)
  )
    return undefined
  const tokens = record(rawTokens)
  const part = (keys: readonly string[]) =>
    keys
      .map((key) => token(tokens[key]))
      .find((value) => value !== undefined) ?? 0
  const input = part(['input', 'prompt', 'input_tokens', 'prompt_tokens'])
  const output = part([
    'output',
    'candidates',
    'output_tokens',
    'candidates_tokens',
  ])
  const cached = part(['cached', 'cached_tokens'])
  const thoughts = part([
    'thoughts',
    'reasoning',
    'thoughts_tokens',
    'reasoning_tokens',
  ])
  const tool = part(['tool', 'tool_tokens'])
  const total = token(
    Object.hasOwn(tokens, 'total') ? tokens['total'] : tokens['total_tokens'],
  )
  const inclusive = input + output + thoughts + tool
  const net =
    context.stats || (cached > 0 && total === inclusive)
      ? input - Math.min(input, cached)
      : input
  const sum = Math.max(net + output + cached + thoughts + tool, total ?? 0)
  if (sum === 0) return undefined
  return {
    model,
    tokens: sum,
    ...(input + output + cached + thoughts + tool > 0
      ? {
          input: net + tool,
          output: output + thoughts,
          cacheRead: cached,
          reasoning: thoughts,
        }
      : {}),
    ms: time(data['timestamp'], time(data['created_at'], context.ms)),
  }
}
function statsEvents(data: Record<string, unknown>, context: Context): Event[] {
  const stats = record(
    Object.hasOwn(data, 'stats')
      ? data['stats']
      : record(data['result'])['stats'],
  )
  const events: Event[] = []
  for (const [model, value] of Object.entries(record(stats['models']))) {
    const parsed = event(
      { model, tokens: record(value)['tokens'] },
      { ...context, stats: true },
    )
    if (parsed) events.push(parsed)
  }
  if (events.length) return events
  const parsed = event(
    { model: context.model ?? 'unknown', tokens: stats },
    { ...context, stats: true },
  )
  return parsed ? [parsed] : []
}
function jsonEvents(value: unknown, mtime: number): Event[] {
  const data = record(value)
  if (Array.isArray(data['messages'])) {
    const context = {
      ms: time(data['startTime'], time(data['lastUpdated'], mtime)),
      stats: false,
    }
    return data['messages'].flatMap((value) => {
      const message = record(value)
      const parsed =
        message['type'] === 'gemini' ? event(message, context) : undefined
      return parsed ? [parsed] : []
    })
  }
  if (data['type'] === 'gemini') {
    const parsed = event(data, { ms: mtime, stats: false })
    return parsed ? [parsed] : []
  }
  const model = text(data['model'])
  return statsEvents(data, {
    ...(model ? { model } : {}),
    ms: time(data['timestamp'], mtime),
    stats: true,
  })
}
async function jsonlEvents(path: string, mtime: number): Promise<Event[]> {
  const events: Event[] = []
  const ids = new Map<string, number>()
  let model: string | undefined
  for await (const value of jsonLines(path)) {
    const data = record(value)
    model = text(data['model']) ?? model
    const context = { ...(model ? { model } : {}), ms: mtime, stats: false }
    if (data['type'] === 'gemini') {
      const parsed = event(data, context)
      if (!parsed) continue
      const id = text(data['id'])
      const previous = id ? ids.get(id) : undefined
      if (previous !== undefined) events[previous] = parsed
      else {
        if (id) ids.set(id, events.length)
        events.push(parsed)
      }
    } else
      events.push(
        ...statsEvents(data, {
          ...context,
          ms: time(data['timestamp'], mtime),
        }),
      )
  }
  return events
}

export async function readGemini(
  options: SourceOptions,
): Promise<SourceResult> {
  const custom = options.env?.['GEMINI_DATA_DIR']
  const roots =
    custom !== undefined
      ? custom.split(',')
      : [join(options.home, '.gemini/tmp')]
  const rows: UsageRow[] = []
  for (const root of roots) {
    if (!root) continue
    try {
      for await (const path of files(root)) {
        if (!path.endsWith('.json') && !path.endsWith('.jsonl')) continue
        try {
          const mtime = (await stat(path)).mtimeMs
          if (mtime < options.sinceMs) continue
          const events = path.endsWith('.jsonl')
            ? await jsonlEvents(path, mtime)
            : jsonEvents(parseJson(await readFile(path, 'utf8')), mtime)
          for (const event of events) {
            const { ms, model: rawModel, ...usage } = event
            const model = modelName(rawModel)
            if (ms >= options.sinceMs)
              rows.push({
                date: kstDateOf(ms),
                tool: 'gemini',
                model,
                provider: inferProvider(model),
                ...usage,
              })
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error
          // One unreadable file must not hide other sessions.
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return { supported: true, rows }
}
