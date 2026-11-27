import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  count,
  files,
  modelName,
  parseJson,
  providerName,
  record,
  textLines,
  timestamp,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { inferProvider } from './vendor'

const failure = 'Droid 기록을 읽지 못해 이번에는 빼고 올려요.'
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function normalizeModel(value: string): string {
  let depth = 0
  let result = ''
  for (const char of value.replace(/^custom:/, '')) {
    if (char === '[') depth++
    else if (char === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0) result += char
  }
  return result
    .trim()
    .toLowerCase()
    .replace(/[.\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
function normalizeProvider(value: unknown): string {
  const normalized =
    text(value)?.toLowerCase().replaceAll('-', '_') ?? 'unknown'
  switch (normalized) {
    case 'claude':
    case 'anthropic':
      return 'anthropic'
    case 'google':
    case 'google_ai':
    case 'gemini':
      return 'google'
    case 'xai':
    case 'x_ai':
    case 'grok':
      return 'xai'
    case 'vertex':
    case 'vertex_ai':
    case 'vertexai':
    case 'google_vertex':
    case 'google_vertex_ai':
      return 'vertex_ai'
    default:
      return providerName(normalized)
  }
}
function defaultModel(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-unknown'
    case 'openai':
      return 'gpt-unknown'
    case 'google':
    case 'vertex_ai':
      return 'gemini-unknown'
    case 'xai':
      return 'grok-unknown'
    default:
      return provider === 'unknown' ? 'unknown' : `${provider}-unknown`
  }
}
async function sidecarModel(path: string): Promise<string | undefined> {
  try {
    let index = 0
    for await (const line of textLines(
      path.replace(/\.settings\.json$/, '.jsonl'),
    )) {
      if (index++ >= 500) break
      const tail = line
        .split('Model:')[1]
        ?.split(/["\\[]/)[0]
        ?.trim()
      if (tail) return tail
    }
    return undefined
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(
        String(error.code),
      )
    )
      return undefined
    throw error
  }
}
type Snapshot = { readonly ms: number; readonly row: UsageRow }
async function snapshot(path: string): Promise<Snapshot | undefined> {
  const settings = record(parseJson(await readFile(path, 'utf8')))
  const usage = record(settings['tokenUsage'])
  const input = count(usage['inputTokens'])
  const reasoning = count(usage['thinkingTokens'])
  const output = count(usage['outputTokens']) + reasoning
  const cacheWrite = count(usage['cacheCreationTokens'])
  const cacheRead = count(usage['cacheReadTokens'])
  const sum = input + output + cacheWrite + cacheRead
  const tokens = Math.max(sum, count(usage['totalTokens']))
  if (!tokens) return undefined
  const locked = normalizeProvider(settings['providerLock'])
  const logged = text(settings['model']) ?? (await sidecarModel(path))
  const model = modelName(
    (logged ? normalizeModel(logged) : '') || defaultModel(locked),
  )
  const provider = locked === 'unknown' ? inferProvider(model) : locked
  const loggedMs = timestamp(settings['providerLockTimestamp'])
  const ms = Number.isFinite(loggedMs) ? loggedMs : (await stat(path)).mtimeMs
  const parts: Partial<
    Record<
      'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning',
      number
    >
  > = {}
  if (sum > 0) {
    for (const [key, source] of [
      ['input', 'inputTokens'],
      ['cacheRead', 'cacheReadTokens'],
      ['cacheWrite', 'cacheCreationTokens'],
      ['reasoning', 'thinkingTokens'],
    ] as const) {
      if (typeof usage[source] === 'number') parts[key] = count(usage[source])
    }
    if (
      typeof usage['outputTokens'] === 'number' ||
      typeof usage['thinkingTokens'] === 'number'
    )
      parts.output = output
  }
  return {
    ms,
    row: {
      date: kstDateOf(ms),
      tool: 'droid',
      model,
      provider,
      tokens,
      ...parts,
    },
  }
}

export async function readDroid(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['DROID_SESSIONS_DIR'],
      [join(options.home, '.factory/sessions')],
      options.home,
    )
    const paths: string[] = []
    for (const root of roots)
      for await (const path of files(root))
        if (path.endsWith('.settings.json')) paths.push(path)
    const sessions = new Map<string, Snapshot>()
    for (const path of paths.toSorted()) {
      try {
        const parsed = await snapshot(path)
        const id = basename(path, '.settings.json')
        if (parsed && parsed.ms >= (sessions.get(id)?.ms ?? -Infinity))
          sessions.set(id, parsed)
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
    // Settings are cumulative: the whole latest session snapshot belongs to one date.
    return capped(
      [...sessions.values()]
        .filter((event) => event.ms >= options.sinceMs)
        .map((event) => event.row),
      failure,
    )
  } catch (error) {
    return unsupported(error, failure)
  }
}
