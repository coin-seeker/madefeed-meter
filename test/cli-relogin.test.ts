import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { BACKFILL_REVISION } from '../src/backfill'
import { readConfig, saveConfig } from '../src/config'
import { config } from './schedule-fixtures'
import { cliFixture } from './cli-fixtures'

it.each(['revoked', 'unreachable', 'different-origin'])(
  'orders re-login safely when %s',
  async (scenario) => {
    // Given
    const { runtime, home, diagnostic } = await cliFixture()
    await saveConfig(home, {
      ...config,
      deviceToken: 'mfd_old',
      backfill: 'done',
      backfillRevision: BACKFILL_REVISION,
    })
    const calls: {
      readonly url: string
      readonly authorization: string | null
    }[] = []
    const url =
      scenario === 'different-origin' ? 'https://other.example.com' : config.url
    // When
    await runCli(['login', '--url', url, '--no-auto'], {
      ...runtime,
      zstd: () => new PassThrough(),
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })
        if (String(input).endsWith('/revoke') && scenario === 'unreachable')
          throw new TypeError('offline')
        if (String(input).endsWith('/usage') && scenario !== 'different-origin')
          expect(await readConfig(home)).toMatchObject({
            backfill: 'done',
            backfillRevision: BACKFILL_REVISION,
          })
        return runtime.fetch(input, init)
      },
    })
    // Then: the old credential is used only for a same-origin revoke, after token acquisition.
    expect(calls).toEqual([
      { url: `${url}/api/meter/device`, authorization: null },
      { url: `${url}/api/meter/token`, authorization: null },
      ...(scenario === 'different-origin'
        ? []
        : [
            {
              url: `${config.url}/api/meter/revoke`,
              authorization: 'Bearer mfd_old',
            },
          ]),
      { url: `${url}/api/meter/usage`, authorization: 'Bearer mfd_test' },
    ])
    expect(await readConfig(home)).toMatchObject({
      url,
      deviceToken: 'mfd_test',
      backfill: 'done',
      backfillRevision: BACKFILL_REVISION,
    })
    expect(diagnostic).toEqual(
      scenario === 'unreachable'
        ? [
            `이전 기기 연결을 끊지 못했어요. ${config.url}/meter 에서 이전 기기 연결을 끊어 주세요.`,
          ]
        : [],
    )
  },
)

it('keeps the previous token when a new login is not approved', async () => {
  // Given
  const { runtime, home, requests } = await cliFixture()
  await saveConfig(home, config)
  // When / Then
  await expect(
    runCli(['login', '--no-auto'], {
      ...runtime,
      fetch: async (input, init) =>
        String(input).endsWith('/token')
          ? Response.json({ error: 'expired_token' }, { status: 400 })
          : runtime.fetch(input, init),
    }),
  ).rejects.toThrow('만료')
  expect(requests).toEqual([`${config.url}/api/meter/device`])
  expect(await readConfig(home)).toEqual(config)
})

it('prints the connected line followed by the login upload result', async () => {
  // Given
  const { runtime, output } = await cliFixture()
  // When
  await runCli(['login', '--url', config.url, '--no-auto'], {
    ...runtime,
    fetch: async (input, init) =>
      String(input).endsWith('/usage')
        ? Response.json({
            accepted: 2,
            ignored: 0,
            backfill: 'applied',
            weekTokens: 111,
            votesGranted: 1,
            bankVotes: 4,
          })
        : runtime.fetch(input, init),
  })
  // Then
  expect(output.at(-2)).toMatch(/ 기기를 연결했어요\.$/)
  expect(output.at(-1)).toBe(
    '사용량 2건을 올렸어요. 새로 받은 표 1표.\n지난 30일 사용량도 한 번 합산했어요.\n누적 표 4표.',
  )
})
