import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { Decompressor } from './zstd'

export type Tool =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'pi'
  | 'omp'
  | 'omo'
  | 'agy'
  | 'hermes'
  | 'grok'
export const MAX_ROW_TOKENS = 100_000_000_000
export type UsageRow = {
  readonly date: string
  readonly tool: Tool
  readonly model: string
  readonly provider: string
  readonly tokens: number
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}
export type SourceOptions = {
  readonly home: string
  readonly sinceMs: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Omitted: detect at run time. `null`: this runtime cannot read zstd. */
  readonly zstd?: Decompressor | null
}
export type SourceResult = {
  readonly supported: boolean
  readonly reason?: string
  readonly rows: readonly UsageRow[]
}
export type UsagePayload = {
  readonly deviceName: string
  readonly rows: readonly UsageRow[]
}

export class MeterError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
export function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}
export function timestamp(value: unknown): number {
  return typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Date.parse(value)
      : NaN
}
export function modelName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(value)
    ? value
    : 'unknown'
}
export function providerName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(value)
    ? value.toLowerCase()
    : 'unknown'
}

const partNames = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
] as const

export function aggregate(rows: readonly UsageRow[]): UsageRow[] {
  // Mutable accumulator; only explicitly projected usage fields leave this module.
  const totals = new Map<string, UsageRow>()
  for (const row of rows) {
    const model = modelName(row.model)
    const provider = providerName(row.provider)
    const key = JSON.stringify([row.date, row.tool, model, provider])
    const previous = totals.get(key)
    const tokens = (previous?.tokens ?? 0) + row.tokens
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > MAX_ROW_TOKENS)
      throw new MeterError(
        '토큰 합계가 서버 허용 범위(0~100,000,000,000)를 벗어나요.',
      )
    const parts: Partial<Record<(typeof partNames)[number], number>> = {}
    for (const name of partNames) {
      const before = previous?.[name]
      const value = row[name]
      if (before !== undefined || value !== undefined)
        parts[name] = (before ?? 0) + (value ?? 0)
    }
    totals.set(key, {
      date: row.date,
      tool: row.tool,
      model,
      provider,
      tokens,
      ...parts,
    })
  }
  return [...totals.values()]
    .map((row) => {
      const { date, tool, model, provider, tokens } = row
      const parts: Partial<Record<(typeof partNames)[number], number>> = {}
      for (const name of partNames) {
        const value = row[name]
        if (
          value !== undefined &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= MAX_ROW_TOKENS
        )
          parts[name] = value
      }
      return { date, tool, model, provider, tokens, ...parts }
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.tool.localeCompare(b.tool) ||
        a.model.localeCompare(b.model) ||
        a.provider.localeCompare(b.provider),
    )
}
export function payload(
  deviceName: string,
  rows: readonly UsageRow[],
): UsagePayload {
  return { deviceName, rows: aggregate(rows) }
}

export async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}
export async function* files(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}
export async function* jsonLines(path: string): AsyncGenerator<unknown> {
  for await (const line of textLines(path)) yield parseJson(line)
}
export class ZstdUnavailableError extends MeterError {
  constructor() {
    super(
      '압축된 Codex 기록을 읽으려면 Node.js 22.15 이상이 필요해서 이번에는 Codex를 빼고 올려요.',
    )
  }
}
function cleanLine(line: string): string {
  const start = line.charCodeAt(0) === 0xfeff ? 1 : 0
  const end = line.endsWith('\r') ? line.length - 1 : line.length
  return start === 0 && end === line.length ? line : line.slice(start, end)
}
export async function* textLines(
  path: string,
  zstd?: Decompressor,
): AsyncGenerator<string> {
  if (path.endsWith('.zst')) {
    if (!zstd) throw new ZstdUnavailableError()
    const stream = pipeline(createReadStream(path), zstd(), () => {
      // pipeline destroys both ends on failure; async iteration observes the error.
    })
    const decoder = new StringDecoder('utf8')
    // One rollout line can be tens of megabytes: keep its pieces apart and
    // look for the newline only in the piece that just arrived.
    const parts: string[] = []
    try {
      const chunks: AsyncIterable<Uint8Array> = stream
      for await (const chunk of chunks) {
        const text = decoder.write(chunk)
        let start = 0
        let end = text.indexOf('\n')
        while (end >= 0) {
          parts.push(text.slice(start, end))
          yield cleanLine(parts.join(''))
          parts.length = 0
          start = end + 1
          end = text.indexOf('\n', start)
        }
        if (start < text.length) parts.push(text.slice(start))
      }
      const rest = parts.join('') + decoder.end()
      if (rest) yield cleanLine(rest)
    } finally {
      stream.destroy()
    }
    return
  }
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) yield cleanLine(line)
  } finally {
    reader.close()
    stream.destroy()
  }
}
export async function recentFile(
  path: string,
  sinceMs: number,
): Promise<boolean> {
  return (await stat(path)).mtimeMs >= sinceMs
}
export function unsupported(error: unknown, reason: string): SourceResult {
  if (error instanceof Error) return { supported: false, reason, rows: [] }
  throw error
}
