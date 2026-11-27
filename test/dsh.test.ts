import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { readDsh } from '../src/sources/dsh'
import { dshHeader, dshRoute, dshUsage, jsonl, ms } from './t10-fixtures'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'madefeed-dsh-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const path = (name = 'session.jsonl') =>
  join(home, '.dsh/sessions/group/s', name)
const read = (sinceMs = 0) => readDsh({ home, sinceMs, env: {} })
const expected = {
  date: '2026-11-16',
  tool: 'dsh',
  model: 'deepseek-v4-pro',
  provider: 'deepseek-official',
  input: 1200,
  output: 300,
  cacheRead: 8000,
  tokens: 9500,
}

it('reads the routed three-line disjoint usage fixture', async () => {
  // Given
  await jsonl(path(), [dshHeader, dshRoute, dshUsage()])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('selects the highest numeric generation, excluding invalid names', async () => {
  // Given
  await jsonl(path(), [dshHeader, dshUsage(1)])
  await jsonl(path('session.v2.jsonl'), [dshHeader, dshRoute, dshUsage()])
  await jsonl(path('session.vbad.jsonl'), [dshHeader, dshUsage(2)])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('reads two concatenated zstd frames', async () => {
  // Given
  await jsonl(path(), [])
  const first = zstdCompressSync(
    Buffer.from(
      [dshHeader, dshRoute].map((event) => JSON.stringify(event)).join('\n') +
        '\n',
    ),
  )
  const second = zstdCompressSync(
    Buffer.from(JSON.stringify(dshUsage()) + '\n'),
  )
  await writeFile(path('session.v2.jsonl.zstd'), Buffer.concat([first, second]))
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('retains complete records before a truncated trailing zstd frame', async () => {
  // Given
  await jsonl(path(), [])
  const first = zstdCompressSync(
    Buffer.from(
      [dshHeader, dshRoute, dshUsage()]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    ),
  )
  const tail = zstdCompressSync(Buffer.from(JSON.stringify(dshUsage(6)) + '\n'))
  await writeFile(
    path('session.v1.jsonl.zstd'),
    Buffer.concat([first, tail.subarray(0, 9)]),
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('returns the fixed unsupported reason when zstd is unavailable', async () => {
  // Given
  await jsonl(path('session.jsonl.zstd'), [])
  // When
  const result = await readDsh({ home, sinceMs: 0, env: {}, zstd: null })
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason:
      '압축된 DeepSeek Harness 기록을 읽으려면 Node.js 22.15 이상이 필요해서 이번에는 DeepSeek Harness를 빼고 올려요.',
  })
})
it('drops inherited usage through the last marker while preserving route', async () => {
  // Given
  const marker = { type: 'session/end-seed', data: { inherited: true } }
  await jsonl(path(), [
    { ...dshHeader, isSeeded: true },
    dshRoute,
    dshUsage(1),
    marker,
    dshUsage(2),
    marker,
    dshUsage(),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('drops a seeded log without a marker and rejects a missing header', async () => {
  // Given
  await jsonl(path(), [{ ...dshHeader, isSeeded: true }, dshUsage()])
  await jsonl(join(home, '.dsh/sessions/other/session.jsonl'), [
    dshRoute,
    dshUsage(),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('recovers absent output but preserves explicit zero and total-only remainder', async () => {
  // Given
  await jsonl(path(), [
    dshHeader,
    dshUsage(1, {
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 180,
    }),
    dshUsage(2, { inputTokens: 100, outputTokens: 0, totalTokens: 150 }),
    dshUsage(3, { totalTokens: 7 }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows.map((row) => [row.output, row.tokens])).toEqual([
    [50, 180],
    [0, 150],
    [undefined, 7],
  ])
})
it('uses last stream usage, compaction route and header timestamp fallback', async () => {
  // Given
  await jsonl(path(), [
    dshHeader,
    dshRoute,
    {
      type: 'assistant/attempt',
      data: {
        stream: [1, 2].map((inputTokens) => ({
          type: 'chunk',
          chunk: { type: 'usage', usage: { inputTokens } },
        })),
      },
    },
    {
      type: 'compaction/summary',
      time: ms,
      data: { model: 'glm-5', provider: 'ZAI', usage: { inputTokens: 3 } },
    },
  ])
  // When
  const result = await read()
  // Then
  expect(
    result.rows.map((row) => [row.model, row.provider, row.tokens]),
  ).toEqual([
    ['deepseek-v4-pro', 'deepseek-official', 2],
    ['glm-5', 'zai', 3],
  ])
})
it('prefers greater billable usage for repeated session-sequence identities', async () => {
  // Given
  await jsonl(path(), [
    dshHeader,
    dshRoute,
    dshUsage(5, { totalTokens: 9999 }),
    dshUsage(),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected])
})
it('returns empty output when absent and filters pre-window records', async () => {
  // Given
  await jsonl(path(), [dshHeader, dshUsage()])
  // When
  const result = await read(ms + 1)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
