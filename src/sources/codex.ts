import { join, basename, resolve } from 'node:path'
import {
  count,
  directory,
  files,
  textLines,
  parseJson,
  ZstdUnavailableError,
  recentFile,
  record,
  timestamp,
  modelName,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { zstdDecompressor } from '../zstd'
import type { Decompressor } from '../zstd'

export async function* rolloutLines(
  path: string,
  zstd?: Decompressor,
): AsyncGenerator<string> {
  let read = false
  try {
    for await (const line of textLines(path, zstd)) {
      read = true
      yield line
    }
  } catch (error) {
    if (
      read ||
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error
    yield* textLines(counterpart(path), zstd)
  }
}

function counterpart(path: string): string {
  return path.endsWith('.zst') ? path.slice(0, -4) : `${path}.zst`
}

/** The file to read for a listed rollout: Codex may compress it meanwhile. */
export async function recentRollout(
  path: string,
  sinceMs: number,
): Promise<string | undefined> {
  for (const candidate of [path, counterpart(path)]) {
    try {
      return (await recentFile(candidate, sinceMs)) ? candidate : undefined
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error
    }
  }
  return undefined
}

async function rollouts(options: SourceOptions): Promise<readonly string[]> {
  const homes = new Map<string, string>()
  for (const home of [
    join(options.home, '.codex'),
    ...(options.env?.['CODEX_HOME']?.split(',') ?? []),
  ])
    if (home) homes.set(resolve(home), home)
  const chosen = new Map<string, string>()
  for (const home of homes.values()) {
    for (const name of ['sessions', 'archived_sessions']) {
      const root = join(home, name)
      if (!(await directory(root))) continue
      for await (const path of files(root)) {
        const name = basename(path)
        if (
          !name.startsWith('rollout-') ||
          !(name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))
        )
          continue
        const key = name.endsWith('.zst') ? name.slice(0, -4) : name
        if (!chosen.has(key) || name.endsWith('.jsonl')) chosen.set(key, path)
      }
    }
  }
  const recent: string[] = []
  for (const path of chosen.values()) {
    const present = await recentRollout(path, options.sinceMs)
    if (present) recent.push(present)
  }
  return recent
}

export async function readCodex(options: SourceOptions): Promise<SourceResult> {
  const rows: UsageRow[] = []
  try {
    const paths = await rollouts(options)
    const zstd =
      options.zstd === undefined
        ? zstdDecompressor()
        : (options.zstd ?? undefined)
    if (!zstd && paths.some((path) => path.endsWith('.zst')))
      throw new ZstdUnavailableError()
    for (const path of paths) {
      let model = 'unknown'
      let previous = 0
      for await (const line of rolloutLines(path, zstd)) {
        if (!line.includes('"turn_context"') && !line.includes('"token_count"'))
          continue
        const event = record(parseJson(line))
        const data = record(event['payload'])
        if (event['type'] === 'turn_context') {
          model = modelName(data['model'])
          continue
        }
        if (event['type'] !== 'event_msg' || data['type'] !== 'token_count')
          continue
        const info = record(data['info'])
        const total = record(info['total_token_usage'])['total_tokens']
        if (
          typeof total !== 'number' ||
          !Number.isSafeInteger(total) ||
          total < 0
        )
          continue
        const delta =
          total >= previous
            ? total - previous
            : count(record(info['last_token_usage'])['total_tokens'])
        previous = total
        const ms = timestamp(event['timestamp'])
        if (Number.isFinite(ms) && ms >= options.sinceMs && delta > 0)
          rows.push({
            date: kstDateOf(ms),
            tool: 'codex',
            model,
            tokens: delta,
          })
      }
    }
    return { supported: true, rows }
  } catch (error) {
    if (error instanceof ZstdUnavailableError)
      return { supported: false, rows: [], reason: error.message }
    return unsupported(error, 'Codex 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
