import { basename, join } from 'node:path'
import { parseJson, textLines, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { clawPaths, clawWorker } from './openclaw-db'
import { ClawFold } from './openclaw-parse'
import type { ClawEntry } from './openclaw-parse'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { runSqliteWorker } from './sqlite-worker'

const failure = 'OpenClaw 기록을 읽지 못해 이번에는 빼고 올려요.'
export async function readOpenClaw(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['OPENCLAW_DIR'],
      ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'].map((name) =>
        join(options.home, name),
      ),
      options.home,
    )
    const paths = await clawPaths(roots)
    const entries: ClawEntry[] = []
    const identities = new Set<string>(),
      content = new Set<string>(),
      migrations = new Set<string>()
    const folds = new Map<string, ClawFold>()
    if (paths.db.length) {
      const result = await runSqliteWorker(clawWorker, paths.db)
      if ('error' in result)
        return { supported: false, reason: failure, rows: [] }
      for (const item of result.entries) {
        let fold = folds.get(item.session)
        if (!fold) {
          fold = new ClawFold(item.session)
          folds.set(item.session, fold)
        }
        const entry = fold.accept(item.event, item.created)
        if (!entry) continue
        const key = entry.id
          ? JSON.stringify([entry.session, entry.id])
          : entry.content
        const seen = entry.id ? identities : content
        if (seen.has(key)) continue
        seen.add(key)
        migrations.add(entry.migration)
        entries.push(entry)
      }
    }
    for (const path of paths.json) {
      const fold = new ClawFold(basename(path).split('.jsonl')[0] ?? 'unknown')
      for await (const line of textLines(path)) {
        const entry = fold.accept(parseJson(line))
        if (
          !entry ||
          migrations.has(entry.migration) ||
          content.has(entry.content)
        )
          continue
        content.add(entry.content)
        entries.push(entry)
      }
    }
    return capped(
      entries
        .filter((entry) => entry.ms >= options.sinceMs)
        .map((entry) => entry.row),
      failure,
    )
  } catch (error) {
    return unsupported(error, failure)
  }
}
