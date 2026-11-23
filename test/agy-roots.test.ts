import { afterEach, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readAgy } from '../src/sources/agy'
import { database, fixture, modelStep } from './agy-fixtures'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function setup() {
  const options = await fixture()
  homes.push(options.home)
  return options
}
const roots = [
  '.gemini/antigravity',
  '.gemini/antigravity-cli',
  '.gemini/antigravity-ide',
  '.gemini/antigravity-backup',
  '.gemini/antigravity-acp',
  '.config/antigravity',
]
it('R1 sums independent calls from all six default roots', async () => {
  // Given
  const options = await setup()
  for (const [i, root] of roots.entries()) {
    const dir = join(options.home, root, 'conversations')
    await mkdir(dir, { recursive: true })
    database(dir, `${i}.db`, {
      steps: [modelStep({ id: `r${i}`, input: i + 1 })],
    })
  }
  // When
  const result = await readAgy(options)
  // Then
  expect(result.supported).toBe(true)
  expect(result.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(243)
})
it('R2 overrides defaults with parent and direct roots', async () => {
  // Given
  const options = await setup()
  const p = join(options.home, 'parent')
  const d = join(options.home, 'direct')
  await mkdir(join(p, 'conversations'), { recursive: true })
  await mkdir(d)
  database(join(p, 'conversations'), 'x.db', {
    steps: [modelStep({ id: 'x', input: 1 })],
  })
  database(d, 'y.db', { steps: [modelStep({ id: 'y', input: 2 })] })
  database(options.root, 'default.db', { steps: [modelStep({ input: 999 })] })
  // When
  const result = await readAgy({
    ...options,
    env: { ANTIGRAVITY_DATA_DIR: `${p},,${d}` },
  })
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([77])
})
it('R3 treats an empty override as no roots', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', { steps: [modelStep()] })
  // When
  const result = await readAgy({
    ...options,
    env: { ANTIGRAVITY_DATA_DIR: '' },
  })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('R4 counts canonicalized root aliases once', async () => {
  // Given
  const options = await setup()
  const r = join(options.home, 'custom')
  await mkdir(join(r, 'conversations'), { recursive: true })
  database(join(r, 'conversations'), 's.db', { steps: [modelStep()] })
  // When
  const result = await readAgy({
    ...options,
    env: { ANTIGRAVITY_DATA_DIR: `${r},${r}/conversations/..` },
  })
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([1037])
})
it('R5 ignores summary databases outside default conversations directories', async () => {
  // Given
  const options = await setup()
  database(
    join(options.home, '.gemini/antigravity-cli'),
    'conversation_summaries.db',
    { steps: [modelStep()] },
  )
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('R6 silently skips empty snapshots and unrelated schemas', async () => {
  // Given
  const options = await setup()
  await writeFile(join(options.root, 'z.db'), '')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(options.root, 'other.db'))
  try {
    db.exec('CREATE TABLE other(x)')
  } finally {
    db.close()
  }
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
