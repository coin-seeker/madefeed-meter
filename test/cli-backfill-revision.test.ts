import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { BACKFILL_REVISION } from '../src/backfill'
import { readConfig, saveConfig } from '../src/config'
import { zstdDecompressor } from '../src/zstd'
import { cliFixture } from './cli-fixtures'
import { config } from './schedule-fixtures'

it.each(['available', 'unavailable', 'completed'] as const)(
  'uses the revision and capability to select the history window when %s',
  async (state) => {
    // Given: a record 29 days before now, outside the requested one-day window.
    const { runtime, home, bodies, diagnostic } = await cliFixture()
    const decompressor = zstdDecompressor()
    if (!decompressor) throw new TypeError('test requires Node.js 22.15+')
    const saved = {
      ...config,
      backfill: 'done' as const,
      ...(state === 'completed' ? { backfillRevision: BACKFILL_REVISION } : {}),
    }
    await saveConfig(home, saved)
    const file = join(home, '.config/madefeed/cli.json')
    const before = await readFile(file, 'utf8')
    await writeFile(
      join(home, '.gemini/tmp/older.json'),
      JSON.stringify({
        type: 'gemini',
        model: 'boundary',
        timestamp: '2026-10-18T09:00:00Z',
        tokens: { total: 7 },
      }),
    )
    // When
    await runCli(['upload', '--days', '1', '--no-auto'], {
      ...runtime,
      zstd: state === 'unavailable' ? null : decompressor,
    })
    // Then
    const backfills = state === 'available'
    expect(bodies).toHaveLength(1)
    if (backfills) {
      expect(bodies[0]).toMatchObject({
        backfill: true,
        backfillRevision: BACKFILL_REVISION,
      })
      expect(JSON.stringify(bodies)).toContain('boundary')
      expect(await readConfig(home)).toEqual({
        ...saved,
        backfillRevision: BACKFILL_REVISION,
      })
    } else {
      expect(bodies[0]).not.toHaveProperty('backfill')
      expect(bodies[0]).not.toHaveProperty('backfillRevision')
      expect(JSON.stringify(bodies)).not.toMatch(/boundary|"old"/)
      expect(await readFile(file, 'utf8')).toBe(before)
    }
    expect(diagnostic).toEqual(
      state === 'unavailable' ? [expect.stringContaining('22.15')] : [],
    )
  },
)

async function compressedRollout(home: string, data: Uint8Array) {
  const directory = join(home, '.codex/sessions/2026/11/16')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'rollout-a.jsonl.zst'), data)
}
const rollout = zlib.zstdCompressSync(
  [
    { type: 'turn_context', payload: { model: 'gpt-test' } },
    {
      type: 'event_msg',
      timestamp: '2026-11-16T00:00:00Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 70 } },
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n'),
)

it('re-sums once where compressed Codex logs become readable after a first sum without them', async () => {
  // Given: a compressed rollout, and a first thirty-day sum on a runtime that cannot read it.
  const { runtime, home, bodies, diagnostic } = await cliFixture()
  const decompressor = zstdDecompressor()
  if (!decompressor) throw new TypeError('test requires Node.js 22.15+')
  await compressedRollout(home, rollout)
  await saveConfig(home, config)
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: null })
  // When: the same device uploads twice where compressed logs are readable.
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  // Then: revision 1 without Codex, current revision with it exactly once, then a plain upload.
  expect(bodies).toEqual([
    expect.objectContaining({ backfill: true, backfillRevision: 1 }),
    expect.objectContaining({
      backfill: true,
      backfillRevision: BACKFILL_REVISION,
    }),
    expect.not.objectContaining({ backfill: true }),
  ])
  expect(JSON.stringify(bodies[0])).not.toContain('codex')
  expect(JSON.stringify(bodies[1])).toContain('"tool":"codex"')
  expect(diagnostic[0]).toContain('22.15')
  expect(await readConfig(home)).toMatchObject({
    backfill: 'done',
    backfillRevision: BACKFILL_REVISION,
  })
})

