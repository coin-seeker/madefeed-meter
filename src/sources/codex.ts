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
  providerName,
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
      let provider = 'unknown'
      let previous = 0
      let previousUsage: Record<string, unknown> = {}
      for await (const line of rolloutLines(path, zstd)) {
        if (
          !line.includes('"turn_context"') &&
          !line.includes('"token_count"') &&
          !line.includes('"session_meta"')
        )
          continue
        const event = record(parseJson(line))
        const data = record(event['payload'])
        if (event['type'] === 'session_meta') {
          provider = providerName(data['model_provider'])
          continue
        }
        if (event['type'] === 'turn_context') {
          model = modelName(data['model'])
          continue
        }
        if (event['type'] !== 'event_msg' || data['type'] !== 'token_count')
          continue
        const info = record(data['info'])
        const cumulative = record(info['total_token_usage'])
        const total = cumulative['total_tokens']
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
        const reset = total < previous
        const usage = reset ? record(info['last_token_usage']) : cumulative
        const difference = (name: string) =>
          Math.max(
            0,
            count(usage[name]) - (reset ? 0 : count(previousUsage[name])),
          )
        const cacheRead = difference('cached_input_tokens')
        const cacheWrite = difference('cache_write_input_tokens')
        const input = Math.max(
          0,
          difference('input_tokens') - cacheRead - cacheWrite,
        )
        const output = difference('output_tokens')
        const reasoning = difference('reasoning_output_tokens')
        const reported =
          (typeof usage['input_tokens'] === 'number' ||
            typeof usage['output_tokens'] === 'number') &&
          [
            'input_tokens',
            'output_tokens',
            'cached_input_tokens',
            'cache_write_input_tokens',
            'reasoning_output_tokens',
          ].some((name) => count(usage[name]) > 0)
        previous = total
        previousUsage = cumulative
        const ms = timestamp(event['timestamp'])
        if (Number.isFinite(ms) && ms >= options.sinceMs && delta > 0)
          rows.push({
            date: kstDateOf(ms),
            tool: 'codex',
            model,
            provider,
            tokens: delta,
            ...(reported
              ? { input, output, cacheRead, cacheWrite, reasoning }
              : {}),
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
