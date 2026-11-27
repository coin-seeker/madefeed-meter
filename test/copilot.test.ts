import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCopilot } from '../src/sources/copilot'
import { jsonl, ms, receipt, shutdown } from './t10-fixtures'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'madefeed-copilot-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const path = (session = 's') =>
  join(home, '.copilot/session-state', session, 'events.jsonl')
const read = (sinceMs = 0) => readCopilot({ home, sinceMs, env: {} })
const base = {
  date: '2026-11-16',
  tool: 'copilot',
  model: 'gpt-5',
  provider: 'github-copilot',
}

it('maps receipt parts and strips model suffixes without adding reasoning twice', async () => {
  // Given
  await jsonl(path(), [receipt({ usage: { reasoningTokens: 5 } })])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    { ...base, input: 100, output: 10, reasoning: 5, tokens: 110 },
  ])
})
it('maps shutdown cache-inclusive input to fresh input and total 150', async () => {
  // Given
  await jsonl(path(), [shutdown()])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      ...base,
      input: 70,
      output: 50,
      cacheRead: 10,
      cacheWrite: 20,
      reasoning: 5,
      tokens: 150,
    },
  ])
})
it('keeps pre-window baselines and subtracts normalized counters with saturation', async () => {
  // Given
  await jsonl(path(), [
    shutdown({ time: ms - 86400000 }),
    shutdown({
      id: 'second',
      usage: {
        inputTokens: 150,
        outputTokens: 80,
        cacheReadTokens: 5,
        cacheWriteTokens: 25,
        reasoningTokens: 8,
      },
    }),
  ])
  // When
  const result = await read(ms)
  // Then
  expect(result.rows).toEqual([
    {
      ...base,
      input: 50,
      output: 30,
      cacheRead: 0,
      cacheWrite: 5,
      reasoning: 3,
      tokens: 85,
    },
  ])
})
it('suppresses shutdown at or after the first receipt even when files are unsorted', async () => {
  // Given
  await jsonl(path(), [
    shutdown({ time: ms + 1 }),
    receipt(),
    shutdown({ id: 'before', time: ms - 1 }),
  ])
  // When
  const result = await read(ms)
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([110])
})
it('suppresses positive watermark snapshots but retains their baseline', async () => {
  // Given
  await jsonl(path(), [
    shutdown({ watermarks: { s: 2 } }),
    shutdown({ id: 'later', time: ms + 1, usage: { inputTokens: 120 } }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([20])
})
it('deduplicates accounting copies and prefers the source-session copy', async () => {
  // Given
  const accounting = { sourceSessionId: 'z-source', sequence: 1 }
  await jsonl(path('a-fork'), [
    receipt({ usage: { accounting, outputTokens: 99 } }),
  ])
  await jsonl(path('z-source'), [
    receipt({ usage: { accounting } }),
    receipt({ id: 'copy', usage: { accounting } }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([110])
})
it('deduplicates fallback event IDs but counts ID-less receipts independently', async () => {
  // Given
  const event = receipt()
  const anonymous = { ...event, id: undefined }
  await jsonl(path(), [event, event, anonymous, anonymous])
  // When
  const result = await read()
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([110, 110, 110])
})
it('preserves cache overflows in total rather than returning raw input plus output', async () => {
  // Given
  await jsonl(path(), [
    receipt({
      usage: { inputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 20 },
    }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows[0]).toMatchObject({
    input: 0,
    output: 10,
    cacheRead: 10,
    cacheWrite: 20,
    tokens: 40,
  })
})
it('ignores OTel, malformed, zero and undated records', async () => {
  // Given
  await jsonl(join(home, '.copilot/otel/log.jsonl'), [receipt()])
  await jsonl(path(), [
    '{broken',
    { ...receipt(), timestamp: 'invalid' },
    receipt({ usage: { inputTokens: 0, outputTokens: 0 } }),
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('treats COPILOT_HOME as one path including commas', async () => {
  // Given
  const root = join(home, 'a,b')
  await jsonl(join(root, 'session-state/s/events.jsonl'), [receipt()])
  // When
  const result = await readCopilot({
    home,
    sinceMs: 0,
    env: { COPILOT_HOME: ` ${root} ` },
  })
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([110])
})
it('returns supported empty output without session-state', async () => {
  // Given / When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
