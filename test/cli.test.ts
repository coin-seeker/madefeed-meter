import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli'
import { readConfig, saveConfig } from '../src/config'
import { MeterError } from '../src/aggregate'
import { RUN } from '../src/copy'
import { fixture, config } from './schedule-fixtures'
import { installSchedule } from '../src/schedule'
import { schedulePaths } from '../src/schedule-builders'

const homes: string[] = []
it('lists all supported tools and explains versioned history in help', async () => {
  // Given
  const output: string[] = []
  // When
  await runCli(['--help'], { output: (text) => output.push(text) })
  // Then
  expect(output.join('')).toContain('Pi, oh-my-pi, OmO, Antigravity')
  expect(output.join('')).toContain(
    '더 많은 기록을 읽는 버전에서는 지난 30일을 한 번 다시 합산해요.',
  )
})
it.each([2, 3, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null])(
  'reads only positive safe integer backfill revisions: %s',
  async (revision) => {
    // Given
    const { home } = await fixture()
    await saveConfig(home, config)
    await writeFile(
      join(home, '.config/madefeed/cli.json'),
      JSON.stringify({ ...config, backfillRevision: revision }),
    )
    // When
    const saved = await readConfig(home)
    // Then
    expect(saved).toEqual({
      ...config,
      ...(revision === 2 || revision === 3
        ? { backfillRevision: revision }
        : {}),
    })
  },
)
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
    env: {},
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
    env: {},
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
it('includes Gemini in the real dry-run body with an isolated environment', async () => {
  // Given
  const home = await mkdtemp(join(tmpdir(), 'madefeed-cli-gemini-'))
  homes.push(home)
  const directory = join(home, '.gemini/tmp')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session.json'),
    JSON.stringify({
      type: 'gemini',
      model: 'gemini-test',
      timestamp: '2026-11-15T15:00:00Z',
      tokens: {
        total: 3_000_000_000,
        input: 100,
        output: 20,
        cached: 30,
        thoughts: 5,
      },
    }),
  )
  const output: string[] = []
  // When
  await runCli(['upload', '--dry-run', '--days', '1', '--json'], {
    home,
    env: {},
    now: Date.parse('2026-11-16'),
    output: (text) => output.push(text),
    diagnostic: () => {},
    fetch: async () => {
      throw new TypeError('network forbidden')
    },
  })
  // Then
  expect(JSON.parse(output.join('')).rows).toEqual([
    {
      date: '2026-11-16',
      tool: 'gemini',
      model: 'gemini-test',
      provider: 'google',
      tokens: 3_000_000_000,
      input: 100,
      output: 25,
      cacheRead: 30,
      reasoning: 5,
    },
  ])
})
it.each(['0', '36', '1.5', 'NaN'])(
  'rejects invalid --days %s',
  async (days) => {
    // Given / When / Then
    await expect(
      runCli(['--dry-run', '--days', days], { env: {} }),
    ).rejects.toThrow('1~35')
  },
)

it('rejects auto on without a token with a controlled connection instruction', async () => {
  // Given
  const { home, exec, self } = await fixture()
  // When
  const result = runCli(['auto', 'on'], { home, exec, self, env: {} })
  // Then
  await expect(result).rejects.toBeInstanceOf(MeterError)
  await expect(result).rejects.toThrow(RUN)
})
it.each([['logout'], ['auto', 'off']])(
  'keeps scheduler defaults inert for %j',
  async (...args) => {
    // Given
    const { home, context, calls } = await fixture()
    await saveConfig(home, config)
    await installSchedule(context)
    const plist = schedulePaths(context).plist
    const before = await readFile(plist, 'utf8')
    calls.length = 0
    // When
    await runCli(args, {
      home,
      env: {},
      output: () => {},
      fetch: async () => Response.json({ ok: true }),
    })
    // Then
    expect(calls).toEqual([])
    expect(await readFile(plist, 'utf8')).toBe(before)
  },
)
it('ignores unknown stored auto choices while preserving known choices', async () => {
  // Given
  const { home } = await fixture()
  await saveConfig(home, { ...config, auto: 'off' })
  expect((await readConfig(home))?.auto).toBe('off')
  await writeFile(
    join(home, '.config/madefeed/cli.json'),
    JSON.stringify({ ...config, auto: 'unexpected' }),
  )
  // When
  const saved = await readConfig(home)
  // Then
  expect(saved).toEqual(config)
})
