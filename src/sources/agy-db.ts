import type { antigravityProto } from './agy-proto'
import type { antigravityModels } from './agy-model'
import type { antigravityMerge, AgyEvent, AgyTotal } from './agy-merge'

export type DatabaseInput = {
  readonly paths: readonly string[]
  readonly sinceMs: number
}
export type DatabaseResult =
  | { readonly totals: readonly AgyTotal[] }
  | { readonly error: true }
type Proto = ReturnType<typeof antigravityProto>
type Models = ReturnType<typeof antigravityModels>
type Merge = ReturnType<typeof antigravityMerge>

// Stringified into an eval worker: runtime dependencies must be local or parameters.
export function databaseWorker(
  input: DatabaseInput,
  proto: Proto,
  models: Models,
  merge: Merge,
): DatabaseResult {
  type Metadata = NonNullable<ReturnType<Proto['parse']>>
  type Row = {
    readonly idx: string
    readonly data: Metadata
    readonly fallbackKeys: readonly string[]
  }
  type Time = readonly [number, number]
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const { basename } = process.getBuiltinModule('node:path')
    const events: AgyEvent[] = []
    for (const path of input.paths) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
        db.exec('BEGIN')
        try {
          const tables = new Set(
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gen_metadata','steps','trajectory_metadata_blob')",
              )
              .all()
              .map((row) => row['name']),
          )
          if (
            db.prepare('PRAGMA page_count').get()?.['page_count'] === 0 ||
            (!tables.has('gen_metadata') && !tables.has('steps'))
          ) {
            db.exec('COMMIT')
            continue
          }
          const stem = basename(path, '.db')
          const read = (kind: 'gen' | 'step'): Row[] => {
            const table = kind === 'gen' ? 'gen_metadata' : 'steps'
            const column = kind === 'gen' ? 'data' : 'metadata'
            if (!tables.has(table)) return []
            return db
              .prepare(
                `SELECT idx, ${column} FROM ${table} WHERE ${column} IS NOT NULL ORDER BY idx`,
              )
              .all()
              .flatMap((row) => {
                const data = proto.parse(row[column], kind)
                if (!data) return []
                const idx = String(row['idx'])
                const fallbackKeys =
                  kind === 'step'
                    ? [`step:${stem}:${idx}`]
                    : data.indices.length
                      ? data.indices.map((i) => `step:${stem}:${i}`)
                      : [`gen:${stem}:${idx}`]
                return [{ idx, data, fallbackKeys }]
              })
          }
          const generations = read('gen')
          const steps = read('step')
          let trajectory: number | undefined
          if (tables.has('trajectory_metadata_blob')) {
            for (const row of db
              .prepare(
                'SELECT data FROM trajectory_metadata_blob ORDER BY rowid',
              )
              .all()) {
              const candidate = proto.trajectory(row['data'])
              trajectory ??= candidate
            }
          }
          const names = new Map<number, string>()
          for (const { data } of generations) {
            if (
              data.mapId !== undefined &&
              data.mapName &&
              !names.has(data.mapId)
            )
              names.set(data.mapId, data.mapName)
          }
          let generationModel: string | undefined
          let fallback: string | undefined
          for (const { data } of generations) {
            generationModel =
              models.rowModel(data.model, data.modelId, names) ??
              generationModel
            const resolved = [
              models.normalize(data.model),
              models.fromId(data.modelId, names),
              models.normalize(data.mapName),
            ].find((model) => models.rank(model) === 2)
            fallback = resolved ?? fallback
          }
          const times = new Map<string, Time>()
          const setTime = (keys: readonly string[], time: Time) => {
            for (const key of keys) {
              const old = times.get(key)
              if (
                !old ||
                time[1] > old[1] ||
                (time[1] === old[1] && time[0] < old[0])
              )
                times.set(key, time)
            }
          }
          for (const row of [...steps, ...generations]) {
            if (row.data.ms === undefined) continue
            setTime(
              [
                ...row.fallbackKeys,
                ...row.data.usages.flatMap((usage) => usage.keys),
              ],
              [row.data.ms, 3],
            )
          }
          const append = (row: Row, context: string | undefined) => {
            for (const [i, usage] of row.data.usages.entries()) {
              if (!usage.counts.some((count) => count > 0)) continue
              const fallbackKeys =
                i === 0 && row.data.primary ? row.fallbackKeys : []
              const keys = usage.keys.length
                ? [...usage.keys]
                : [...fallbackKeys]
              const linked = [...keys, ...fallbackKeys]
                .map((key) => times.get(key))
                .find((time) => time !== undefined)
              const time: Time | undefined =
                row.data.ms !== undefined
                  ? [row.data.ms, 3]
                  : (linked ??
                    (trajectory === undefined ? undefined : [trajectory, 1]))
              if (!time) continue
              setTime(keys, time)
              const [
                inputTokens = 0,
                total = 0,
                cacheWrite = 0,
                cacheRead = 0,
                thinking = 0,
                output = 0,
              ] = usage.counts
              const totalOutput = Math.max(total, output + thinking)
              const visible = Math.max(output, totalOutput - thinking)
              const reasoning = Math.max(thinking, totalOutput - visible)
              const model = models.resolve(
                usage.modelId,
                { model: context, id: row.data.modelId },
                names,
              )
              events.push({
                ms: time[0],
                timeRank: time[1],
                model,
                modelRank: models.rank(model),
                fallback,
                keys,
                input: inputTokens,
                visible,
                output: totalOutput,
                cacheWrite,
                cacheRead,
                reasoning,
              })
            }
          }
          for (const row of steps)
            append(
              row,
              models.rowModel(row.data.model, row.data.modelId, names) ??
                generationModel,
            )
          let currentModel: string | undefined
          for (const row of generations) {
            const usage = row.data.primary ? row.data.usages[0] : undefined
            currentModel =
              models.rowModel(row.data.model, row.data.modelId, names) ??
              models.fromId(usage?.modelId, names) ??
              currentModel
            append(row, currentModel)
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      } finally {
        db.close()
      }
    }
    return { totals: merge.totals(events, input.sinceMs) }
  } catch (error) {
    if (error instanceof Error) return { error: true }
    throw error
  }
}
