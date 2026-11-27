import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { directory, parseJson, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { parseCline } from './cline-parse'
import { listRoots } from './roots'
import { capped } from './row-cap'

const failure = 'Cline 기록을 읽지 못해 이번에는 빼고 올려요.'
const editors = [
  'Code',
  'Code - Insiders',
  'Cursor',
  'Windsurf',
  'VSCodium',
] as const

function defaults(options: SourceOptions): string[] {
  const env = options.env ?? {}
  const bases = [
    join(options.home, 'Library/Application Support'),
    env['XDG_CONFIG_HOME']?.trim() || join(options.home, '.config'),
    env['APPDATA']?.trim() ||
      join(env['USERPROFILE']?.trim() || options.home, 'AppData/Roaming'),
  ]
  return [
    join(options.home, '.cline'),
    ...bases.flatMap((base) =>
      editors.map((editor) =>
        join(base, editor, 'User/globalStorage/saoudrizwan.claude-dev'),
      ),
    ),
  ]
}

export async function readCline(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['CLINE_DATA_DIR'],
      defaults(options),
      options.home,
    )
    const seen = new Set<string>()
    const rows: UsageRow[] = []
    for (const root of roots) {
      for (const layout of [
        'tasks',
        'data/tasks',
        'data/sessions',
        'sessions',
      ]) {
        const base = join(root, layout)
        if (!(await directory(base))) continue
        const sessions = (await readdir(base)).sort()
        for (const session of sessions) {
          const dir = join(base, session)
          if (!(await directory(dir))) continue
          const kind = layout.endsWith('tasks') ? 'extension' : 'cli'
          const path = join(
            dir,
            kind === 'extension'
              ? 'ui_messages.json'
              : `${session}.messages.json`,
          )
          try {
            if (!(await stat(path)).isFile()) continue
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              continue
            throw error
          }
          const canonical = await realpath(path)
          if (seen.has(canonical)) continue
          seen.add(canonical)
          const entries = parseCline(
            parseJson(await readFile(path, 'utf8')),
            kind,
          )
          for (const entry of entries)
            if (entry.ms >= options.sinceMs) rows.push(entry.row)
        }
      }
    }
    return capped(rows, failure)
  } catch (error) {
    return unsupported(error, failure)
  }
}
