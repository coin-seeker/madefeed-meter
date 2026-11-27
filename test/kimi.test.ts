import { afterEach, beforeEach, expect, it } from 'vitest'
import { readKimi } from '../src/sources/kimi'
import { fixture, ms } from './t8-fixture'

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  f = await fixture()
})
afterEach(async () => {
  await f.remove()
})
const legacy = {
  timestamp: ms / 1000 + 0.123,
  message: {
    type: 'StatusUpdate',
    payload: {
      message_id: 'm',
      token_usage: {
        input_other: 100,
        output: 50,
        input_cache_read: 10,
        input_cache_creation: 20,
      },
    },
  },
}
const modern = {
  type: 'usage.record',
  time: ms,
  usageScope: 'turn',
  model: 'kimi-code/kimi-for-coding',
  usage: {
    inputOther: 3064,
    output: 76,
    inputCacheRead: 14848,
    inputCacheCreation: 0,
  },
}
const read = () => readKimi({ home: f.home, sinceMs: 0, env: {} })

it('reads StatusUpdate seconds, exclusive input and per-root configured model', async () => {
  // Given
  await f.put('.kimi/config.json', { model: 'deepseek-v4' })
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [legacy])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-17',
        tool: 'kimi',
        model: 'deepseek-v4',
        provider: 'deepseek',
        tokens: 180,
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 20,
      },
    ],
  })
})
it('reads Kimi Code turn records but not cumulative session records', async () => {
  // Given
  await f.lines('.kimi-code/sessions/g/s/wire.jsonl', [
    modern,
    { ...modern, usageScope: 'session' },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({
      model: 'kimi-for-coding',
      provider: 'moonshotai',
      tokens: 17988,
      input: 3064,
      output: 76,
      cacheRead: 14848,
      cacheWrite: 0,
    }),
  ])
})
it('prefers explicit output over a replay remainder across agents', async () => {
  // Given
  const partial = {
    ...legacy,
    message: {
      ...legacy.message,
      payload: {
        ...legacy.message.payload,
        token_usage: {
          ...legacy.message.payload.token_usage,
          output: 0,
          total: 180,
        },
      },
    },
  }
  await f.lines('.kimi/sessions/g/s/agents/a/wire.jsonl', [partial])
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [legacy, legacy])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ output: 50, tokens: 180 }),
  ])
})
it('keeps distinct sessions and message ids', async () => {
  // Given
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [
    legacy,
    {
      ...legacy,
      message: {
        ...legacy.message,
        payload: { ...legacy.message.payload, message_id: 'other' },
      },
    },
  ])
  await f.lines('.kimi/sessions/g/other/wire.jsonl', [legacy])
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(3)
})
it('preserves total-only tokens without inventing parts', async () => {
  // Given
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [
    {
      timestamp: ms / 1000,
      message: {
        type: 'StatusUpdate',
        payload: { token_usage: { total: 432 } },
      },
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-17',
      tool: 'kimi',
      model: 'kimi-for-coding',
      provider: 'moonshotai',
      tokens: 432,
    },
  ])
})
it('falls back to moonshotai for unrecognized configured models', async () => {
  // Given
  await f.put('.kimi/config.json', { model: 'private-model' })
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [legacy])
  // When
  const result = await read()
  // Then
  expect(result.rows[0]?.provider).toBe('moonshotai')
})
it('ignores malformed, zero, untimed and incorrectly nested records', async () => {
  // Given
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [
    '{',
    { ...modern, time: 'bad' },
    { ...modern, usage: {} },
    { ...legacy, timestamp: null },
    { ...modern, type: 'metadata' },
  ])
  await f.lines('.kimi/sessions/g/s/nested/extra/wire.jsonl', [modern])
  await f.lines('.kimi/sessions/g/s/agents/a/nested/wire.jsonl', [modern])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('uses root lists and event-time filtering', async () => {
  // Given
  await f.lines('custom/sessions/g/s/wire.jsonl', [modern])
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [legacy])
  // When
  const result = await readKimi({
    home: f.home,
    sinceMs: ms,
    env: { KIMI_DATA_DIR: '~/custom,~/custom' },
  })
  // Then
  expect(result.rows).toEqual([expect.objectContaining({ tokens: 17988 })])
})
it('returns unsupported for an over-cap day/model total', async () => {
  // Given
  await f.lines('.kimi/sessions/g/s/wire.jsonl', [
    { ...modern, usage: { inputOther: 100_000_000_001 } },
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    reason: 'Kimi CLI 기록을 읽지 못해 이번에는 빼고 올려요.',
    rows: [],
  })
})
