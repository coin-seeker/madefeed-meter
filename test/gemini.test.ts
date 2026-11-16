import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregate } from '../src/aggregate'
import { readGemini } from '../src/sources/gemini'

const sinceMs = Date.parse('2026-11-14T15:00:00Z')
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-gemini-'))
  homes.push(home)
  const root = join(home, '.gemini/tmp/project/chats')
  await mkdir(root, { recursive: true })
  return { home, root, sinceMs, env: {} }
}

it('reads session messages with cached input normalization, aliases and session-time fallback', async () => {
  // Given
  const options = await fixture()
  await writeFile(
    join(options.root, 'session.json'),
    JSON.stringify({
      startTime: '2026-11-14T15:00:00Z',
      messages: [
        {
          type: 'gemini',
          model: 'inclusive',
          tokens: { input: 100, cached: 40, output: 10, total: 110 },
        },
        {
          type: 'gemini',
          model: 'exclusive',
          tokens: { input: 100, cached: 40, output: 10 },
        },
        {
          type: 'gemini',
          model: 'aliases',
          tokens: {
            prompt_tokens: 10.9,
            candidates_tokens: 2.8,
            cached_tokens: 3,
            reasoning_tokens: 4,
            tool_tokens: 5,
            total_tokens: 1,
          },
        },
        { type: 'gemini', model: 'larger', tokens: { input: 1, total: 99 } },
        { type: 'gemini', model: 'zero', tokens: { input: -2, output: '9' } },
        { type: 'gemini', tokens: { total: 99 } },
        { type: 'user', model: 'skip', tokens: { total: 99 } },
        {
          type: 'gemini',
          model: 'old',
          timestamp: '2026-11-14T14:59:59Z',
          tokens: { total: 99 },
        },
      ],
    }),
  )
  // When
  const result = await readGemini(options)
  // Then
  expect(aggregate(result.rows)).toEqual([
    { date: '2026-11-15', tool: 'gemini', model: 'aliases', tokens: 24 },
    { date: '2026-11-15', tool: 'gemini', model: 'exclusive', tokens: 150 },
    { date: '2026-11-15', tool: 'gemini', model: 'inclusive', tokens: 110 },
    { date: '2026-11-15', tool: 'gemini', model: 'larger', tokens: 99 },
  ])
})

it('replaces direct JSONL ids before window filtering and retains model hints and additive stats', async () => {
  // Given
  const options = await fixture()
  const lines = [
    { sessionId: 'session', model: 'hint' },
    {
      type: 'gemini',
      id: 'replace',
      timestamp: '2026-11-15T15:00:00Z',
      tokens: { total: 500 },
    },
    {
      type: 'gemini',
      id: 'replace',
      created_at: '2026-11-15T15:00:00Z',
      tokens: { total: 20 },
    },
    {
      type: 'gemini',
      id: 'old',
      timestamp: '2026-11-15T15:00:00Z',
      tokens: { total: 1000 },
    },
    {
      type: 'gemini',
      id: 'old',
      timestamp: '2026-11-14T14:59:59Z',
      tokens: { total: 1 },
    },
    {
      timestamp: '2026-11-15T15:00:00Z',
      stats: { input: 20, cached: 10, output: 3 },
    },
    { timestamp: '2026-11-15T15:00:00Z', result: { stats: { input: 2 } } },
  ]
  await writeFile(
    join(options.root, 'events.jsonl'),
    [...lines.map((value) => JSON.stringify(value)), '{broken'].join('\n'),
  )
  // When
  const result = await readGemini(options)
  // Then
  expect(aggregate(result.rows)).toEqual([
    { date: '2026-11-16', tool: 'gemini', model: 'hint', tokens: 45 },
  ])
})

it('reads stats per model and nested flat stats with the max rule', async () => {
  // Given
  const options = await fixture()
  await writeFile(
    join(options.root, 'models.json'),
    JSON.stringify({
      timestamp: '2026-11-14T15:00:00Z',
      stats: {
        models: {
          first: {
            tokens: { input: 100, cached: 40, output: 10, thoughts: 2 },
          },
          second: {
            tokens: {
              prompt: 2,
              candidates: 3,
              reasoning: 4,
              tool: 5,
              total: 100,
            },
          },
        },
      },
    }),
  )
  await writeFile(
    join(options.root, 'flat.json'),
    JSON.stringify({
      timestamp: '2026-11-14T15:00:00Z',
      result: { stats: { input_tokens: 3, output_tokens: 4 } },
    }),
  )
  // When
  const result = await readGemini(options)
  // Then
  expect(aggregate(result.rows)).toEqual([
    { date: '2026-11-15', tool: 'gemini', model: 'first', tokens: 112 },
    { date: '2026-11-15', tool: 'gemini', model: 'second', tokens: 100 },
    { date: '2026-11-15', tool: 'gemini', model: 'unknown', tokens: 7 },
  ])
})

it('honors comma roots without cross-file dedupe and skips old or invalid files', async () => {
  // Given
  const options = await fixture()
  const other = join(options.home, 'other')
  await mkdir(other)
  const data = JSON.stringify({
    type: 'gemini',
    model: 'model',
    timestamp: 'invalid',
    created_at: '2026-11-14T15:00:00Z',
    tokens: { total: 8 },
  })
  await writeFile(join(options.root, 'a.json'), data)
  await writeFile(join(other, 'b.json'), data)
  await writeFile(join(other, 'invalid.json'), '{invalid')
  const old = join(other, 'old.json')
  await writeFile(old, data)
  await utimes(old, new Date(0), new Date(0))
  // When
  const result = await readGemini({
    ...options,
    env: {
      GEMINI_DATA_DIR: `${options.root},${other},${join(options.home, 'missing')}`,
    },
  })
  // Then
  expect(aggregate(result.rows)).toEqual([
    { date: '2026-11-15', tool: 'gemini', model: 'model', tokens: 16 },
  ])
})

it('uses lastUpdated and file mtime fallbacks and treats a missing root as empty', async () => {
  // Given
  const options = await fixture()
  await writeFile(
    join(options.root, 'session.json'),
    JSON.stringify({
      startTime: 'invalid',
      lastUpdated: '2026-11-14T15:00:00Z',
      messages: [{ type: 'gemini', model: 'model', tokens: { total: 2 } }],
    }),
  )
  const path = join(options.root, 'direct.json')
  await writeFile(
    path,
    JSON.stringify({ type: 'gemini', model: 'model', tokens: { total: 3 } }),
  )
  await utimes(path, new Date(sinceMs), new Date(sinceMs))
  // When
  const result = await readGemini(options)
  const missing = await readGemini({
    ...options,
    env: { GEMINI_DATA_DIR: join(options.home, 'missing') },
  })
  // Then
  expect(aggregate(result.rows)[0]?.tokens).toBe(5)
  expect(missing).toEqual({ supported: true, rows: [] })
})
