import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli'
import { readConfig, saveConfig } from '../src/config'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
it('dry-run never calls injected fetch and prints the exact upload body without login', async () => {
  // Given
  const home = await mkdtemp(join(tmpdir(), 'madefeed-cli-'))
  homes.push(home)
  let calls = 0
  const output: string[] = []
  // When
  await runCli(['upload', '--dry-run', '--days', '1', '--json'], {
    home,
    now: Date.parse('2026-11-16'),
    fetch: async () => {
      calls++
      throw new TypeError('network forbidden')
    },
    output: (text) => output.push(text),
  })
  // Then
  expect(calls).toBe(0)
  expect(JSON.parse(output.join(''))).toEqual({
    deviceName: expect.any(String),
    rows: [],
  })
})
it('stores config at 0600 and status never prints a token', async () => {
  // Given
  const home = await mkdtemp(join(tmpdir(), 'madefeed-config-'))
  homes.push(home)
  const config = {
    url: 'https://example.com',
    deviceName: 'test-device',
    deviceToken: 'mfd_test',
  }
  await saveConfig(home, config)
  const output: string[] = []
  // When
  await runCli(['status', '--json'], {
    home,
    output: (text) => output.push(text),
  })
  // Then
  expect(await readConfig(home)).toEqual(config)
  expect(
    (await stat(join(home, '.config/madefeed/cli.json'))).mode & 0o777,
  ).toBe(0o600)
  expect(
    await readFile(join(home, '.config/madefeed/cli.json'), 'utf8'),
  ).toContain('mfd_test')
  expect(output.join('')).not.toContain('mfd_test')
})
it.each(['0', '36', '1.5', 'NaN'])(
  'rejects invalid --days %s',
  async (days) => {
    // Given / When / Then
    await expect(runCli(['--dry-run', '--days', days])).rejects.toThrow('1~35')
  },
)
