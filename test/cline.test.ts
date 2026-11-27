import { afterEach, beforeEach, expect, it } from 'vitest'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readCline } from '../src/sources/cline'
import { fixture, ms } from './t8-fixture'

let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  f = await fixture()
})
afterEach(async () => {
  await f.remove()
})
const extension = {
  ts: ms,
  type: 'say',
  say: 'api_req_started',
  modelInfo: { modelId: 'claude-sonnet-4', providerId: 'openrouter' },
  text: JSON.stringify({
    tokensIn: 100,
    tokensOut: 20,
    cacheReads: 5,
    cacheWrites: 10,
  }),
}
const cli = {
  role: 'assistant',
  ts: ms,
  modelInfo: { id: 'qwen3-coder', provider: 'custom' },
  metrics: {
    inputTokens: 100,
    outputTokens: 15,
    cacheReadTokens: 25,
    cacheWriteTokens: 10,
  },
}
const read = (env: Readonly<Record<string, string>> = {}) =>
  readCline({ home: f.home, sinceMs: 0, env })

it.each(['tasks/a/ui_messages.json', 'data/tasks/a/ui_messages.json'])(
  'keeps extension input exclusive when reading %s',
  async (path) => {
    // Given
    await f.put(`.cline/${path}`, [extension])
    // When
    const result = await read()
    // Then
    expect(result).toEqual({
      supported: true,
      rows: [
        {
          date: '2026-11-17',
          tool: 'cline',
          model: 'claude-sonnet-4',
          provider: 'openrouter',
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 10,
          tokens: 135,
        },
      ],
    })
  },
)
it.each(['sessions/a/a.messages.json', 'data/sessions/a/a.messages.json'])(
  'subtracts CLI cache when reading %s',
  async (path) => {
    // Given
    await f.put(`.cline/${path}`, { messages: [cli] })
    // When
    const result = await read()
    // Then
    expect(result.rows).toEqual([
      expect.objectContaining({
        input: 65,
        output: 15,
        cacheRead: 25,
        cacheWrite: 10,
        tokens: 115,
        provider: 'custom',
      }),
    ])
  },
)
it('ignores rollups, partials, missing counters and unknown models', async () => {
  // Given
  await f.put('.cline/tasks/a/ui_messages.json', [
    { ...extension, say: 'subagent_usage' },
    { ...extension, say: 'deleted_api_reqs' },
    { ...extension, partial: true },
    { ...extension, text: '{' },
    { ...extension, text: '{"tokensIn":10}' },
    { ...extension, modelInfo: { modelId: 'UnKnOwN' } },
    { ...extension, modelInfo: { modelId: '' } },
    {
      ...extension,
      text: '{"tokensIn":1.5,"tokensOut":2,"cacheReads":0,"cacheWrites":0}',
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('rejects invalid ts without timestamp fallback and cache exceeding input', async () => {
  // Given
  await f.put('.cline/sessions/a/a.messages.json', {
    messages: [
      { ...cli, ts: null, timestamp: new Date(ms).toISOString() },
      { ...cli, ts: -1 },
      { ...cli, metrics: { ...cli.metrics, inputTokens: 1 } },
    ],
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('uses timestamp only when ts is absent and infers absent provider', async () => {
  // Given
  const { ts, ...message } = cli
  await f.put('.cline/sessions/a/a.messages.json', {
    messages: [
      {
        ...message,
        timestamp: new Date(ts).toISOString(),
        modelInfo: { id: 'qwen3-coder' },
      },
    ],
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ provider: 'alibaba', tokens: 115 }),
  ])
})
it.each([
  'tasks/nested/a/ui_messages.json',
  'sessions/a/wrong.messages.json',
  'data/tasks/a/extra/ui_messages.json',
])('ignores non-exact layout %s', async (path) => {
  // Given
  await f.put(`.cline/${path}`, [extension])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it.each([
  'Library/Application Support/Code',
  '.config/Cursor',
  'AppData/Roaming/VSCodium',
])('discovers editor storage at %s', async (editor) => {
  // Given
  await f.put(
    `${editor}/User/globalStorage/saoudrizwan.claude-dev/tasks/a/ui_messages.json`,
    [extension],
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(1)
})
it('deduplicates canonical files across roots without deduplicating request ids', async () => {
  // Given
  const path = await f.put('.cline/tasks/a/ui_messages.json', [
    extension,
    extension,
  ])
  await f.put('other/tasks/a/placeholder', '')
  await symlink(path, join(f.home, 'other/tasks/a/ui_messages.json'))
  // When
  const result = await read({
    CLINE_DATA_DIR: `~/.cline, ${join(f.home, 'other')}`,
  })
  // Then
  expect(result.rows).toHaveLength(2)
})
it('does not fall back to default for nonexistent override roots', async () => {
  // Given
  await f.put('.cline/tasks/a/ui_messages.json', [extension])
  // When
  const result = await read({ CLINE_DATA_DIR: join(f.home, 'missing') })
  // Then
  expect(result.rows).toEqual([])
})
it('returns an unsupported whole source when day/model totals exceed the cap', async () => {
  // Given
  const huge = {
    ...extension,
    text: JSON.stringify({
      tokensIn: 60_000_000_000,
      tokensOut: 0,
      cacheReads: 0,
      cacheWrites: 0,
    }),
  }
  await f.put('.cline/tasks/a/ui_messages.json', [huge, huge])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    reason: 'Cline 기록을 읽지 못해 이번에는 빼고 올려요.',
    rows: [],
  })
})
it('filters events by their timestamp rather than file time', async () => {
  // Given
  await f.put('.cline/tasks/a/ui_messages.json', [extension])
  // When
  const result = await readCline({ home: f.home, sinceMs: ms + 1, env: {} })
  // Then
  expect(result.rows).toEqual([])
})
