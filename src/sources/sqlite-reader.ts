import { realpath, stat } from 'node:fs/promises'
import { aggregate, modelName, providerName } from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { capped } from './row-cap'
import { runSqliteWorker } from './sqlite-worker'
import { inferProvider } from './vendor'

export type SqliteReaderOptions = SourceOptions & {
  readonly timeoutMs?: number
}
export type SqliteReaderInput = {
  readonly paths: readonly string[]
  readonly sinceMs: number
}
export type SqliteTotal = Omit<UsageRow, 'tool' | 'provider'> & {
  readonly provider: string | null
}
export type SqliteReaderResult =
  | { readonly totals: readonly SqliteTotal[] }
  | { readonly error: true }
type Reader = {
  readonly tool: 'goose' | 'kilo' | 'zcode'
  readonly label: string
  readonly paths: () => Promise<readonly string[]>
  readonly worker: (input: SqliteReaderInput) => SqliteReaderResult
}

export async function sqlitePaths(
  candidates: readonly string[],
): Promise<string[]> {
  const paths = new Set<string>()
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) paths.add(await realpath(path))
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        continue
      throw error
    }
  }
  return [...paths]
}

export async function readSqliteSource(
  options: SqliteReaderOptions,
  reader: Reader,
): Promise<SourceResult> {
  const reason = `${reader.label} 기록을 읽지 못해 이번에는 빼고 올려요.`
  const failed: SourceResult = { supported: false, reason, rows: [] }
  try {
    const paths = await reader.paths()
    if (paths.length === 0) return { supported: true, rows: [] }
    const result = await runSqliteWorker(
      reader.worker,
      { paths, sinceMs: options.sinceMs },
      options.timeoutMs,
    )
    if ('error' in result) return failed
    const rows = result.totals.map((row): UsageRow => ({
      ...row,
      tool: reader.tool,
      model: modelName(row.model),
      provider: providerName(row.provider?.trim() || inferProvider(row.model)),
    }))
    const checked = capped(rows, reason)
    return checked.supported
      ? { supported: true, rows: aggregate(rows) }
      : failed
  } catch (error) {
    if (error instanceof Error) return failed
    throw error
  }
}
