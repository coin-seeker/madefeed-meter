export type DatabaseInput = {
  readonly paths: readonly string[]
  readonly sinceMs: number
}
export type DatabaseResult =
  | { readonly totals: readonly (readonly [string, string, number])[] }
  | { readonly error: true }

// Stringified into an eval worker: all runtime dependencies stay in this body.
export function databaseWorker(input: DatabaseInput): DatabaseResult {
  type Value = number | Uint8Array | undefined
  type Fields = ReadonlyMap<number, Value>
  const safe = (value: bigint) =>
    value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  const parse = (blob: unknown): Fields | undefined => {
    if (!(blob instanceof Uint8Array)) return undefined
    let offset = 0
    const varint = (): bigint | undefined => {
      let value = 0n
      for (let index = 0; index < 10; index++) {
        const byte = blob[offset++]
        if (byte === undefined) return undefined
        value |= BigInt(byte & 127) << BigInt(index * 7)
        if ((byte & 128) === 0) return value
      }
      return undefined
    }
    // Mutable builder preserves even an absent/oversized first occurrence.
    const fields = new Map<number, Value>()
    while (offset < blob.length) {
      const key = varint()
      if (key === undefined) return undefined
      const field = safe(key >> 3n)
      if (field === undefined || field === 0) return undefined
      let value: Value
      switch (Number(key & 7n)) {
        case 0: {
          const integer = varint()
          if (integer === undefined) return undefined
          value = safe(integer)
          break
        }
        case 1:
          offset += 8
          break
        case 2: {
          const length = varint()
          if (length === undefined) return undefined
          const size = safe(length)
          if (size === undefined || size > blob.length - offset)
            return undefined
          value = blob.subarray(offset, offset + size)
          offset += size
          break
        }
        case 5:
          offset += 4
          break
        default:
          return undefined
      }
      if (offset > blob.length) return undefined
      if (!fields.has(field)) fields.set(field, value)
    }
    return fields
  }
  const message = (fields: Fields | undefined, field: number) =>
    parse(fields?.get(field))
  const number = (fields: Fields | undefined, field: number) => {
    const value = fields?.get(field)
    return typeof value === 'number' ? value : undefined
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const string = (fields: Fields | undefined, field: number) => {
    const value = fields?.get(field)
    if (!(value instanceof Uint8Array)) return undefined
    try {
      return decoder.decode(value)
    } catch (error) {
      if (error instanceof TypeError) return undefined
      throw error
    }
  }
  const kstDateOf = (ms: number) =>
    new Date(ms + 32_400_000).toISOString().slice(0, 10)
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const { basename } = process.getBuiltinModule('node:path')
    const seen = new Set<string>()
    // Mutable aggregate is the only data sent back to the main thread.
    const totals = new Map<string, readonly [string, string, number]>()
    for (const path of input.paths) {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
        db.exec('BEGIN')
        try {
          const models = new Map<number, string>()
          let primary: string | undefined
          for (const row of db
            .prepare(
              'SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx',
            )
            .iterate()) {
            const request = message(parse(row['data']), 3)
            const name = string(request, 28)
            if (!name) continue
            const id = number(request, 1)
            if (id !== undefined && !models.has(id)) models.set(id, name)
            primary ??= name
          }
          for (const row of db
            .prepare(
              'SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx',
            )
            .iterate()) {
            const step = parse(row['metadata'])
            const usage = message(step, 9)
            if (!usage) continue
            const tokens = (number(usage, 2) ?? 0) + (number(usage, 3) ?? 0)
            const seconds = number(message(step, 1), 1)
            if (tokens === 0 || seconds === undefined) continue
            const ms = seconds * 1000
            if (
              ms < input.sinceMs ||
              !Number.isFinite(new Date(ms + 32_400_000).getTime())
            )
              continue
            const id =
              string(usage, 11) || `${basename(path, '.db')}:${row['idx']}`
            if (seen.has(id)) continue
            seen.add(id)
            const modelId = number(usage, 1)
            let model =
              (modelId === undefined ? undefined : models.get(modelId)) ??
              primary ??
              'agy'
            for (const suffix of [
              '-extra-low',
              '-extra-high',
              '-minimal',
              '-low',
              '-medium',
              '-high',
            ]) {
              if (model.endsWith(suffix)) {
                model = model.slice(0, -suffix.length)
                break
              }
            }
            const date = kstDateOf(ms)
            const key = JSON.stringify([date, model])
            totals.set(key, [date, model, (totals.get(key)?.[2] ?? 0) + tokens])
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
    return { totals: [...totals.values()] }
  } catch (error) {
    if (error instanceof Error) return { error: true }
    throw error
  }
}
