import { afterEach, beforeEach, expect, it } from 'vitest'
import { readQwen } from '../src/sources/qwen'
import { fixture, ms } from './t8-fixture'

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  f = await fixture()
})
afterEach(async () => {
  await f.remove()
})
const event = {
  type: 'assistant',
  timestamp: new Date(ms).toISOString(),
  sessionId: 's',
  model: 'qwen3-coder-plus',
  usageMetadata: {
    promptTokenCount: 1000,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 50,
    cachedContentTokenCount: 400,
    totalTokenCount: 1250,
  },
}
const read = () => readQwen({ home: f.home, sinceMs: 0, env: {} })

it('normalizes cached prompt and separately priced reasoning', async () => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [event])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-17',
        tool: 'qwen',
        model: 'qwen3-coder-plus',
        provider: 'alibaba',
        tokens: 1250,
        input: 600,
        output: 250,
        cacheRead: 400,
        reasoning: 50,
      },
    ],
  })
})
it.each([
  [
    { promptTokenCount: 100, totalTokenCount: 150, thoughtsTokenCount: 20 },
    { input: 100, output: 50, tokens: 150 },
  ],
  [
    {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
      thoughtsTokenCount: 10,
    },
    { input: 100, output: 20, tokens: 120 },
  ],
  [
    { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 120 },
    { input: 100, output: 20, tokens: 120 },
  ],
  [
    { promptTokenCount: 100, thoughtsTokenCount: 20 },
    { input: 100, output: 20, tokens: 120 },
  ],
  [
    { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
    { input: 100, output: 20, tokens: 120 },
  ],
  [
    {
      promptTokenCount: 100,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 20,
    },
    { input: 0, cacheRead: 100, output: 20, tokens: 120 },
  ],
  [
    {
      promptTokenCount: 100,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 20,
      totalTokenCount: 150,
    },
    { input: 100, output: 20, tokens: 150 },
  ],
])('preserves output semantics for %j', async (usageMetadata, expected) => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [{ ...event, usageMetadata }])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expect.objectContaining(expected)])
})
it('does not invent output or parts from total-only usage', async () => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [
    { ...event, usageMetadata: { totalTokenCount: 321 } },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-17',
      tool: 'qwen',
      model: 'qwen3-coder-plus',
      provider: 'alibaba',
      tokens: 321,
    },
  ])
})
it('reads archive directly, excludes nested archive and deduplicates first wins', async () => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [event, event])
  await f.lines('.qwen/projects/p/chats/archive/a.jsonl', [
    {
      ...event,
      usageMetadata: { ...event.usageMetadata, thoughtsTokenCount: 40 },
    },
    { ...event, sessionId: 'other' },
  ])
  await f.lines('.qwen/projects/p/chats/archive/deep/a.jsonl', [
    { ...event, sessionId: 'ignored' },
  ])
  await f.lines('.qwen/projects/p/chats/other/a.jsonl', [
    { ...event, sessionId: 'ignored2' },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(2)
  expect(result.rows[0]?.output).toBe(250)
})
it('uses project and file stem for missing session id without leaking paths', async () => {
  // Given
  const { sessionId, ...withoutId } = event
  expect(sessionId).toBe('s')
  await f.lines('.qwen/projects/p/chats/a.jsonl', [withoutId])
  await f.lines('.qwen/projects/p/chats/archive/a.jsonl', [withoutId])
  await f.lines('.qwen/projects/other/chats/a.jsonl', [withoutId])
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(2)
  expect(JSON.stringify(result)).not.toContain(f.home)
})
it('skips malformed, non-assistant, zero and invalid timestamp events', async () => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [
    '{',
    { ...event, timestamp: '' },
    { ...event, timestamp: null },
    { ...event, timestamp: ms },
    { ...event, type: 'user' },
    { ...event, usageMetadata: {} },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('replaces defaults with override lists and filters exact event times', async () => {
  // Given
  await f.lines('custom/projects/p/chats/a.jsonl', [event])
  await f.lines('.qwen/projects/p/chats/a.jsonl', [
    { ...event, sessionId: 'default' },
  ])
  // When
  const result = await readQwen({
    home: f.home,
    sinceMs: ms + 1,
    env: { QWEN_DATA_DIR: '~/custom,~/custom' },
  })
  // Then
  expect(result.rows).toEqual([])
})
it('rejects the whole source above the day/model token cap', async () => {
  // Given
  await f.lines('.qwen/projects/p/chats/a.jsonl', [
    { ...event, usageMetadata: { totalTokenCount: 100_000_000_001 } },
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    reason: 'Qwen Code 기록을 읽지 못해 이번에는 빼고 올려요.',
    rows: [],
  })
})
