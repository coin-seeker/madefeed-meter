import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
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
      ...(state === 'completed' ? { backfillRevision: 2 } : {}),
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
      expect(bodies[0]).toMatchObject({ backfill: true, backfillRevision: 2 })
      expect(JSON.stringify(bodies)).toContain('boundary')
      expect(await readConfig(home)).toEqual({ ...saved, backfillRevision: 2 })
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

it('re-sums once on a runtime that reads zstd after a first sum without it', async () => {
  // Given: a device whose first thirty-day sum ran where compressed logs were unreadable.
  const { runtime, home, bodies } = await cliFixture()
  const decompressor = zstdDecompressor()
  if (!decompressor) throw new TypeError('test requires Node.js 22.15+')
  await saveConfig(home, config)
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: null })
  // When: the same device uploads twice where compressed logs are readable.
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  await runCli(['upload', '--no-auto'], { ...runtime, zstd: decompressor })
  // Then: revision 1, then revision 2 exactly once, then a plain upload.
  expect(bodies).toEqual([
    expect.objectContaining({ backfill: true, backfillRevision: 1 }),
    expect.objectContaining({ backfill: true, backfillRevision: 2 }),
    expect.not.objectContaining({ backfill: true }),
  ])
  expect(await readConfig(home)).toMatchObject({
    backfill: 'done',
    backfillRevision: 2,
  })
})
