import { basename, dirname, join } from 'node:path'
import { directory, files, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { zstdDecompressor } from '../zstd'
import { dshSession, preferDsh } from './dsh-parse'
import type { DshEntry } from './dsh-parse'
import { listRoots } from './roots'
import { capped } from './row-cap'

const failure = 'DeepSeek Harness 기록을 읽지 못해 이번에는 빼고 올려요.'
const compressedFailure =
  '압축된 DeepSeek Harness 기록을 읽으려면 Node.js 22.15 이상이 필요해서 이번에는 DeepSeek Harness를 빼고 올려요.'
export async function readDsh(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['DSH_HOME'],
      [join(options.home, '.dsh')],
      options.home,
    )
    const generations = new Map<
      string,
      { readonly path: string; readonly generation: number }
    >()
    for (const root of roots) {
      const sessions = join(root, 'sessions')
      if (!(await directory(sessions))) continue
      const paths: string[] = []
      for await (const path of files(sessions)) paths.push(path)
      for (const path of paths.sort()) {
        const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(
          basename(path),
        )
        if (!match) continue
        const generation = Number(match[1] ?? 0),
          key = dirname(path)
        const previous = generations.get(key)
        if (!previous || generation > previous.generation)
          generations.set(key, { path, generation })
      }
    }
    const zstd =
      options.zstd === undefined
        ? zstdDecompressor()
        : (options.zstd ?? undefined)
    const entries = new Map<string, DshEntry>()
    for (const { path } of generations.values()) {
      if (path.endsWith('.zstd') && !zstd)
        return { supported: false, rows: [], reason: compressedFailure }
      for (const entry of await dshSession(path, zstd)) {
        const previous = entries.get(entry.key)
        if (!previous || preferDsh(entry, previous))
          entries.set(entry.key, entry)
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
