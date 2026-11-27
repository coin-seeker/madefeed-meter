import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readZcode } from '../src/sources/zcode'
import { database, homeFixture, zcodeSchema } from './t9-sqlite-fixtures'

it('splits cache and preserves model case while stripping builtin providers and ignoring incomplete calls', async () => {
  // Given
  const home = homeFixture(),
    path = join(home, '.zcode/cli/db/db.sqlite')
  const db = database(path, zcodeSchema)
  db.exec(`INSERT INTO model_usage VALUES ('u', 's', 1786909042666, 'GLM-5.3', 'builtin:zai-coding-plan', 'completed', 100, 10, 15, 25, 110);
    INSERT INTO model_usage VALUES ('running', 's', 1786909042666, 'GLM-5.3', NULL, 'running', 1000, 10, 0, 0, 1010)`)
  db.close()
  const before = readFileSync(path)
  // When
  const result = await readZcode({ home, sinceMs: 0, env: {} })
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-08-17',
      tool: 'zcode',
      model: 'GLM-5.3',
      provider: 'zai-coding-plan',
      tokens: 110,
      input: 60,
      output: 10,
      cacheRead: 25,
      cacheWrite: 15,
    },
  ])
  expect(readFileSync(path)).toEqual(before)
})

it('infers UUID providers and first-wins deduplicates usage ids across databases', async () => {
  // Given
  const home = homeFixture(),
    roots = [join(home, 'one'), join(home, 'two')]
  for (const root of roots) {
    const db = database(join(root, 'cli/db/db.sqlite'), zcodeSchema)
    db.exec(`INSERT INTO model_usage VALUES ('u', 's', 1786909042666, 'GLM-5.3',
      '847d13c9-0568-4f2f-818e-8bd498e5d920', 'completed', 100, 10, 15, 25, 110)`)
    db.close()
  }
  // When
  const result = await readZcode({
    home,
    sinceMs: 0,
    env: { ZCODE_HOME: roots.join(',') },
  })
  // Then
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ provider: 'zai', tokens: 110 })
})

it('reads a legacy schema without optional columns', async () => {
  // Given
  const home = homeFixture(),
    db = database(
      join(home, '.zcode/cli/db/db.sqlite'),
      `
    CREATE TABLE session (id TEXT, directory TEXT);
    CREATE TABLE model_usage (id TEXT, session_id TEXT, started_at INTEGER, model_id TEXT,
      status TEXT, input_tokens INTEGER, output_tokens INTEGER);
    INSERT INTO model_usage VALUES ('u', 's', 1786909042666, 'GLM-5.3', 'completed', 100, 10)`,
    )
  db.close()
  // When
  const result = await readZcode({ home, sinceMs: 0, env: {} })
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-08-17',
      tool: 'zcode',
      model: 'GLM-5.3',
      provider: 'zai',
      tokens: 110,
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ])
})

it('reads live WAL without changing journal mode and clamps oversized caches', async () => {
  // Given
  const home = homeFixture(),
    db = database(join(home, '.zcode/cli/db/db.sqlite'), zcodeSchema)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    INSERT INTO model_usage VALUES ('u', 's', 1786909042666, 'GLM-5.3', NULL, 'completed', 100, 10, 80, 90, 150)`)
  try {
    // When
    const result = await readZcode({ home, sinceMs: 0, env: {} })
    // Then
    expect(result.rows).toEqual([
      {
        date: '2026-08-17',
        tool: 'zcode',
        model: 'GLM-5.3',
        provider: 'zai',
        tokens: 150,
        input: 0,
        output: 10,
        cacheRead: 90,
        cacheWrite: 10,
      },
    ])
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    })
  } finally {
    db.close()
  }
})

it.each(['corrupt', 'timeout', 'cap'] as const)(
  'fails the whole source on %s',
  async (kind) => {
    // Given
    const home = homeFixture(),
      path = join(home, '.zcode/cli/db/db.sqlite')
    const db = database(path, zcodeSchema)
    db.exec(`INSERT INTO model_usage VALUES ('u', 's', 1786909042666, 'GLM-5.3', NULL, 'completed',
    100, 10, 0, 0, ${kind === 'cap' ? 100000000001 : 110})`)
    db.close()
    if (kind === 'corrupt') writeFileSync(path, 'private canary')
    // When
    const result = await readZcode({
      home,
      sinceMs: 0,
      env: {},
      timeoutMs: kind === 'timeout' ? 0 : 45000,
    })
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'ZCode 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  },
)

it('returns empty for absent data', async () => {
  // Given
  const home = homeFixture()
  // When
  const result = await readZcode({ home, sinceMs: 0, env: {} })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
