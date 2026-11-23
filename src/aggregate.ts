import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
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
export const MAX_ROW_TOKENS = 100_000_000_000
export type UsageRow = {
  readonly date: string
  readonly tool: Tool
  readonly model: string
  readonly tokens: number
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

export function aggregate(rows: readonly UsageRow[]): UsageRow[] {
  // Mutable accumulator; only the projected four-field contract leaves this module.
  const totals = new Map<string, UsageRow>()
  for (const row of rows) {
    const model = modelName(row.model)
    const key = JSON.stringify([row.date, row.tool, model])
    const tokens = (totals.get(key)?.tokens ?? 0) + row.tokens
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > MAX_ROW_TOKENS)
      throw new MeterError(
        '토큰 합계가 서버 허용 범위(0~100,000,000,000)를 벗어나요.',
      )
    totals.set(key, { date: row.date, tool: row.tool, model, tokens })
  }
  return [...totals.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.tool.localeCompare(b.tool) ||
      a.model.localeCompare(b.model),
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
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) yield parseJson(line)
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
