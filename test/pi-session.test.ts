import { expect, it } from 'vitest'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { aggregate } from '../src/aggregate'
import { readPi } from '../src/sources/pi'
import { readOmp } from '../src/sources/omp'
import { readOmo } from '../src/sources/omo'
import {
  event,
  fixture,
  message,
  session,
  sinceMs,
  textFile,
} from './pi-fixtures'

it('keeps the earlier fork response across sorted files, before event-window filtering', async () => {
  // Given
  const options = await fixture()
  const root = join(options.home, '.pi/agent/sessions/p')
  await session(join(root, 'a.jsonl'), [
    event({ message: message({ responseId: 'fork' }) }),
    event({ message: message({ responseId: 'old-copy' }) }),
  ])
  await session(join(root, 'z.jsonl'), [
    event({
      timestamp: '2026-11-14T16:00:00Z',
      message: message({
        responseId: 'fork',
        provider: 'OpenAI',
        usage: { input: 7 },
      }),
    }),
    event({
      timestamp: '2026-11-14T14:59:59Z',
      message: message({ responseId: 'old-copy' }),
    }),
  ])
  // When
  const result = await readPi(options)
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-15',
      tool: 'pi',
      model: 'model',
      provider: 'openai',
      tokens: 7,
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ])
})

it('deduplicates id@timestamp and session:physical-line keys, falling back to file stems', async () => {
  // Given
  const options = await fixture()
  const root = join(options.home, '.pi/agent/sessions')
  const lines = [
    { type: 'session', id: 'shared' },
    event({ id: 'id', message: message({ responseId: '' }) }),
    event({ timestamp: undefined }),
    event({ timestamp: undefined }),
  ]
  await session(join(root, 'a/a.jsonl'), lines)
  await session(join(root, 'b/b.jsonl'), lines)
  await session(join(root, 'a/stem.jsonl'), [event({ timestamp: undefined })])
  await session(join(root, 'b/stem.jsonl'), [event({ timestamp: undefined })])
  await session(join(root, 'b/other.jsonl'), [event({ timestamp: undefined })])
  // When
  const result = await readPi(options)
  // Then
  expect(aggregate(result.rows)[0]?.tokens).toBe(50)
})

it.each([
  { id: 'id-only', timestamp: undefined },
  { id: undefined, timestamp: '2026-11-15T15:00:00Z' },
])('deduplicates partial id@timestamp keys (%s)', async (fields) => {
  // Given
  const options = await fixture()
  for (const name of ['a', 'b'])
    await session(join(options.home, `.pi/agent/sessions/p/${name}.jsonl`), [
      event(fields),
    ])
  // When
  const result = await readPi(options)
  // Then
  expect(result.rows).toHaveLength(1)
})

it('uses physical line numbers even when a malformed line is skipped', async () => {
  // Given
  const options = await fixture()
  const root = join(options.home, '.pi/agent/sessions/p')
  const header = JSON.stringify({ type: 'session', id: 'shared' })
  const line = JSON.stringify(event({ timestamp: undefined }))
  await textFile(join(root, 'a.jsonl'), `${header}\n{broken\n${line}`)
  await textFile(join(root, 'b.jsonl'), `${header}\n${line}`)
  // When
  const result = await readPi(options)
  // Then
  expect(result.rows).toHaveLength(2)
})

it.each([-1, 1.5, '999', Number.MAX_SAFE_INTEGER + 1, null])(
  'sums safe buckets for invalid totalTokens %s without reasoning',
  async (totalTokens) => {
    // Given
    const options = await fixture()
    await session(join(options.home, '.pi/agent/sessions/p/a.jsonl'), [
      event({
        message: message({
          model: 'bad model',
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens,
            reasoning: 900,
          },
        }),
      }),
    ])
    // When
    const result = await readPi(options)
    // Then
    expect(result.rows).toEqual([
      {
        date: '2026-11-16',
        tool: 'pi',
        model: 'unknown',
        provider: 'unknown',
        tokens: 10,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      },
    ])
  },
)

it('trusts valid totals including zero but skips all-zero buckets, malformed and non-assistant lines', async () => {
  // Given
  const options = await fixture()
  const path = join(options.home, '.pi/agent/sessions/p/a.jsonl')
  const lines = [
    event({
      id: 'valid',
      message: message({ usage: { input: 1, totalTokens: 50 } }),
    }),
    event({
      id: 'zero-total',
      message: message({
        model: undefined,
        usage: { output: 2, totalTokens: 0 },
      }),
    }),
    event({
      id: 'zero-buckets',
      message: message({
        usage: {
          input: -1,
          output: 0.5,
          cacheRead: '3',
          cacheWrite: null,
          totalTokens: 99,
        },
      }),
    }),
    event({ message: message({ role: 'user' }) }),
    event({ message: message({ usage: null }) }),
    event({ message: message({ usage: [] }) }),
  ]
  await textFile(
    path,
    [...lines.map((line) => JSON.stringify(line)), '{broken'].join('\n'),
  )
  // When
  const result = await readPi(options)
  // Then
  expect(result.rows.map(({ model, tokens }) => ({ model, tokens }))).toEqual([
    { model: 'model', tokens: 50 },
    { model: 'unknown', tokens: 0 },
  ])
})

it('uses ISO then numeric message time then mtime, with inclusive file/event cutoffs and KST dates', async () => {
  // Given
  const options = await fixture()
  const root = join(options.home, '.pi/agent/sessions/p')
  await session(join(root, 'times.jsonl'), [
    event({
      id: 'iso',
      timestamp: '2026-11-15T14:59:59Z',
      message: message({ timestamp: sinceMs - 1 }),
    }),
    event({
      id: 'numeric',
      timestamp: 'bad',
      message: message({ timestamp: sinceMs }),
    }),
    event({
      id: 'mtime',
      timestamp: undefined,
      message: message({ timestamp: 'not-numeric' }),
    }),
    event({ id: 'old', timestamp: '2026-11-14T14:59:59Z' }),
  ])
  const old = join(root, 'old.jsonl')
  await session(old, [event({ id: 'old-file' })])
  await utimes(old, new Date(sinceMs - 1), new Date(sinceMs - 1))
  const boundary = join(root, 'boundary.jsonl')
  await session(boundary, [event({ id: 'boundary', timestamp: undefined })])
  await utimes(boundary, new Date(sinceMs), new Date(sinceMs))
  // When
  const result = await readPi(options)
  // Then
  expect(aggregate(result.rows)).toEqual([
    {
      date: '2026-11-15',
      tool: 'pi',
      model: 'model',
      provider: 'unknown',
      tokens: 30,
      input: 3,
      output: 6,
      cacheRead: 9,
      cacheWrite: 12,
    },
    {
      date: '2026-11-16',
      tool: 'pi',
      model: 'model',
      provider: 'unknown',
      tokens: 10,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
  ])
})

it.each([readPi, readOmp, readOmo])(
  'returns warning-free empty rows for missing roots (%s)',
  async (read) => {
    // Given
    const options = await fixture()
    // When
    const result = await read(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  },
)

it('counts the same response independently under pi and omp', async () => {
  // Given
  const options = await fixture()
  for (const tool of ['pi', 'omp'])
    await session(join(options.home, `.${tool}/agent/sessions/p/a.jsonl`), [
      event({ message: message({ responseId: 'same' }) }),
    ])
  // When
  const results = await Promise.all([readPi(options), readOmp(options)])
  // Then
  expect(
    results
      .flatMap((result) => result.rows)
      .map((row) => [row.tool, row.tokens]),
  ).toEqual([
    ['pi', 10],
    ['omp', 10],
  ])
})
