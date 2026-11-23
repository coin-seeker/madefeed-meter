import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgy } from '../src/sources/agy'

// SIZE_OK: the task requires the real DDL, wire encoder and source contract cases in this single owned test file.
const sinceMs = Date.parse('2026-11-14T15:00:00Z')
const seconds = sinceMs / 1000
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-agy-'))
  homes.push(home)
  const root = join(home, '.gemini/antigravity-cli/conversations')
  await mkdir(root, { recursive: true })
  return { home, root, sinceMs }
}
function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value)
  const bytes: number[] = []
  do {
    const byte = Number(remaining & 127n)
    remaining >>= 7n
    bytes.push(byte | (remaining > 0n ? 128 : 0))
  } while (remaining > 0n)
  return Buffer.from(bytes)
}
const vfield = (field: number, value: number | bigint) =>
  Buffer.concat([varint(field * 8), varint(value)])
const bfield = (field: number, value: Uint8Array) =>
  Buffer.concat([varint(field * 8 + 2), varint(value.length), value])
function generation(
  id = 1187,
  name: string | Buffer = 'gemini-3.5-flash-extra-low',
) {
  const request = Buffer.concat([
    vfield(1, id),
    vfield(6, 65536),
    Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]),
    bfield(17, bfield(2, vfield(1, id))),
    bfield(19, Buffer.from('gemini-default')),
    bfield(28, typeof name === 'string' ? Buffer.from(name) : name),
    Buffer.from([0x1d, 1, 2, 3, 4]),
  ])
  return Buffer.concat([bfield(2, Buffer.from([2])), bfield(3, request)])
}
type Call = {
  readonly secs?: number
  readonly model?: number
  readonly input?: number
  readonly output?: number
  readonly id?: string
}
function modelStep(call: Call = {}) {
  const usage = Buffer.concat([
    vfield(1, call.model ?? 1187),
    vfield(2, call.input ?? 1000),
    vfield(3, call.output ?? 37),
    vfield(6, 24),
    bfield(8, bfield(1, Buffer.from('sessionID'))),
    vfield(9, 30),
    vfield(10, 7),
    bfield(11, Buffer.from(call.id ?? '')),
  ])
  return Buffer.concat([
    bfield(
      1,
      Buffer.concat([vfield(1, call.secs ?? seconds), vfield(2, 694663000)]),
    ),
    vfield(3, 2),
    bfield(9, usage),
    bfield(12, Buffer.from('5e4affe4')),
    vfield(13, (1n << 64n) - 1n),
  ])
}
function database(
  root: string,
  name: string,
  contents: {
    readonly generations?: readonly Buffer[]
    readonly steps: readonly Buffer[]
  },
) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(root, name))
  try {
    db.exec(
      'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`)); CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));',
    )
    contents.generations?.forEach((blob, idx) =>
      db
        .prepare('INSERT INTO gen_metadata (idx,data) VALUES (?,?)')
        .run(idx, blob),
    )
    contents.steps.forEach((blob, idx) =>
      db
        .prepare('INSERT INTO steps (idx,metadata) VALUES (?,?)')
        .run(idx, blob),
    )
  } finally {
    db.close()
  }
}
const row = (tokens: number, model = 'gemini-3.5-flash') => ({
  date: '2026-11-15',
  tool: 'agy',
  model,
  tokens,
})

