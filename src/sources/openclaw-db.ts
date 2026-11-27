import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { directory } from '../aggregate'

export async function clawPaths(roots: readonly string[]) {
  const json: string[] = [],
    db: string[] = []
  const seen = new Set<string>()
  async function walk(path: string): Promise<void> {
    const identity = await realpath(path)
    if (seen.has(identity)) return
    seen.add(identity)
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const item of await readdir(path)) await walk(join(path, item))
    } else if (info.isFile() && /\.jsonl(?:$|\.(?:deleted|reset)\.)/.test(path))
      json.push(path)
  }
  for (const root of roots) {
    await walk(root)
    const agents = join(root, 'agents')
    if (!(await directory(agents)) || (await lstat(agents)).isSymbolicLink())
      continue
    for (const agent of await readdir(agents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue
      const dir = join(agents, agent.name, 'agent')
      if (!(await directory(dir)) || (await lstat(dir)).isSymbolicLink())
        continue
      for (const file of await readdir(dir, { withFileTypes: true }))
        if (file.isFile() && file.name === 'openclaw-agent.sqlite')
          db.push(join(dir, file.name))
    }
  }
  return { json: json.sort(), db: [...new Set(db)].sort() }
}

export type ClawDbRow = {
  readonly session: string
  readonly created: number
  readonly event: unknown
}
export function clawWorker(
  paths: readonly string[],
): { readonly entries: readonly ClawDbRow[] } | { readonly error: true } {
  // Stringified worker: project only accounting fields, never message bodies.
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const entries: ClawDbRow[] = []
    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    const object = (value: unknown): Record<string, unknown> =>
      isObject(value) ? value : {}
    const pick = (source: Record<string, unknown>, keys: readonly string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      )
    for (const path of paths) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200; BEGIN')
        for (const row of db
          .prepare(
            'SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id, seq',
          )
          .iterate()) {
          if (
            typeof row['event_json'] !== 'string' ||
            typeof row['session_id'] !== 'string'
          )
            continue
          let parsed: unknown
          try {
            parsed = JSON.parse(row['event_json'])
          } catch (error) {
            if (error instanceof SyntaxError) continue
            throw error
          }
          const event = object(parsed),
            message = object(event['message']),
            usage = object(message['usage'])
          entries.push({
            session: row['session_id'],
            created:
              typeof row['created_at'] === 'number' ? row['created_at'] : NaN,
            event: {
              ...pick(event, [
                'type',
                'id',
                'timestamp',
                'modelId',
                'model',
                'provider',
                'customType',
              ]),
              data:
                event['data'] === undefined
                  ? undefined
                  : pick(object(event['data']), [
                      'modelId',
                      'model',
                      'provider',
                    ]),
              message: {
                ...pick(message, [
                  'role',
                  'timestamp',
                  'modelId',
                  'model',
                  'provider',
                ]),
                usage: {
                  ...pick(usage, [
                    'input',
                    'output',
                    'cacheRead',
                    'cacheWrite',
                    'totalTokens',
                  ]),
                  cost: pick(object(usage['cost']), ['total']),
                },
              },
            },
          })
        }
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    }
    return { entries }
  } catch {
    // no-excuse-ok: catch -- SQLite boundary returns no diagnostics or partial private data.
    return { error: true }
  }
}
