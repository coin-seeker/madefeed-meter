import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodebuff } from '../src/sources/codebuff'
import {
  codebuffMessage as message,
  writeCodebuff,
} from './ccusage-fixtures/codebuff'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'meter-codebuff-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const read = (sinceMs = 0, env = {}) => readCodebuff({ home, sinceMs, env })

it('reads upstream fixture with the four token buckets', async () => {
  // Given
  await writeCodebuff(home)
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-17',
        tool: 'codebuff',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        input: 100,
        output: 50,
        cacheWrite: 20,
        cacheRead: 10,
        tokens: 180,
      },
    ],
  })
})
it('keeps the last duplicate id within the channel-project-chat', async () => {
  // Given
  await writeCodebuff(home, [
    message,
    { ...message, metadata: { usage: { total: 25 } } },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-17',
      tool: 'codebuff',
      model: 'codebuff-unknown',
      provider: 'unknown',
      tokens: 25,
    },
  ])
})
it('does not deduplicate identical ids across channels', async () => {
  // Given
  await writeCodebuff(home)
  await writeCodebuff(
    home,
    [message],
    '.config/manicode-dev/projects/project/chats/chat/chat-messages.json',
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(2)
})
it('skips credits-only and non-assistant records', async () => {
  // Given
  await writeCodebuff(home, [
    { ...message, metadata: {}, credits: 5 },
    { ...message, variant: 'user' },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('merges usage sources by fallback rather than summing them', async () => {
  // Given
  const history = [
    {
      role: 'assistant',
      providerOptions: {
        codebuff: {
          model: 'gpt-5',
          usage: {
            completion_tokens: 30,
            cached_tokens_created: 7,
            total: 100,
          },
        },
      },
    },
  ]
  await writeCodebuff(home, [
    {
      ...message,
      metadata: {
        usage: { input_tokens: 10, outputTokens: 0 },
        codebuff: {
          usage: {
            promptTokens: 90,
            completionTokens: 20,
            cache_read_input_tokens: 2,
            prompt_tokens_details: { cached_tokens: 5 },
          },
        },
        runState: {
          sessionState: { mainAgentState: { messageHistory: history } },
        },
      },
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({
      model: 'gpt-5',
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 7,
      tokens: 100,
    }),
  ])
})
it('uses the most recent run-state assistant before older fallbacks', async () => {
  // Given
  const history = [10, 20].map((inputTokens) => ({
    role: 'assistant',
    providerOptions: { usage: { inputTokens, model: 'deepseek-v4' } },
  }))
  await writeCodebuff(home, [
    {
      ...message,
      metadata: {
        runState: {
          sessionState: { mainAgentState: { messageHistory: history } },
        },
      },
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ input: 20, tokens: 20, provider: 'deepseek' }),
  ])
})
it('uses chat timestamp when message timestamps are absent', async () => {
  // Given
  await writeCodebuff(
    home,
    [{ role: 'ai', metadata: message.metadata }],
    '.config/manicode/projects/p/chats/2026-11-16T16-00-00Z/chat-messages.json',
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expect.objectContaining({ date: '2026-11-17' })])
})
it('filters numeric epoch seconds by the requested window', async () => {
  // Given
  await writeCodebuff(home, [
    { ...message, timestamp: Date.parse(message.timestamp) / 1000 },
  ])
  // When
  const result = await read(Date.parse('2026-11-18T00:00:00Z'))
  // Then
  expect(result.rows).toEqual([])
})
it('appends projects to override roots only when needed', async () => {
  // Given
  await writeCodebuff(home)
  await writeCodebuff(
    home,
    [message],
    'custom/projects/project/chats/chat/chat-messages.json',
  )
  // When
  const result = await read(0, {
    CODEBUFF_DATA_DIR: ' ~/custom, ~/custom/projects ',
  })
  // Then
  expect(result.rows).toHaveLength(1)
})
it('does not restore defaults for a missing override', async () => {
  // Given
  await writeCodebuff(home)
  // When
  const result = await read(0, { CODEBUFF_DATA_DIR: '~/missing' })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('rejects a source whose day-model sum exceeds the cap', async () => {
  // Given
  await writeCodebuff(home, [
    message,
    {
      ...message,
      id: 'huge',
      metadata: {
        model: message.metadata.model,
        usage: { total: 100_000_000_000 },
      },
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason: 'Codebuff 기록을 읽지 못해 이번에는 빼고 올려요.',
  })
})