it('keeps the one-time re-sum when the Codex history cannot be read during it', async () => {
  // Given: an already summed device and a compressed rollout that is corrupt.
  const { runtime, home, bodies } = await cliFixture()
  const decompressor = zstdDecompressor()
  if (!decompressor) throw new TypeError('test requires Node.js 22.15+')
  await compressedRollout(home, rollout.subarray(0, rollout.length - 4))
  await saveConfig(home, { ...config, backfill: 'done' })
  // When
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  // Then: nothing is claimed, so a later run can still re-sum.
  expect(bodies).toEqual([expect.not.objectContaining({ backfill: true })])
  expect(await readConfig(home)).toEqual({ ...config, backfill: 'done' })
  // When: the log is readable again.
  await compressedRollout(home, rollout)
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  // Then
  expect(bodies[1]).toMatchObject({
    backfill: true,
    backfillRevision: BACKFILL_REVISION,
  })
  expect(await readConfig(home)).toMatchObject({
    backfillRevision: BACKFILL_REVISION,
  })
})

it.each([2, 3, 4])(
  're-sums revision %i once as revision 5 then sends plain uploads',
  async (revision) => {
    // Given
    const { runtime, home, bodies } = await cliFixture()
    const zstd = zstdDecompressor()
    if (!zstd) throw new TypeError('test requires Node.js 22.15+')
    await saveConfig(home, {
      ...config,
      backfill: 'done',
      backfillRevision: revision,
    })
    await writeFile(
      join(home, '.gemini/tmp/history.json'),
      JSON.stringify({
        type: 'gemini',
        model: 'history',
        timestamp: '2026-10-18T09:00:00Z',
        tokens: { total: 7 },
      }),
    )
    // When
    await runCli(['upload', '--no-auto'], { ...runtime, zstd })
    await runCli(['upload', '--no-auto'], { ...runtime, zstd })
    // Then
    expect(bodies).toEqual([
      expect.objectContaining({ backfill: true, backfillRevision: 5 }),
      expect.not.objectContaining({ backfill: true }),
    ])
    expect(JSON.stringify(bodies[0])).toContain('history')
    expect(await readConfig(home)).toMatchObject({ backfillRevision: 5 })
  },
)

it.each([
  {
    title: 'claims revision 3 while Hermes cannot be read, then 5 once it can',
    directory: '.hermes',
    file: 'state.db',
    reason: 'Hermes 기록을 읽지 못해 이번에는 빼고 올려요.',
    revision: 3,
  },
  {
    title: 'claims revision 3 while Antigravity cannot be read',
    directory: '.gemini/antigravity/conversations',
    file: 'x.db',
    reason: 'Antigravity 기록을 읽지 못해 이번에는 빼고 올려요.',
    revision: 3,
  },
  {
    title:
      'claims revision 4 while a new reader fails, then 5 once it recovers',
    directory: '.local/share/goose/sessions',
    file: 'sessions.db',
    reason: 'Goose 기록을 읽지 못해 이번에는 빼고 올려요.',
    revision: 4,
  },
])('$title', async ({ directory, file, reason, revision }) => {
  // Given: a first sum with an unreadable source in an isolated home.
  const { runtime, home, bodies, diagnostic } = await cliFixture()
  const zstd = zstdDecompressor()
  if (!zstd) throw new TypeError('test requires Node.js 22.15+')
  await saveConfig(home, config)
  const root = join(home, directory)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, file), 'not sqlite')
  // When: the source recovers before the second of three uploads.
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  await rm(root, { recursive: true })
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  // Then: the failed read preserves a revision-5 re-sum for the recovery.
  expect(bodies).toEqual([
    expect.objectContaining({ backfill: true, backfillRevision: revision }),
    expect.objectContaining({ backfill: true, backfillRevision: 5 }),
    expect.not.objectContaining({ backfill: true }),
  ])
  expect(diagnostic).toContain(reason)
  expect(await readConfig(home)).toMatchObject({ backfillRevision: 5 })
})

it('keeps a revision-3 device without a backfill while Hermes cannot be read', async () => {
  // Given: a revision-3 device and an unreadable Hermes database.
  const { runtime, home, bodies } = await cliFixture()
  const zstd = zstdDecompressor()
  if (!zstd) throw new TypeError('test requires Node.js 22.15+')
  await saveConfig(home, { ...config, backfill: 'done', backfillRevision: 3 })
  const file = join(home, '.config/madefeed/cli.json')
  const before = await readFile(file, 'utf8')
  await mkdir(join(home, '.hermes'), { recursive: true })
  await writeFile(join(home, '.hermes/state.db'), 'not sqlite')
  // When
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  // Then: a partial read cannot upgrade the device or rewrite its config.
  expect(bodies).toEqual([expect.not.objectContaining({ backfill: true })])
  expect(bodies[0]).not.toHaveProperty('backfillRevision')
  expect(await readFile(file, 'utf8')).toBe(before)
})
