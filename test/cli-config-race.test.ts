import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { logout, readConfig, saveConfig } from '../src/config'
import { config } from './schedule-fixtures'
import { cliFixture } from './cli-fixtures'

it.each(['manual', 'scheduled'])(
  'leaves a completed config untouched after %s upload',
  async (mode) => {
    // Given: noncanonical whitespace detects even an otherwise identical rewrite.
    const { runtime, home } = await cliFixture()
    await saveConfig(home, { ...config, backfill: 'done' })
    const file = join(home, '.config/madefeed/cli.json')
    const before =
      JSON.stringify({ ...config, backfill: 'done' }, null, 2) + '\n'
    await writeFile(file, before)
    // When
    await runCli(
      ['upload', '--no-auto', ...(mode === 'scheduled' ? ['--scheduled'] : [])],
      runtime,
    )
    // Then
    expect(await readFile(file, 'utf8')).toBe(before)
  },
)

it.each(['manual', 'scheduled'])(
  'preserves a newer login token during %s upload',
  async (mode) => {
    // Given
    const { runtime, home } = await cliFixture()
    await saveConfig(home, config)
    const replacement = {
      ...config,
      deviceToken: 'mfd_new',
      auto: 'off' as const,
    }
    // When: login replaces the saved token while the earlier upload is in flight.
    await runCli(
      ['upload', '--no-auto', ...(mode === 'scheduled' ? ['--scheduled'] : [])],
      {
        ...runtime,
        fetch: async (input, init) => {
          await saveConfig(home, replacement)
          return runtime.fetch(input, init)
        },
      },
    )
    // Then: neither the new token nor its pending backfill is overwritten.
    expect(await readConfig(home)).toEqual(replacement)
  },
)

it('marks backfill complete using the latest preferences for the same token', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await saveConfig(home, { ...config, auto: 'on' })
  // When
  await runCli(['upload', '--scheduled'], {
    ...runtime,
    fetch: async (input, init) => {
      await saveConfig(home, { ...config, auto: 'off' })
      return runtime.fetch(input, init)
    },
  })
  // Then
  expect(await readConfig(home)).toEqual({
    ...config,
    auto: 'off',
    backfill: 'done',
  })
})

it('does not recreate a config removed during an in-flight scheduled upload', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await saveConfig(home, config)
  // When
  await runCli(['upload', '--scheduled'], {
    ...runtime,
    fetch: async (input, init) => {
      await logout(home)
      return runtime.fetch(input, init)
    },
  })
  // Then
  expect(await readConfig(home)).toBeUndefined()
})
