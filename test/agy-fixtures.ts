import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sinceMs = Date.parse('2026-11-14T15:00:00Z')
export const seconds = sinceMs / 1000
export async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-agy-'))
  const root = join(home, '.gemini/antigravity-cli/conversations')
  await mkdir(root, { recursive: true })
  return { home, root, sinceMs }
}
export function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value)
  const bytes: number[] = []
  do {
    const byte = Number(remaining & 127n)
    remaining >>= 7n
    bytes.push(byte | (remaining > 0n ? 128 : 0))
  } while (remaining > 0n)
  return Buffer.from(bytes)
}
export const vfield = (field: number, value: number | bigint) =>
  Buffer.concat([varint(field * 8), varint(value)])
export const bfield = (field: number, value: Uint8Array) =>
  Buffer.concat([varint(field * 8 + 2), varint(value.length), value])
export function generation(
  id = 1187,
  name: string | Buffer = 'gemini-3.5-flash-extra-low',
) {
  return Buffer.concat([
    bfield(2, Buffer.from([2])),
    bfield(
      3,
      Buffer.concat([
        vfield(1, id),
        vfield(6, 65536),
        Buffer.from([9, 1, 2, 3, 4, 5, 6, 7, 8]),
        bfield(17, bfield(2, vfield(1, id))),
        bfield(19, Buffer.from('gemini-default')),
        bfield(28, typeof name === 'string' ? Buffer.from(name) : name),
        Buffer.from([29, 1, 2, 3, 4]),
      ]),
    ),
  ])
}
export type Call = {
  readonly secs?: number
  readonly model?: number
  readonly input?: number
  readonly output?: number
  readonly id?: string
  readonly cacheWrite?: number
  readonly cacheRead?: number
  readonly reasoning?: number
  readonly visible?: number
  readonly messageId?: string
  readonly providerId?: string
  readonly responseId?: string
}
export function usage(call: Call = {}) {
  return Buffer.concat([
    ...[
      [1, call.model],
      [2, call.input],
      [3, call.output],
      [4, call.cacheWrite],
      [5, call.cacheRead],
      [9, call.reasoning],
      [10, call.visible],
    ].flatMap(([field, value]) =>
      field !== undefined && value !== undefined ? [vfield(field, value)] : [],
    ),
    ...[
      [7, call.messageId],
      [11, call.responseId ?? call.id],
      [12, call.providerId],
    ].flatMap(([field, value]) =>
      typeof field === 'number' && typeof value === 'string'
        ? [bfield(field, Buffer.from(value))]
        : [],
    ),
  ])
}
export function modelStep(call: Call = {}) {
  return Buffer.concat([
    bfield(1, stamp(call.secs ?? seconds, 694663000)),
    vfield(3, 2),
    bfield(
      9,
      usage({
        model: 1187,
        input: 1000,
        output: 37,
        reasoning: 30,
        visible: 7,
        ...call,
      }),
    ),
    bfield(12, Buffer.from('5e4affe4')),
    vfield(13, (1n << 64n) - 1n),
  ])
}
export const stamp = (secs = seconds, nanos = 0) =>
  Buffer.concat([vfield(1, secs), vfield(2, nanos)])
type Metadata = {
  readonly call?: Call
  readonly secs?: number
  readonly nanos?: number
  readonly model?: number
  readonly text?: string
  readonly alternateText?: string
  readonly retries?: readonly Call[]
  readonly indices?: readonly number[]
  readonly packed?: boolean
  readonly timeField?: 1 | 8
}
export function chatGeneration(meta: Metadata = {}) {
  const chat = Buffer.concat([
    ...(meta.model === undefined ? [] : [vfield(3, meta.model)]),
    ...(meta.call ? [bfield(4, usage(meta.call))] : []),
    ...(meta.secs === undefined
      ? []
      : [bfield(9, bfield(4, stamp(meta.secs, meta.nanos)))]),
    ...(meta.retries ?? []).map((call) => bfield(17, bfield(2, usage(call)))),
    ...(meta.text === undefined ? [] : [bfield(19, Buffer.from(meta.text))]),
    ...(meta.alternateText === undefined
      ? []
      : [bfield(21, Buffer.from(meta.alternateText))]),
  ])
  const indices = meta.indices ?? []
  return Buffer.concat([
    bfield(1, chat),
    ...(meta.packed
      ? [bfield(2, Buffer.concat(indices.map(varint)))]
      : indices.map((i) => vfield(2, i))),
  ])
}
export function step(meta: Metadata = {}) {
  return Buffer.concat([
    ...(meta.secs === undefined
      ? []
      : [bfield(meta.timeField ?? 8, stamp(meta.secs, meta.nanos))]),
    ...(meta.call ? [bfield(9, usage(meta.call))] : []),
    bfield(
      24,
      Buffer.concat([
        ...(meta.model === undefined ? [] : [vfield(1, meta.model)]),
        ...(meta.text === undefined
          ? []
          : [bfield(12, Buffer.from(meta.text))]),
        ...(meta.alternateText === undefined
          ? []
          : [bfield(8, Buffer.from(meta.alternateText))]),
      ]),
    ),
    ...(meta.retries ?? []).map((call) => bfield(28, bfield(2, usage(call)))),
  ])
}
export const trajectory = (secs = seconds) => bfield(2, stamp(secs))
export function database(
  root: string,
  name: string,
  contents: {
    readonly generations?: readonly Buffer[]
    readonly steps?: readonly Buffer[]
    readonly trajectories?: readonly Buffer[]
    readonly tables?: readonly (
      | 'gen_metadata'
      | 'steps'
      | 'trajectory_metadata_blob'
    )[]
  },
) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(root, name))
  try {
    const tables = contents.tables ?? [
      'gen_metadata',
      'steps',
      'trajectory_metadata_blob',
    ]
    for (const table of tables) {
      const column = table === 'steps' ? 'metadata' : 'data'
      db.exec(`CREATE TABLE ${table} (idx INTEGER PRIMARY KEY, ${column} BLOB)`)
      const blobs =
        table === 'steps'
          ? contents.steps
          : table === 'gen_metadata'
            ? contents.generations
            : contents.trajectories
      blobs?.forEach((blob, idx) =>
        db
          .prepare(`INSERT INTO ${table} (idx,${column}) VALUES (?,?)`)
          .run(idx, blob),
      )
    }
  } finally {
    db.close()
  }
}
