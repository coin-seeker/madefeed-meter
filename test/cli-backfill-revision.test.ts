import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

it('re-sums revision 2 once as revision 3 then sends plain uploads', async () => {
  // Given
  const { runtime, home, bodies } = await cliFixture()
  const zstd = zstdDecompressor()
  if (!zstd) throw new TypeError('test requires Node.js 22.15+')
  await saveConfig(home, { ...config, backfill: 'done', backfillRevision: 2 })
  // When
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  await runCli(['upload', '--no-auto'], { ...runtime, zstd })
  // Then
  expect(bodies).toEqual([
    expect.objectContaining({ backfill: true, backfillRevision: 3 }),
    expect.not.objectContaining({ backfill: true }),
  ])
  expect(await readConfig(home)).toMatchObject({ backfillRevision: 3 })
})
