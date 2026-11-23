export type HermesKey = readonly [
  dbIndex: number,
  session: string,
  model: string,
  provider: string,
  firstMs: number,
  lastMs: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning: number,
]
export type HermesDatabaseResult =
  | { readonly keys: readonly HermesKey[] }
  | { readonly error: true }

export function hermesWorker(input: {
  readonly paths: readonly string[]
  readonly sinceMs: number
}): HermesDatabaseResult {
  // This function is stringified into an eval worker: all runtime dependencies are local.
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const keys: HermesKey[] = []
    const seen = new Set<string>()
    const normal = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.max(0, Math.trunc(v))
        : 0
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    const time = (v: unknown) => (typeof v === 'number' ? v * 1000 : NaN)
    const columns = [
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
    ] as const
    for (const [dbIndex, path] of input.paths.entries()) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200; BEGIN')
        const tables = new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r['name']),
        )
        if (!tables.has('sessions')) return { error: true }
        const hasUsage = tables.has('session_model_usage')
        if (hasUsage) {
          const rows = db
            .prepare(`SELECT u.session_id, u.model, u.billing_provider,
            MIN(COALESCE(u.first_seen,s.started_at)) AS first,
            MAX(COALESCE(u.last_seen,s.started_at)) AS last,
            ${columns.map((c) => `SUM(u.${c}) AS ${c}`).join(',')}
            FROM session_model_usage u LEFT JOIN sessions s ON s.id=u.session_id
            GROUP BY u.session_id,u.model,u.billing_provider`)
            .all()
          for (const row of rows) {
            const session = text(row['session_id']),
              model = text(row['model'])
            const first = time(row['first']),
              last = time(row['last'])
            if (
              seen.has(session) ||
              !model.trim() ||
              !Number.isFinite(first) ||
              !(last >= input.sinceMs)
            )
              continue
            const i = normal(row['input_tokens']),
              o = normal(row['output_tokens'])
            const r = normal(row['cache_read_tokens']),
              w = normal(row['cache_write_tokens'])
            if (i + o + r + w === 0) continue
            keys.push([
              dbIndex,
              session,
              model,
              text(row['billing_provider']),
              first,
              last,
              i,
              o,
              r,
              w,
              normal(row['reasoning_tokens']),
            ])
          }
        }
        const residuals = db
          .prepare(
            hasUsage
              ? `SELECT s.*,
          ${columns.map((c) => `s.${c} - COALESCE(u.${c},0) AS residual_${c}`).join(',')}
          FROM sessions s LEFT JOIN (SELECT session_id,
          ${columns.map((c) => `SUM(${c}) AS ${c}`).join(',')}
          FROM session_model_usage GROUP BY session_id) u ON u.session_id=s.id
          WHERE s.started_at >= ?`
              : 'SELECT * FROM sessions WHERE started_at >= ?',
          )
          .all(input.sinceMs / 1000)
        for (const row of residuals) {
          const session = text(row['id']),
            model = text(row['model']),
            first = time(row['started_at'])
          if (seen.has(session) || !model.trim()) continue
          const remaining = (c: (typeof columns)[number]) =>
            normal(row[hasUsage ? `residual_${c}` : c])
          const i = remaining('input_tokens'),
            o = remaining('output_tokens')
          const r = remaining('cache_read_tokens'),
            w = remaining('cache_write_tokens')
          if (i + o + r + w === 0) continue
          keys.push([
            dbIndex,
            session,
            model,
            text(row['billing_provider']),
            first,
            first,
            i,
            o,
            r,
            w,
            remaining('reasoning_tokens'),
          ])
        }
        for (const row of db.prepare('SELECT id FROM sessions').all())
          seen.add(text(row['id']))
        if (hasUsage)
          for (const row of db
            .prepare('SELECT DISTINCT session_id FROM session_model_usage')
            .all())
            seen.add(text(row['session_id']))
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    }
    return { keys }
  } catch {
    // no-excuse-ok: catch -- worker boundary returns no private SQLite diagnostics or partial keys.
    return { error: true }
  }
}
