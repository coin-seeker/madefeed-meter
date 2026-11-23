export type DatabaseInput = {
  readonly path: string
  readonly sinceMs: number
  readonly legacyIds: readonly string[]
  readonly excludedIds: readonly string[]
}
type Total = [
  string,
  string,
  string | null,
  number,
  number,
  number,
  number,
  number,
  number,
  boolean,
]
export type DatabaseResult =
  | {
      readonly totals: readonly Readonly<Total>[]
      readonly knownIds: readonly string[]
    }
  | { readonly error: true }

// Stringified into an eval worker: every runtime dependency must live inside.
export function databaseWorker(input: DatabaseInput): DatabaseResult {
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(input.path, { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
      const exists = (table: string) =>
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table),
        )
      const columns = (table: string) =>
        new Set(
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row['name']),
        )
      const number = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? Math.trunc(value)
          : 0
      const ids = new Set<string>()
      const excluded = new Set(input.excludedIds)
      const totals = new Map<string, Total>()
      const numeric = (path: string) =>
        `CASE WHEN json_type(m.data,'${path}') IN ('integer','real') THEN json_extract(m.data,'${path}') ELSE 0 END`
      const projection = (
        model: string,
        provider: string,
      ) => `coalesce(json_extract(m.data,'$.time.created'),m.time_created) AS ms,
        ${provider} AS provider,
        ${model} AS model, json_type(m.data,'$.tokens') AS token_type,
        ${numeric('$.tokens.total')} AS total,
        ${numeric('$.tokens.input')} AS input,
        ${numeric('$.tokens.output')} AS output,
        ${numeric('$.tokens.reasoning')} AS reasoning,
        ${numeric('$.tokens.cache.read')} AS cache_read,
        ${numeric('$.tokens.cache.write')} AS cache_write`
      const add = (row: Record<string, unknown>) => {
        const ms = row['ms']
        const model = row['model']
        const id = row['id']
        if (typeof id === 'string' && (excluded.has(id) || ids.has(id))) return
        if (
          typeof ms !== 'number' ||
          !Number.isFinite(ms) ||
          ms < input.sinceMs ||
          typeof model !== 'string' ||
          row['token_type'] !== 'object'
        )
          return
        const parts = [
          'input',
          'output',
          'reasoning',
          'cache_read',
          'cache_write',
        ].reduce((sum, key) => sum + number(row[key]), 0)
        const tokens = Math.max(parts, number(row['total']))
        if (tokens === 0) return
        const date = new Date(ms + 32_400_000).toISOString().slice(0, 10)
        const provider =
          typeof row['provider'] === 'string' ? row['provider'] : null
        const key = JSON.stringify([date, model, provider])
        const previous = totals.get(key)
        totals.set(key, [
          date,
          model,
          provider,
          (previous?.[3] ?? 0) + tokens,
          (previous?.[4] ?? 0) + number(row['input']),
          (previous?.[5] ?? 0) +
            number(row['output']) +
            number(row['reasoning']),
          (previous?.[6] ?? 0) + number(row['cache_read']),
          (previous?.[7] ?? 0) + number(row['cache_write']),
          (previous?.[8] ?? 0) + number(row['reasoning']),
          (previous?.[9] ?? false) || parts > 0,
        ])
        if (typeof id === 'string') ids.add(id)
      }
      const since = input.sinceMs - 86_400_000
      const hasMessage = exists('message')
      const hasV2 = exists('session_message')
      const hasId = hasMessage && columns('message').has('id')
      if (hasMessage) {
        const fields = `${hasId ? 'm.id' : 'NULL AS id'}, ${projection("json_extract(m.data,'$.modelID')", "json_extract(m.data,'$.providerID')")}`
        let statement
        try {
          statement = db.prepare(
            `SELECT ${fields} FROM session s CROSS JOIN message m ON m.session_id=s.id AND m.time_created >= ?`,
          )
        } catch (error) {
          if (!(error instanceof Error)) throw error
          statement = db.prepare(
            `SELECT ${fields} FROM message m WHERE m.time_created >= ?`,
          )
        }
        for (const row of statement.iterate(since)) add(row)
      }
      if (hasV2) {
        const cutoffs = new Map<string, number>()
        if (
          exists('session_v2') &&
          ['id', 'fork_session_id', 'fork_boundary'].every((key) =>
            columns('session_v2').has(key),
          )
        ) {
          const boundaryRow = db.prepare(
            'SELECT seq FROM session_message WHERE session_id=? AND id=?',
          )
          const before = db.prepare(
            'SELECT MAX(seq) AS seq FROM session_message WHERE session_id=? AND seq<?',
          )
          for (const fork of db
            .prepare(
              'SELECT id,fork_session_id,fork_boundary FROM session_v2 WHERE fork_session_id IS NOT NULL AND fork_boundary IS NOT NULL',
            )
            .iterate()) {
            if (
              typeof fork['fork_boundary'] !== 'string' ||
              typeof fork['id'] !== 'string' ||
              typeof fork['fork_session_id'] !== 'string'
            )
              continue
            let boundary: unknown
            try {
              boundary = JSON.parse(fork['fork_boundary'])
            } catch (error) {
              if (error instanceof SyntaxError) continue
              throw error
            }
            if (
              typeof boundary !== 'object' ||
              boundary === null ||
              !('messageID' in boundary) ||
              typeof boundary.messageID !== 'string' ||
              !('type' in boundary)
            )
              continue
            const seq = boundaryRow.get(
              fork['fork_session_id'],
              boundary.messageID,
            )?.['seq']
            if (typeof seq !== 'number') continue
            let cutoff: unknown
            switch (boundary.type) {
              case 'through':
                cutoff = seq
                break
              case 'before':
                cutoff = before.get(fork['fork_session_id'], seq)?.['seq']
                break
              default:
                continue
            }
            if (typeof cutoff === 'number') cutoffs.set(fork['id'], cutoff)
          }
        }
        const model =
          "coalesce(json_extract(m.data,'$.model.id'),json_extract(m.data,'$.model.modelID'),json_extract(m.data,'$.modelID'))"
        const statement = db.prepare(
          `SELECT m.id,m.session_id,m.type,m.seq,m.time_created, json_extract(m.data,'$.status') AS status, ${projection(model, "coalesce(json_extract(m.data,'$.model.providerID'),json_extract(m.data,'$.providerID'))")} FROM session_message m WHERE m.time_created >= ?`,
        )
        for (const row of statement.iterate(since)) {
          if (
            row['type'] !== 'assistant' &&
            !(row['type'] === 'compaction' && row['status'] === 'completed')
          )
            continue
          const cutoff =
            typeof row['session_id'] === 'string'
              ? cutoffs.get(row['session_id'])
              : undefined
          if (
            cutoff !== undefined &&
            typeof row['seq'] === 'number' &&
            row['seq'] <= cutoff
          )
            continue
          add(row)
        }
      }
      const lookups = [
        ...(hasId ? [db.prepare('SELECT 1 FROM message WHERE id=?')] : []),
        ...(hasV2
          ? [db.prepare('SELECT 1 FROM session_message WHERE id=?')]
          : []),
      ]
      for (const id of input.legacyIds)
        if (lookups.some((statement) => statement.get(id))) ids.add(id)
      return { totals: [...totals.values()], knownIds: [...ids] }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof Error) return { error: true }
    throw error
  }
}
