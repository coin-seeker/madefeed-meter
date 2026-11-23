export function antigravityProto() {
  class DecodeError extends Error {}
  type Field = readonly [number, number | Uint8Array | undefined]
  type Fields = readonly Field[]
  const safe = (value: bigint) =>
    value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  const reader = (blob: Uint8Array) => {
    let offset = 0
    const take = (size: number) => {
      if (size > blob.length - offset) throw new DecodeError()
      const bytes = blob.subarray(offset, offset + size)
      offset += size
      return bytes
    }
    const varint = () => {
      let value = 0n
      for (let i = 0; i < 10; i++) {
        const byte = take(1)[0]
        if (byte === undefined) throw new DecodeError()
        value |= BigInt(byte & 127) << BigInt(i * 7)
        if ((byte & 128) === 0) return safe(value)
      }
      throw new DecodeError()
    }
    return { take, varint, remaining: () => offset < blob.length }
  }
  const decode = (blob: Uint8Array): Fields => {
    const r = reader(blob)
    const fields: Field[] = []
    while (r.remaining()) {
      const tag = r.varint()
      if (tag === undefined || tag < 8) throw new DecodeError()
      const field = Math.floor(tag / 8)
      switch (tag % 8) {
        case 0:
          fields.push([field, r.varint()])
          break
        case 1:
          r.take(8)
          break
        case 2: {
          const size = r.varint()
          if (size === undefined) throw new DecodeError()
          fields.push([field, r.take(size)])
          break
        }
        case 5:
          r.take(4)
          break
        default:
          throw new DecodeError()
      }
    }
    return fields
  }
  const num = (fields: Fields, n: number) =>
    fields.findLast(
      ([field, value]) => field === n && !(value instanceof Uint8Array),
    )?.[1]
  const number = (fields: Fields, n: number) => {
    const value = num(fields, n)
    return typeof value === 'number' ? value : undefined
  }
  const bytes = (fields: Fields, n: number) =>
    fields.flatMap(([field, value]) =>
      field === n && value instanceof Uint8Array ? [value] : [],
    )
  const msg = (fields: Fields, n: number) => {
    const blob = bytes(fields, n)[0]
    return blob === undefined ? undefined : decode(blob)
  }
  const text = (fields: Fields, n: number) => {
    const blob = bytes(fields, n).at(-1)
    if (blob === undefined) return undefined
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(blob)
      return value.trim() ? value : undefined
    } catch (error) {
      if (error instanceof TypeError) return undefined
      throw error
    }
  }
  const id = (fields: Fields, n: number) => number(fields, n) || undefined
  const timestamp = (fields: Fields | undefined) => {
    if (!fields) return undefined
    const seconds = number(fields, 1) ?? 0
    const ms =
      seconds * 1000 +
      Math.floor(Math.min(number(fields, 2) ?? 0, 999999999) / 1e6)
    return seconds > 0 && Number.isFinite(new Date(ms + 32400000).getTime())
      ? ms
      : undefined
  }
  const usage = (fields: Fields) => ({
    modelId: id(fields, 1),
    counts: [2, 3, 4, 5, 9, 10].map((n) => number(fields, n) ?? 0),
    keys: [
      [11, 'response'],
      [12, 'provider'],
      [7, 'message'],
    ].flatMap(([n, prefix]) => {
      const value = typeof n === 'number' ? text(fields, n) : undefined
      return value ? [`${prefix}:${value}`] : []
    }),
  })
  type Usage = ReturnType<typeof usage>
  const usages = (
    fields: Fields,
    primaryField: number,
    retryField: number,
  ): Usage[] => {
    const primary = msg(fields, primaryField)
    const first = primary ? usage(primary) : undefined
    const retries = bytes(fields, retryField).flatMap((blob) => {
      const nested = msg(decode(blob), 2)
      return nested ? [usage(nested)] : []
    })
    if (first) {
      const mirror = retries.findIndex(
        (retry) =>
          retry.modelId === first.modelId &&
          retry.counts.every((count, i) => count === first.counts[i]) &&
          retry.keys.every((key) => first.keys.includes(key)),
      )
      if (mirror >= 0) retries.splice(mirror, 1)
    }
    return first ? [first, ...retries] : retries
  }
  const indices = (fields: Fields) =>
    fields.flatMap(([n, value]) => {
      if (n !== 2) return []
      if (typeof value === 'number') return [value]
      if (!(value instanceof Uint8Array)) return []
      const r = reader(value)
      const result: number[] = []
      try {
        while (r.remaining()) {
          const next = r.varint()
          if (next === undefined) break
          result.push(next)
        }
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error
      }
      return result
    })
  const generation = (root: Fields) => {
    const request = msg(root, 3) ?? []
    const chat = msg(root, 1)
    const info = chat ? msg(chat, 9) : undefined
    const primary = chat ? msg(chat, 4) : undefined
    return {
      mapId: id(request, 1),
      mapName: text(request, 28),
      model: chat ? (text(chat, 19) ?? text(chat, 21)) : undefined,
      modelId: chat ? id(chat, 3) : undefined,
      ms: timestamp(info ? msg(info, 4) : undefined),
      indices: chat ? indices(root) : [],
      usages: chat ? usages(chat, 4, 17) : [],
      primary: primary !== undefined,
    }
  }
  const step = (root: Fields) => {
    const info = msg(root, 24) ?? []
    return {
      mapId: undefined,
      mapName: undefined,
      model: text(info, 12) ?? text(info, 8),
      modelId: id(info, 1),
      ms: timestamp(msg(root, 8) ?? msg(root, 1)),
      indices: [],
      usages: usages(root, 9, 28),
      primary: msg(root, 9) !== undefined,
    }
  }
  const parse = (blob: unknown, kind: 'gen' | 'step') => {
    if (!(blob instanceof Uint8Array)) return undefined
    try {
      const root = decode(blob)
      switch (kind) {
        case 'gen':
          return generation(root)
        case 'step':
          return step(root)
      }
    } catch (error) {
      if (error instanceof DecodeError) return undefined
      throw error
    }
  }
  const trajectory = (blob: unknown) => {
    if (!(blob instanceof Uint8Array)) return undefined
    try {
      return timestamp(msg(decode(blob), 2))
    } catch (error) {
      if (error instanceof DecodeError) return undefined
      throw error
    }
  }
  return { parse, trajectory }
}
