import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDroid } from '../src/sources/droid'
import { kstDateOf } from '../src/kst'
import { writeDroid } from './ccusage-fixtures/droid'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'droid-stable-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const read = () => readDroid({ home, sinceMs: 0, env: {} })

it('keeps the birth date when a timestamp-free file is modified next day', async () => {
  // Given
  const path = await writeDroid(home, {
    model: 'gpt-5',
    tokenUsage: { totalTokens: 10 },
  })
  const birth = (await stat(path)).birthtimeMs
  await utimes(path, new Date(birth), new Date(birth))
  const before = await read()
  // When
  await utimes(path, new Date(birth + 86400000), new Date(birth + 86400000))
  const after = await read()
  // Then
  expect(after.rows).toEqual(before.rows)
  expect(after.rows[0]?.date).toBe(kstDateOf(birth))
})

it('uses the earliest creation field before a later provider lock', async () => {
  // Given
  await writeDroid(home, {
    createdAt: '2026-11-15T16:00:00Z',
    created_at: '2026-11-14T16:00:00Z',
    providerLockTimestamp: '2026-11-17T16:00:00Z',
    tokenUsage: { totalTokens: 10 },
  })
  // When
  const result = await read()
  // Then
  expect(result.rows[0]?.date).toBe('2026-11-15')
})

it('uses the first sidecar timestamp even when settings already have a model', async () => {
  // Given
  const path = await writeDroid(home, {
    model: 'gpt-5',
    providerLockTimestamp: '2026-11-17T16:00:00Z',
    tokenUsage: { totalTokens: 10 },
  })
  await writeFile(
    path.replace('.settings.json', '.jsonl'),
    JSON.stringify({
      type: 'session_start',
      timestamp: '2026-11-14T16:00:00Z',
    }) + '\n',
  )
  // When
  const result = await read()
  // Then
  expect(result.rows[0]?.date).toBe('2026-11-15')
})

it('selects the latest snapshot by modification time rather than its stable date', async () => {
  // Given
  const older = await writeDroid(
    home,
    { createdAt: '2026-11-14T16:00:00Z', tokenUsage: { totalTokens: 10 } },
    '.factory/sessions/z/shared.settings.json',
  )
  const newer = await writeDroid(
    home,
    { createdAt: '2026-11-14T16:00:00Z', tokenUsage: { totalTokens: 20 } },
    '.factory/sessions/a/shared.settings.json',
  )
  await utimes(older, 100, 100)
  await utimes(newer, 200, 200)
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    expect.objectContaining({ date: '2026-11-15', tokens: 20 }),
  ])
})
