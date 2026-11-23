// SIZE_OK: existing source contract regressions share real SQLite fixtures.
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgy } from '../src/sources/agy'
import { bfield, vfield, generation, modelStep, database } from './agy-fixtures'

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
const row = (
  tokens: number,
  model = 'gemini-3.5-flash',
  input = 1000,
  reasoning = 30,
) => ({
  date: '2026-11-15',
  tool: 'agy',
  model,
  provider: model.startsWith('gemini-') ? 'google' : 'unknown',
  tokens,
  input,
  output: tokens - input,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning,
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
it("merges a repeated response id across dbs taking each field's maximum", async () => {
  // Given
  const options = await fixture()
  database(options.root, 'z.db', {
    steps: [modelStep({ id: 'same', input: 9000 })],
  })
  database(options.root, 'a.db', { steps: [modelStep({ id: 'same' })] })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(9037, 'gemini-3.5-flash', 9000)])
})
it('counts equal step indices from different db stems without response ids', async () => {
  // Given
  const options = await fixture()
  for (const name of ['a.db', 'b.db'])
    database(options.root, name, { steps: [modelStep()] })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(2074, 'gemini-3.5-flash', 2000, 60)])
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
  expect(result).toEqual({ supported: true, rows: [row(1037)] })
})
it('skips zero usage, absent usage and absent timestamps', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    steps: [
      modelStep({ input: 0, output: 0, reasoning: 0, visible: 0 }),
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
  expect(result).toEqual({ supported: true, rows: [row(1037)] })
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
    expect(result.rows).toEqual([row(1037)])
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
it.each(['garbage'])(
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
it.each(['steps', 'gen_metadata'])(
  'reads a db that lacks %s',
  async (table) => {
    // Given
    const options = await fixture()
    database(options.root, 'a.db', { steps: [modelStep()] })
    database(options.root, 'x.db', {
      tables: table === 'steps' ? ['gen_metadata'] : ['steps'],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [row(1037)] })
  },
)
it('uses the first sub-message, the last scalar and the last name per row, first row per id', async () => {
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
  expect(result.rows).toEqual([row(1002, 'wrong', 999, 0)])
})
it('treats invalid UTF-8 model names as absent', async () => {
  // Given
  const options = await fixture()
  database(options.root, 'a.db', {
    generations: [
      generation(1999, Buffer.from([255])),
      generation(99, 'valid-high'),
    ],
    steps: [modelStep({ model: 1999 })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toEqual([row(1037, 'valid')])
})

it('leaves the source out when a daily total is beyond any real day', async () => {
  // Given: fields that moved, so an unrelated huge number sits where tokens were.
  const options = await fixture()
  database(options.root, 'a.db', {
    generations: [generation()],
    steps: [modelStep({ input: 200_000_000_000 })],
  })
  // When
  const result = await readAgy(options)
  // Then: no row that would make the whole upload fail.
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason: 'Antigravity 기록을 읽지 못해 이번에는 빼고 올려요.',
  })
})
