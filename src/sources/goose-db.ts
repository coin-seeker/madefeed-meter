import type {
  SqliteReaderInput,
  SqliteReaderResult,
  SqliteTotal,
} from './sqlite-reader'

// Serialized into a worker; runtime dependencies must stay inside this function.
export function gooseWorker(input: SqliteReaderInput): SqliteReaderResult {
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const totals = new Map<string, SqliteTotal>()
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : 0
    const timestamp = (value: unknown): number => {
      const text = typeof value === 'string' ? value.trim() : ''
      const numeric =
        typeof value === 'number'
          ? value
          : /^\d+$/.test(text)
            ? Number(text)
            : NaN
      if (Number.isFinite(numeric))
        return numeric < 1e10 ? numeric * 1000 : numeric
      const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text
      return utc ? Date.parse(utc) : NaN
    }
    for (const path of input.paths) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
        const query =
          db.prepare(`SELECT id, model_config_json, provider_name, created_at,
          total_tokens, input_tokens, output_tokens, accumulated_total_tokens,
          accumulated_input_tokens, accumulated_output_tokens FROM sessions
          WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''`)
        for (const row of query.iterate()) {
          if (
            typeof row['id'] !== 'string' ||
            !row['id'].trim() ||
            typeof row['model_config_json'] !== 'string'
          )
            continue
          let config: unknown
          try {
            config = JSON.parse(row['model_config_json'])
          } catch (error) {
            if (error instanceof SyntaxError) continue
            throw error
          }
          if (
            typeof config !== 'object' ||
            config === null ||
            !('model_name' in config) ||
            typeof config.model_name !== 'string' ||
            !config.model_name.trim()
          )
            continue
          const ms = timestamp(row['created_at'])
          if (
            !Number.isFinite(ms) ||
            ms <= 0 ||
            ms < input.sinceMs ||
            !Number.isFinite(new Date(ms + 32400000).getTime())
          )
            continue
          const model = config.model_name.trim()
          const provider =
            typeof row['provider_name'] === 'string'
              ? row['provider_name'].trim()
              : null
          const fresh =
            number(row['accumulated_input_tokens']) ||
            number(row['input_tokens'])
          const output =
            number(row['accumulated_output_tokens']) ||
            number(row['output_tokens'])
          const tokens = Math.max(
            number(row['accumulated_total_tokens']) ||
              number(row['total_tokens']),
            fresh + output,
          )
          if (tokens === 0) continue
          const date = new Date(ms + 32400000).toISOString().slice(0, 10)
          const key = JSON.stringify([date, model, provider])
          const previous = totals.get(key)
          const partInput = (previous?.input ?? 0) + fresh
          const partOutput = (previous?.output ?? 0) + output
          totals.set(key, {
            date,
            model,
            provider,
            tokens: (previous?.tokens ?? 0) + tokens,
            ...(partInput + partOutput > 0
              ? { input: partInput, output: partOutput }
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