it('adds input and inclusive output on the KST date and skips unrelated wire fields', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    generations: [generation()],
    steps: [modelStep()],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [row(1037)] })
})
it('deduplicates response ids in sorted db order rather than creation order', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'z.db', {
    steps: [modelStep({ id: 'same', input: 9000 })],
  })
  database(options.root, 'a.db', { steps: [modelStep({ id: 'same' })] })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(1037, 'agy')])
})
it('counts equal step indices from different db stems without response ids', async () => {
  // Given
  const options = await fixture()
  for (const name of ['a.db', 'b.db'])
    database(options.root, name, { steps: [modelStep()] })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(2074, 'agy')])
})
it.each([true, false])(
  'falls back to primary model or agy when enum is unknown (%s)',
  async (primary) => {
    // Given
    const options = await fixture()
    database(options.root, 'a.db', {
      generations: primary ? [generation()] : [],
      steps: [modelStep({ model: 99 })],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows).toEqual([
      row(1037, primary ? 'gemini-3.5-flash' : 'agy'),
    ])
  },
)
it.each([
  [0x0a, 5, 1],
  [8, 128],
  [11],
  [0, 1],
  [9, 1],
  [13, 1],
  [8, ...Array<number>(10).fill(128)],
])('skips malformed blobs but counts valid siblings (%j)', async (...bytes) => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    steps: [Buffer.concat([modelStep(), Buffer.from(bytes)]), modelStep()],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [row(1037, 'agy')] })
})
it('skips zero usage, absent usage and absent timestamps', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    steps: [
      modelStep({ input: 0, output: 0 }),
      bfield(1, vfield(1, seconds)),
      bfield(9, vfield(2, 10)),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('drops old events and never opens garbage dbs with old db and wal mtimes', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    steps: [modelStep({ secs: seconds - 1 }), modelStep()],
  })
  for (const name of ['old.db', 'old.db-wal']) {
    const path = join(options.root, name)
    await writeFile(path, 'garbage')
    await utimes(path, 0, 0)
  }
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [row(1037, 'agy')] })
})
it('keeps a db with an old mtime when its wal is recent', async () => {
  // Given
  const options = await fixture()
  const path = join(options.root, 'a.db')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  database(options.root, 'a.db', { steps: [] })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(
      0,
      modelStep(),
    )
    await utimes(path, 0, 0)
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows).toEqual([row(1037, 'agy')])
  } finally {
    db.close()
  }
})
it('ignores non-db files and subdirectories even with a db suffix', async () => {
  // Given
  const options = await fixture()
  await writeFile(join(options.root, 'notes.pb'), 'garbage')
  await mkdir(join(options.root, 'nested.db'))
  await writeFile(join(options.root, 'nested.db', 'hidden.db'), 'garbage')
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('returns an empty supported result without a reason for missing directories', async () => {
  // Given
  const options = await fixture()
  await rm(options.root, { recursive: true })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it.each(['garbage', 'steps', 'gen_metadata'])(
  'discards all usage when a kept db cannot be read (%s)',
  async (failure) => {
    // Given
    const options = await fixture()
    database(options.root, 'a.db', { steps: [modelStep()] })
    const path = join(options.root, 'x.db')
    if (failure === 'garbage') await writeFile(path, 'not sqlite')
    else {
      database(options.root, 'x.db', { steps: [] })
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const db = new DatabaseSync(path)
      try {
        db.exec(`DROP TABLE ${failure}`)
      } finally {
        db.close()
      }
    }
    // When
    const result = await readAgy(options)
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'Antigravity 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  },
)
it('uses the first duplicate field and first name per enum', async () => {
  // Given
  const options = await fixture()
  const request = bfield(
    3,
    Buffer.concat([
      vfield(1, 1187),
      bfield(28, Buffer.from('first-low')),
      bfield(28, Buffer.from('wrong')),
    ]),
  )
  const usage = bfield(
    9,
    Buffer.concat([
      vfield(1, 1187),
      vfield(2, 7),
      vfield(2, 999),
      vfield(3, 3),
    ]),
  )
  database(options.root, 'a.db', {
    generations: [request, generation()],
    steps: [Buffer.concat([usage, modelStep()])],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(10, 'first')])
})
it('treats invalid UTF-8 model names as absent', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    generations: [
      generation(1187, Buffer.from([255])),
      generation(99, 'valid-high'),
    ],
    steps: [modelStep()],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(1037, 'valid')])
})
