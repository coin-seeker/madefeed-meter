import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readKilo } from '../src/sources/kilo'
import {
  database,
  homeFixture,
  kiloMessage,
  kiloSchema,
} from './t9-sqlite-fixtures'

it('includes reasoning once and deduplicates JSON ids across databases', async () => {
  // Given
  const home = homeFixture(),
    roots = [join(home, 'one'), join(home, 'two')]
  for (const root of roots) {
    const db = database(join(root, 'kilo.db'), kiloSchema)
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
      'row-1',
      's',
      JSON.stringify(kiloMessage),
    )
    db.close()
  }
  // When
  const result = await readKilo({
    home,
    sinceMs: 0,
    env: { KILO_DATA_DIR: roots.join(',') },
  })
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-01-02',
        tool: 'kilo',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        tokens: 185,
        input: 100,
        output: 55,
        reasoning: 5,
        cacheRead: 10,
        cacheWrite: 20,
      },
    ],
  })
})

it('keeps total-only usage unclassified, skips malformed rows, and respects the time boundary', async () => {
  // Given
  const home = homeFixture(),
    db = database(join(home, '.local/share/kilo/kilo.db'), kiloSchema)
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?)')
  for (const [index, value] of [
    '{',
    JSON.stringify({ ...kiloMessage, role: 'user' }),
    JSON.stringify({ ...kiloMessage, tokens: null }),
    JSON.stringify({ ...kiloMessage, id: 'old', time: { created: 1 } }),
    JSON.stringify({
      ...kiloMessage,
      id: 'total',
      providerID: undefined,
      modelID: 'deepseek-v4',
      tokens: { total: 234 },
    }),
  ].entries())
    insert.run(String(index), 's', value)
  db.close()
  // When
  const result = await readKilo({ home, sinceMs: 1767312000000, env: {} })
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-01-02',
      tool: 'kilo',
      model: 'deepseek-v4',
      provider: 'deepseek',
      tokens: 234,
    },
  ])
})

it('uses database-scoped row ids when payload ids are absent', async () => {
  // Given
  const home = homeFixture(),
    roots = [join(home, 'one'), join(home, 'two')]
  for (const root of roots) {
    const db = database(join(root, 'kilo.db'), kiloSchema)
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
      'same-row',
      's',
      JSON.stringify({ ...kiloMessage, id: undefined }),
    )
    db.close()
  }
  // When
  const result = await readKilo({
    home,
    sinceMs: 0,
    env: { KILO_DATA_DIR: roots.join(',') },
  })
  // Then
  expect(result.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(370)
})

it.each(['corrupt', 'timeout', 'cap'] as const)(
  'discards all usage on %s',
  async (kind) => {
    // Given
    const home = homeFixture(),
      path = join(home, '.local/share/kilo/kilo.db')
    const db = database(path, kiloSchema)
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
      'r',
      's',
      JSON.stringify({
        ...kiloMessage,
        tokens: { total: kind === 'cap' ? 100000000001 : 10 },
      }),
    )
    db.close()
    if (kind === 'corrupt') writeFileSync(path, 'private canary')
    // When
    const result = await readKilo({
      home,
      sinceMs: 0,
      env: {},
      timeoutMs: kind === 'timeout' ? 0 : 45000,
    })
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'Kilo Code 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  },
)

it('does not fall back to default when an explicit root is missing', async () => {
  // Given
  const home = homeFixture(),
    db = database(join(home, '.local/share/kilo/kilo.db'), kiloSchema)
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
    'r',
    's',
    JSON.stringify(kiloMessage),
  )
  db.close()
  // When
  const result = await readKilo({
    home,
    sinceMs: 0,
    env: { KILO_DATA_DIR: join(home, 'missing') },
  })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
