import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod } from 'node:fs/promises'
import { readCline } from '../src/sources/cline'
import { readKimi } from '../src/sources/kimi'
import { readQwen } from '../src/sources/qwen'
import { fixture, ms } from './t8-fixture'

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  f = await fixture()
})
afterEach(async () => {
  await f.remove()
})
const readers = [
  {
    name: 'Cline',
    read: readCline,
    path: '.cline/tasks/a/ui_messages.json',
    event: JSON.stringify([
      {
        ts: ms,
        type: 'say',
        say: 'api_req_started',
        modelInfo: { modelId: 'glm-5' },
        text: '{"tokensIn":100000000000,"tokensOut":0,"cacheReads":0,"cacheWrites":0}',
      },
    ]),
  },
  {
    name: 'Kimi',
    read: readKimi,
    path: '.kimi/sessions/g/s/wire.jsonl',
    event: JSON.stringify({
      type: 'usage.record',
      time: ms,
      usageScope: 'turn',
      usage: { inputOther: 100_000_000_000 },
    }),
  },
  {
    name: 'Qwen',
    read: readQwen,
    path: '.qwen/projects/p/chats/a.jsonl',
    event: JSON.stringify({
      type: 'assistant',
      timestamp: new Date(ms).toISOString(),
      usageMetadata: { promptTokenCount: 100_000_000_000 },
    }),
  },
] as const

it.each(readers)(
  '$name returns supported empty results for an absent store',
  async (reader) => {
    // Given
    const options = { home: f.home, sinceMs: 0, env: {} }
    // When
    const result = await reader.read(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  },
)
it.each(readers)(
  '$name allows the exact daily cap without leaking source data',
  async (reader) => {
    // Given
    await f.put(reader.path, reader.event)
    // When
    const result = await reader.read({ home: f.home, sinceMs: 0, env: {} })
    // Then
    expect(result.supported).toBe(true)
    expect(result.rows[0]?.tokens).toBe(100_000_000_000)
    expect(
      Object.keys(result.rows[0] ?? {}).every((key) =>
        [
          'date',
          'tool',
          'model',
          'provider',
          'tokens',
          'input',
          'output',
          'cacheRead',
          'cacheWrite',
          'reasoning',
        ].includes(key),
      ),
    ).toBe(true)
  },
)
it.each(readers)(
  '$name discards partial totals when a selected file is unreadable',
  async (reader) => {
    // Given
    const path = await f.put(reader.path, reader.event)
    await chmod(path, 0)
    // When
    const result = await reader.read({ home: f.home, sinceMs: 0, env: {} })
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: expect.any(String),
    })
    expect(result.reason).not.toContain(f.home)
  },
)
