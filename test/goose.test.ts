import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readGoose } from '../src/sources/goose'
import { database, gooseSchema, homeFixture } from './t9-sqlite-fixtures'

it('keeps accumulated usage and remainder when the single override contains a comma', async () => {
  // Given
  const home = homeFixture(),
    root = join(home, 'root,with-comma')
  const path = join(root, 'data/sessions/sessions.db')
  const db = database(path, gooseSchema)
  db.exec(`INSERT INTO sessions VALUES ('s', '{"model_name":"claude-sonnet-4-20250514"}',
    'anthropic', '2026-05-01 16:02:03', 3, 1, 2, 180, 100, 50)`)
  db.close()
  const before = readFileSync(path)
  // When
  const result = await readGoose({
    home,
    sinceMs: 0,
    env: { GOOSE_PATH_ROOT: root },
  })
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-05-02',
        tool: 'goose',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        tokens: 180,
        input: 100,
        output: 50,
      },
    ],
  })
  expect(readFileSync(path)).toEqual(before)
})

it('deduplicates physical default DB aliases and falls back from zero accumulated counters', async () => {
  // Given
  const home = homeFixture(),
    path = join(home, '.local/share/goose/sessions/sessions.db')
  const db = database(path, gooseSchema)
  db.exec(`INSERT INTO sessions VALUES ('s', '{"model_name":"glm-5"}', NULL,
    '1767312000', 20, 10, 5, 0, -1, NULL)`)
  db.close()
  const alias = join(home, 'Library/Application Support/goose/sessions')
  mkdirSync(alias, { recursive: true })
  symlinkSync(path, join(alias, 'sessions.db'))
  // When
  const result = await readGoose({ home, sinceMs: 0, env: {} })
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-01-02',
      tool: 'goose',
      model: 'glm-5',
      provider: 'zai',
      tokens: 20,
      input: 10,
      output: 5,
    },
  ])
})

it('skips malformed models and invalid timestamps without failing healthy rows', async () => {
  // Given
  const home = homeFixture(),
    db = database(
      join(home, '.local/share/goose/sessions/sessions.db'),
      gooseSchema,
    )
  for (const [id, model, time] of [
    ['bad', '{', '2026-05-01'],
    ['time', '{"model_name":"gpt-5"}', 'bad'],
    ['ok', '{"model_name":"gpt-5"}', '2026-05-01T00:00:00'],
  ] as const)
    db.prepare(
      'INSERT INTO sessions VALUES (?, ?, NULL, ?, 10, 0, 0, NULL, NULL, NULL)',
    ).run(id, model, time)
  db.close()
  // When
  const result = await readGoose({ home, sinceMs: 0, env: {} })
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-05-01',
      tool: 'goose',
      model: 'gpt-5',
      provider: 'openai',
      tokens: 10,
    },
  ])
})

it.each(['corrupt', 'timeout', 'cap'] as const)(
  'rejects the whole source on %s',
  async (kind) => {
    // Given
    const home = homeFixture(),
      path = join(home, '.local/share/goose/sessions/sessions.db')
    const db = database(path, gooseSchema)
    db.exec(`INSERT INTO sessions VALUES ('s', '{"model_name":"gpt-5"}', NULL, '2026-05-01',
    ${kind === 'cap' ? 100000000001 : 10}, 0, 0, NULL, NULL, NULL)`)
    db.close()
    if (kind === 'corrupt') writeFileSync(path, 'not sqlite: private canary')
    // When
    const result = await readGoose({
      home,
      sinceMs: 0,
      env: {},
      timeoutMs: kind === 'timeout' ? 0 : 45000,
    })
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'Goose 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  },
)

it('returns a supported empty result when absent or outside the period', async () => {
  // Given
  const home = homeFixture()
  // When
  const result = await readGoose({ home, sinceMs: 0, env: {} })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
