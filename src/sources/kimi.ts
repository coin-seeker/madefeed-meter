import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  count,
  directory,
  files,
  jsonLines,
  modelName,
  parseJson,
  record,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { inferProvider } from './vendor'

const failure = 'Kimi CLI 기록을 읽지 못해 이번에는 빼고 올려요.'
const defaultModel = 'kimi-for-coding'
type Entry = {
  readonly key: string
  readonly ms: number
  readonly row: UsageRow
  readonly output: number
}

async function configModel(root: string): Promise<string> {
  try {
    const model = record(
      parseJson(await readFile(join(root, 'config.json'), 'utf8')),
    )['model']
    return typeof model === 'string' && model.trim()
      ? model.trim()
      : defaultModel
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return defaultModel
    throw error
  }
}

function parseEntry(
  value: unknown,
  context: { readonly session: string; readonly model: string },
): Entry | undefined {
  const event = record(value)
  let usage: Record<string, unknown>
  let model: string
  let ms: number
  let messageId: unknown = null
  let total = 0
  let input: number
  let output: number
  let cacheRead: number
  let cacheWrite: number
  switch (event['type']) {
    case 'usage.record': {
      if (event['usageScope'] !== 'turn') return
      usage = record(event['usage'])
      const logged = event['model']
      model = (
        typeof logged === 'string' && logged.trim()
          ? logged.trim()
          : defaultModel
      ).replace(/^kimi-code\//, '')
      ms =
        typeof event['time'] === 'number' && Number.isSafeInteger(event['time'])
          ? event['time']
          : NaN
      input = count(usage['inputOther'])
      output = count(usage['output'])
      cacheRead = count(usage['inputCacheRead'])
      cacheWrite = count(usage['inputCacheCreation'])
      break
    }
    case 'metadata':
      return
    default: {
      const message = record(event['message'])
      if (message['type'] !== 'StatusUpdate') return
      const payload = record(message['payload'])
      usage = record(payload['token_usage'])
      model = context.model
      ms =
        typeof event['timestamp'] === 'number'
          ? Math.trunc(event['timestamp'] * 1000)
          : NaN
      messageId =
        typeof payload['message_id'] === 'string' &&
        payload['message_id'].trim()
          ? payload['message_id'].trim()
          : null
      input = count(usage['input_other'])
      output = count(usage['output'])
      cacheRead = count(usage['input_cache_read'])
      cacheWrite = count(usage['input_cache_creation'])
      total = count(usage['total'])
    }
  }
  if (!Number.isFinite(new Date(ms).getTime())) return
  const sum = input + output + cacheRead + cacheWrite
  const tokens = Math.max(total, sum)
  if (tokens <= 0 || !Number.isSafeInteger(tokens)) return
  const remainder = tokens - sum
  const key = JSON.stringify([
    context.session,
    messageId,
    ms,
    model,
    input,
    output === 0 ? remainder : output,
    cacheWrite,
    cacheRead,
    output === 0 ? 0 : remainder,
  ])
  const inferred = inferProvider(model)
  return {
    key,
    ms,
    output,
    row: {
      date: kstDateOf(ms),
      tool: 'kimi',
      model: modelName(model),
      provider: inferred === 'unknown' ? 'moonshotai' : inferred,
      tokens,
      ...(sum > 0 ? { input, output, cacheRead, cacheWrite } : {}),
    },
  }
}

export async function readKimi(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['KIMI_DATA_DIR'],
      [join(options.home, '.kimi'), join(options.home, '.kimi-code')],
      options.home,
    )
    // Mutable accumulator: explicit output wins over incomplete replay copies.
    const entries = new Map<string, Entry>()
    for (const root of roots) {
      const sessions = join(root, 'sessions')
      if (!(await directory(sessions))) continue
      const paths: string[] = []
      for await (const path of files(sessions)) {
        const parts = relative(sessions, path).split(sep)
        if (
          (parts.length === 3 ||
            (parts.length === 5 && parts[2] === 'agents')) &&
          parts.at(-1) === 'wire.jsonl'
        )
          paths.push(path)
      }
      let model: string | undefined
      for (const path of paths.sort()) {
        const session = relative(sessions, path).split(sep)[1] ?? ''
        for await (const value of jsonLines(path)) {
          const event = record(value)
          if (record(event['message'])['type'] === 'StatusUpdate')
            model ??= await configModel(root)
          const entry = parseEntry(value, {
            session,
            model: model ?? defaultModel,
          })
          if (!entry) continue
          const previous = entries.get(entry.key)
          if (!previous || entry.output > previous.output)
            entries.set(entry.key, entry)
        }
      }
    }
    return capped(
      [...entries.values()]
        .filter((entry) => entry.ms >= options.sinceMs)
        .map((entry) => entry.row),
      failure,
    )
  } catch (error) {
    return unsupported(error, failure)
  }
}
