import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDroid } from '../src/sources/droid'
import { droidSettings, writeDroid } from './ccusage-fixtures/droid'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'meter-droid-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const read = (sinceMs = 0, env = {}) => readDroid({ home, sinceMs, env })

it('normalizes model and includes thinking in output but not twice in total', async () => {
  // Given
  await writeDroid(home)
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-17',
        tool: 'droid',
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        input: 100,
        output: 55,
        reasoning: 5,
        cacheWrite: 20,
        cacheRead: 10,
        tokens: 185,
      },
    ],
  })
})
it('selects the latest snapshot per session before window filtering', async () => {
  // Given
  await writeDroid(
    home,
    {
      ...droidSettings,
      providerLockTimestamp: '2026-11-18T00:00:00Z',
      tokenUsage: { inputTokens: 7 },
    },
    '.factory/sessions/a/shared.settings.json',
  )
  await writeDroid(
    home,
    droidSettings,
    '.factory/sessions/z/shared.settings.json',
  )
  // When
  const result = await read(Date.parse('2026-11-18T00:00:00Z'))
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ date: '2026-11-18', tokens: 7 }),
  ])
})
it('finds a sidecar model in the first 500 lines', async () => {
  // Given
  const path = await writeDroid(home, { tokenUsage: { inputTokens: 4 } })
  await writeFile(
    path.replace('.settings.json', '.jsonl'),
    '{"text":"Model: custom:GLM.4 [Vendor]"}\n',
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ model: 'glm-4', provider: 'zai', tokens: 4 }),
  ])
})
it('ignores sidecar models beyond line 500 and falls back to provider model', async () => {
  // Given
  const path = await writeDroid(home, {
    providerLock: 'Vertex-AI',
    tokenUsage: { inputTokens: 4 },
  })
  await writeFile(
    path.replace('.settings.json', '.jsonl'),
    '\n'.repeat(500) + 'Model: gpt-5',
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ model: 'gemini-unknown', provider: 'vertex_ai' }),
  ])
})
it('uses mtime when providerLockTimestamp is invalid', async () => {
  // Given
  const path = await writeDroid(home, {
    ...droidSettings,
    providerLockTimestamp: 'invalid',
  })
  const ms = Date.parse('2026-11-20T16:00:00Z')
  await utimes(path, new Date(ms), new Date(ms))
  // When
  const result = await read(ms)
  // Then
  expect(result.rows).toEqual([expect.objectContaining({ date: '2026-11-21' })])
})
it('excludes a snapshot before the window even with recent mtime', async () => {
  // Given
  await writeDroid(home)
  // When
  const result = await read(Date.parse('2026-11-18T00:00:00Z'))
  // Then
  expect(result.rows).toEqual([])
})
it('replaces defaults with deduplicated trimmed tilde roots', async () => {
  // Given
  await writeDroid(home)
  await writeDroid(home, droidSettings, 'custom/session.settings.json')
  // When
  const result = await read(0, { DROID_SESSIONS_DIR: ' ~/custom, ~/custom ' })
  // Then
  expect(result.rows).toHaveLength(1)
})
it('keeps missing override roots empty rather than reading defaults', async () => {
  // Given
  await writeDroid(home)
  // When
  const result = await read(0, { DROID_SESSIONS_DIR: '~/missing' })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('preserves unclassified total without inventing parts', async () => {
  // Given
  await writeDroid(home, { ...droidSettings, tokenUsage: { totalTokens: 20 } })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-17',
      tool: 'droid',
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      tokens: 20,
    },
  ])
})
it('skips a malformed file without discarding other sessions', async () => {
  // Given
  await writeDroid(home)
  const path = await writeDroid(home, {}, '.factory/sessions/bad.settings.json')
  await writeFile(path, '{')
  // When
  const result = await read()
  // Then
  expect(result.rows).toHaveLength(1)
})
it('rejects a source whose daily model sum exceeds the cap', async () => {
  // Given
  await writeDroid(home)
  await writeDroid(
    home,
    { ...droidSettings, tokenUsage: { totalTokens: 100_000_000_000 } },
    '.factory/sessions/huge.settings.json',
  )
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason: 'Droid 기록을 읽지 못해 이번에는 빼고 올려요.',
  })
})
