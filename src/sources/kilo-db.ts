import type {
  SqliteReaderInput,
  SqliteReaderResult,
  SqliteTotal,
} from './sqlite-reader'

// Serialized into a worker; runtime dependencies must stay inside this function.
export function kiloWorker(input: SqliteReaderInput): SqliteReaderResult {
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
        const numeric = (field: string) =>
          `CASE WHEN json_type(data,'${field}') IN ('integer','real') THEN json_extract(data,'${field}') ELSE 0 END`
        const query = db.prepare(`SELECT id AS row_id, session_id,
          json_extract(data,'$.id') AS id, json_extract(data,'$.session_id') AS payload_session,
          json_extract(data,'$.role') AS role, json_type(data,'$.tokens') AS token_type,
          json_extract(data,'$.time.created') AS ms, json_extract(data,'$.modelID') AS model,
          json_extract(data,'$.providerID') AS provider,
          ${numeric('$.tokens.input')} AS input, ${numeric('$.tokens.output')} AS output,
          ${numeric('$.tokens.reasoning')} AS reasoning, ${numeric('$.tokens.total')} AS total,
          ${numeric('$.tokens.cache.read')} AS cache_read, ${numeric('$.tokens.cache.write')} AS cache_write
          FROM message WHERE json_valid(data)`)
        for (const row of query.iterate()) {
          if (row['role'] !== 'assistant' || row['token_type'] !== 'object')
            continue
          const model = row['model'],
            ms = row['ms']
          if (
            typeof model !== 'string' ||
            !model.trim() ||
            typeof ms !== 'number' ||
            !Number.isFinite(ms) ||
            ms <= 0 ||
            ms < input.sinceMs ||
            !Number.isFinite(new Date(ms + 32400000).getTime())
          )
            continue
          const fresh = number(row['input']),
            reasoning = number(row['reasoning'])
          const output = number(row['output']) + reasoning
          const cacheRead = number(row['cache_read']),
            cacheWrite = number(row['cache_write'])
          const parts = fresh + output + cacheRead + cacheWrite
          const tokens = Math.max(number(row['total']), parts)
          if (tokens === 0) continue
          const id =
            typeof row['id'] === 'string' && row['id'].trim()
              ? row['id'].trim()
              : `${path}:${row['row_id']}`
          if (ids.has(id)) continue
          ids.add(id)
          const date = new Date(ms + 32400000).toISOString().slice(0, 10)
          const provider =
            typeof row['provider'] === 'string' ? row['provider'].trim() : null
          const key = JSON.stringify([date, model.trim(), provider])
          const previous = totals.get(key)
          const sumParts =
            (previous?.input ?? 0) +
            (previous?.output ?? 0) +
            (previous?.cacheRead ?? 0) +
            (previous?.cacheWrite ?? 0) +
            parts
          totals.set(key, {
            date,
            model: model.trim(),
            provider,
            tokens: (previous?.tokens ?? 0) + tokens,
            ...(sumParts > 0
              ? {
                  input: (previous?.input ?? 0) + fresh,
                  output: (previous?.output ?? 0) + output,
                  cacheRead: (previous?.cacheRead ?? 0) + cacheRead,
                  cacheWrite: (previous?.cacheWrite ?? 0) + cacheWrite,
                  reasoning: (previous?.reasoning ?? 0) + reasoning,
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
