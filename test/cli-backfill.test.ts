import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { readConfig, saveConfig } from '../src/config'
import { config } from './schedule-fixtures'
import { cliFixture } from './cli-fixtures'

it.each(['login', 'upload'])(
  'uploads exactly thirty days after fresh %s saves its token',
  async (command) => {
    // Given: today, the inclusive thirty-day boundary, and a record just outside it.
    const { runtime, home, bodies, output } = await cliFixture()
    await writeFile(
      join(home, '.gemini/tmp/session.json'),
      JSON.stringify({
        messages: ['2026-11-16', '2026-10-18', '2026-10-17'].map((date) => ({
          type: 'gemini',
          model: date,
          timestamp: `${date}T00:00:00Z`,
          tokens: { total: 1 },
        })),
      }),
    )
    // When: authentication writes a source record, proving collection happens afterwards.
    await runCli(
      [command, '--url', config.url, '--days', '1', '--no-auto', '--json'],
      {
        ...runtime,
        fetch: async (input, init) => {
          if (String(input).endsWith('/usage')) {
            expect((await readConfig(home))?.deviceToken).toBe('mfd_test')
          }
          if (String(input).endsWith('/token')) {
            await writeFile(
              join(home, '.gemini/tmp/after-token.json'),
              JSON.stringify({
                type: 'gemini',
                model: 'after-token',
                timestamp: '2026-11-16T00:00:00Z',
                tokens: { total: 2 },
              }),
            )
          }
          return runtime.fetch(input, init)
        },
      },
    )
    // Then
    expect(bodies).toEqual([
      {
        deviceName: expect.any(String),
        backfill: true,
        rows: expect.arrayContaining([
          {
            date: '2026-10-18',
            tool: 'gemini',
            model: '2026-10-18',
            tokens: 1,
          },
          {
            date: '2026-11-16',
            tool: 'gemini',
            model: 'after-token',
            tokens: 2,
          },
        ]),
      },
    ])
    expect(JSON.stringify(bodies)).not.toContain('2026-10-17')
    expect((await readConfig(home))?.backfill).toBe('done')
    expect(output).toHaveLength(1)
    expect(JSON.parse(output.join(''))).toEqual({
      ...(command === 'login' ? { loggedIn: true } : {}),
      accepted: 1,
      ignored: 0,
      backfill: null,
      weekTokens: 12,
      votesGranted: 0,
    })
  },
)

it.each([[], ['--scheduled']])(
  'backfills a legacy config once on upload %j',
  async (...extra) => {
    // Given
    const { runtime, home, bodies } = await cliFixture()
    await saveConfig(home, { ...config, auto: 'off' })
    // When
    await runCli(['upload', '--days', '1', ...extra], runtime)
    await runCli(['upload', '--days', '1', ...extra], runtime)
    // Then: the older source is in the first request only, and auto preference survives.
    expect(bodies).toEqual([
      {
        deviceName: config.deviceName,
        backfill: true,
        rows: [
          { date: '2026-11-12', tool: 'gemini', model: 'old', tokens: 99 },
          {
            date: '2026-11-16',
            tool: 'gemini',
            model: 'gemini-test',
            tokens: 12,
          },
        ],
      },
      {
        deviceName: config.deviceName,
        rows: [
          {
            date: '2026-11-16',
            tool: 'gemini',
            model: 'gemini-test',
            tokens: 12,
          },
        ],
      },
    ])
    expect(await readConfig(home)).toEqual({
      ...config,
      auto: 'off',
      backfill: 'done',
    })
  },
)

it.each(['applied', 'closed', null])(
  'remembers a successful %s backfill and prints its result',
  async (backfill) => {
    // Given
    const { runtime, home, output } = await cliFixture()
    await saveConfig(home, config)
    // When
    await runCli(['upload', '--no-auto'], {
      ...runtime,
      fetch: async () =>
        Response.json({
          accepted: 1,
          ignored: 2,
          backfill,
          weekTokens: 12,
          votesGranted: 3,
          bankVotes: 7,
        }),
    })
    // Then
    expect((await readConfig(home))?.backfill).toBe('done')
    expect(output.join('\n')).toContain('제외한 기록 2건.')
    expect(output.join('\n')).toContain('누적 표 7표.')
    if (backfill === 'applied')
      expect(output.join('\n')).toContain(
        '처음 연결이라 지난 30일 사용량도 합산했어요.',
      )
    if (backfill === 'closed')
      expect(output.join('\n')).toContain(
        '이 계정은 지난 사용량을 이미 한 번 합산해서, 연결 전 기록은 빼고 올렸어요.',
      )
  },
)

it('keeps the backfill pending when upload fails', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await saveConfig(home, config)
  // When / Then
  await expect(
    runCli(['upload', '--no-auto'], {
      ...runtime,
      fetch: async () => Response.json({}, { status: 503 }),
    }),
  ).rejects.toThrow('HTTP 503')
  expect((await readConfig(home))?.backfill).toBeUndefined()
})

it('keeps dry-run offline and leaves a legacy backfill pending', async () => {
  // Given
  const { runtime, home, output } = await cliFixture()
  await saveConfig(home, config)
  // When
  await runCli(['upload', '--dry-run', '--days', '1', '--json'], {
    ...runtime,
    fetch: async () => {
      throw new TypeError('network forbidden')
    },
  })
  // Then
  expect(JSON.parse(output.join(''))).toEqual({
    deviceName: config.deviceName,
    rows: [
      { date: '2026-11-16', tool: 'gemini', model: 'gemini-test', tokens: 12 },
    ],
  })
  expect(await readConfig(home)).toEqual(config)
})

it('preserves the completed marker through automatic upload preference changes', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await saveConfig(home, { ...config, backfill: 'done' })
  // When
  await runCli(['auto', 'on'], runtime)
  await runCli(['auto', 'off'], runtime)
  // Then
  expect(await readConfig(home)).toEqual({
    ...config,
    backfill: 'done',
    auto: 'off',
  })
})
