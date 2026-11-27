import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { directory, jsonLines, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { copilotEntries, copilotRows } from './copilot-session'
import type { CopilotEntry } from './copilot-session'
import { singleRoot } from './roots'
import { capped } from './row-cap'

const failure = 'Copilot CLI 기록을 읽지 못해 이번에는 빼고 올려요.'
export async function readCopilot(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const root = singleRoot(
      options.env?.['COPILOT_HOME'],
      join(options.home, '.copilot'),
    )
    const expanded =
      root === '~'
        ? options.home
        : root.startsWith('~/')
          ? join(options.home, root.slice(2))
          : root
    const sessions = join(expanded, 'session-state')
    if (!(await directory(sessions))) return { supported: true, rows: [] }
    const entries: CopilotEntry[] = []
    for (const session of (
      await readdir(sessions, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!session.isDirectory()) continue
      const dir = join(sessions, session.name)
      if (!(await readdir(dir)).includes('events.jsonl')) continue
      let line = 0
      for await (const value of jsonLines(join(dir, 'events.jsonl'))) {
        entries.push(
          ...copilotEntries(value, { session: session.name, line: ++line }),
        )
      }
    }
    return capped(copilotRows(entries, options.sinceMs), failure)
  } catch (error) {
    return unsupported(error, failure)
  }
}
