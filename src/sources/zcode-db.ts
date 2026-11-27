import type {
  SqliteReaderInput,
  SqliteReaderResult,
  SqliteTotal,
} from './sqlite-reader'

// Serialized into a worker; runtime dependencies must stay inside this function.
export function zcodeWorker(input: SqliteReaderInput): SqliteReaderResult {
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const totals = new Map<string, SqliteTotal>()
    const ids = new Set<string>()
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : 0
    for (const path of input.paths) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
        const columns = new Set(
          db
            .prepare('PRAGMA table_info(model_usage)')
            .all()
            .map((row) => row['name']),
        )
        const sessionColumns = new Set(
          db
            .prepare('PRAGMA table_info(session)')
            .all()
            .map((row) => row['name']),
        )
        if (
          !['id', 'directory'].every((key) => sessionColumns.has(key)) ||
          ![
            'id',
            'session_id',
            'started_at',
            'model_id',
            'status',
            'input_tokens',
            'output_tokens',
          ].every((key) => columns.has(key))
        )
          return { error: true }
        const optional = (name: string, fallback: string) =>
          columns.has(name) ? `m.${name}` : fallback
        const query =
          db.prepare(`SELECT m.id, m.session_id, m.started_at AS ms, m.model_id AS model,
          m.input_tokens AS input, m.output_tokens AS output,
          ${optional('cache_creation_input_tokens', '0')} AS cache_write,
          ${optional('cache_read_input_tokens', '0')} AS cache_read,
          ${optional('computed_total_tokens', 'm.input_tokens + m.output_tokens')} AS total,
          ${optional('provider_id', 'NULL')} AS provider, s.directory,
          ${sessionColumns.has('version') ? 's.version' : 'NULL'} AS version
          FROM model_usage m LEFT JOIN session s ON s.id=m.session_id WHERE m.status='completed'`)
        for (const row of query.iterate()) {
          const id = row['id'],
            session = row['session_id'],
            model = row['model'],
            ms = row['ms']
          if (
            typeof id !== 'string' ||
            !id.trim() ||
            typeof session !== 'string' ||
            !session.trim() ||
            typeof model !== 'string' ||
            !model.trim() ||
            typeof ms !== 'number' ||
            !Number.isFinite(ms) ||
            ms <= 0 ||
            ms < input.sinceMs ||
            !Number.isFinite(new Date(ms + 32400000).getTime())
          )
            continue
          const prompt = number(row['input']),
            output = number(row['output'])
          const cacheRead = Math.min(number(row['cache_read']), prompt)
          const cacheWrite = Math.min(
            number(row['cache_write']),
            prompt - cacheRead,
          )
          const fresh = prompt - cacheRead - cacheWrite
          const tokens = Math.max(number(row['total']), prompt + output)
          if (tokens === 0 || ids.has(id)) continue
          ids.add(id)
          const rawProvider =
            typeof row['provider'] === 'string'
              ? row['provider'].trim().replace(/^builtin:/, '')
              : null
          const provider =
            rawProvider &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              rawProvider,
            )
              ? rawProvider
              : null
          const date = new Date(ms + 32400000).toISOString().slice(0, 10)
          const key = JSON.stringify([date, model.trim(), provider])
          const previous = totals.get(key)
          const parts =
            (previous?.input ?? 0) +
            (previous?.output ?? 0) +
            (previous?.cacheRead ?? 0) +
            (previous?.cacheWrite ?? 0) +
            prompt +
            output
          totals.set(key, {
            date,
            model: model.trim(),
            provider,
            tokens: (previous?.tokens ?? 0) + tokens,
            ...(parts > 0
              ? {
                  input: (previous?.input ?? 0) + fresh,
                  output: (previous?.output ?? 0) + output,
                  cacheRead: (previous?.cacheRead ?? 0) + cacheRead,
                  cacheWrite: (previous?.cacheWrite ?? 0) + cacheWrite,
                }
              : {}),
          })
        }
      } finally {
        db.close()
      }
    }
    return { totals: [...totals.values()] }
  } catch (error) {
    if (error instanceof Error) return { error: true }
    throw error
  }
}
