import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAmp } from '../src/sources/amp'
import { ampMessage, ampThread, writeAmp } from './ccusage-fixtures/amp'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'meter-amp-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const read = (sinceMs = 0, env = {}) => readAmp({ home, sinceMs, env })

it('reads message usage with cache parts and a KST date', async () => {
  // Given
  await writeAmp(home)
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-17',
        tool: 'amp',
        model: 'gpt-5',
        provider: 'openai',
        input: 10,
        output: 178,
        cacheWrite: 986,
        cacheRead: 11372,
        tokens: 12546,
      },
    ],
  })
})
it('uses ledger counts once and links numeric message ids for cache', async () => {
  // Given
  await writeAmp(home, {
    ...ampThread,
    usageLedger: {
      events: [
        {
          id: 'e',
          toMessageId: 10,
          model: 'gpt-5',
          timestamp: ampMessage.timestamp,
          tokens: { input: 100, output: 200, total: 13000 },
        },
      ],
    },
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({
      input: 100,
      output: 200,
      cacheWrite: 986,
      cacheRead: 11372,
      tokens: 13000,
    }),
  ])
})
it('does not fall back to messages when the ledger is empty', async () => {
  // Given
  await writeAmp(home, { ...ampThread, usageLedger: { events: [] } })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('requires ledger tokens even when a linked message has cache usage', async () => {
  // Given
  await writeAmp(home, {
    ...ampThread,
    usageLedger: {
      events: [
        { toMessageId: 10, model: 'gpt-5', timestamp: ampMessage.timestamp },
      ],
    },
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('rejects a token-bearing thread without its id', async () => {
  // Given
  await writeAmp(home, { messages: [ampMessage] })
  // When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('keeps a reported total without inventing parts', async () => {
  // Given
  await writeAmp(home, {
    id: 'total',
    messages: [{ ...ampMessage, usage: { totalTokens: 20 } }],
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-17',
      tool: 'amp',
      model: 'gpt-5',
      provider: 'openai',
      tokens: 20,
    },
  ])
})
it('uses usage timestamp before message timestamp and filters the window', async () => {
  // Given
  await writeAmp(home, {
    ...ampThread,
    messages: [
      {
        ...ampMessage,
        usage: { ...ampMessage.usage, timestamp: '2026-11-15T00:00:00Z' },
      },
    ],
  })
  // When
  const result = await read(Date.parse('2026-11-16T00:00:00Z'))
  // Then
  expect(result.rows).toEqual([])
})
it('skips files modified before the window', async () => {
  // Given
  const path = await writeAmp(home)
  await utimes(path, 1, 1)
  // When
  const result = await read(Date.parse('2026-11-16T00:00:00Z'))
  // Then
  expect(result.rows).toEqual([])
})
it('replaces defaults with trimmed tilde roots and deduplicates them', async () => {
  // Given
  await writeAmp(home)
  await writeAmp(home, ampThread, 'custom/threads/thread.json')
  // When
  const result = await read(0, { AMP_DATA_DIR: ' ~/custom, ~/custom ' })
  // Then
  expect(result.rows).toHaveLength(1)
})
it('does not restore defaults for a missing explicit root', async () => {
  // Given
  await writeAmp(home)
  // When
  const result = await read(0, { AMP_DATA_DIR: '~/missing' })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('skips malformed files without losing another thread', async () => {
  // Given
  const path = await writeAmp(home, {}, '.local/share/amp/threads/bad.json')
  await writeFile(path, '{')
  await writeAmp(home)
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(1)
})
it('drops the entire source when a day-model total exceeds the cap', async () => {
  // Given
  await writeAmp(home, {
    ...ampThread,
    messages: [
      ampMessage,
      { ...ampMessage, usage: { totalTokens: 100_000_000_000 } },
    ],
  })
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason: 'Amp 기록을 읽지 못해 이번에는 빼고 올려요.',
  })
})
