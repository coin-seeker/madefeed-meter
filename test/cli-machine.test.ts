import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { MeterError } from '../src/aggregate'
import { readConfig, saveConfig } from '../src/config'
import { cliFixture } from './cli-fixtures'
import { config } from './schedule-fixtures'

const denied =
  '이 컴퓨터는 다른 계정에 연결돼 있거나 미터 사용이 제한돼 있어 연결하지 못했어요. 다른 계정에서 먼저 연결을 끊고(logout) 다시 시도해 주세요.'

it('sends the injected hash in device requests and uploads without saving it', async () => {
  // Given
  const { runtime, home, bodies } = await cliFixture()
  const devices: unknown[] = []
  // When
  await runCli(['login', '--url', config.url, '--no-auto'], {
    ...runtime,
    fetch: async (input, init) => {
      if (String(input).endsWith('/device'))
        devices.push(JSON.parse(String(init?.body)))
      return runtime.fetch(input, init)
    },
  })
  // Then
  expect(devices).toEqual([
    { deviceName: expect.any(String), machineId: 'a'.repeat(64) },
  ])
  expect(bodies).toEqual([
    expect.objectContaining({ machineId: 'a'.repeat(64) }),
  ])
  expect(await readConfig(home)).not.toHaveProperty('machineId')
})

it.each(['missing', 'error', 'empty', 'invalid'] as const)(
  'fails a new connection before network when the hash is %s',
  async (kind) => {
    // Given
    const { runtime, requests } = await cliFixture()
    const { machineId: _machineId, ...inert } = runtime
    const read =
      kind === 'missing'
        ? {}
        : {
            machineId: async () => {
              if (kind === 'error') throw new TypeError('PRIVATE-RAW')
              return kind === 'empty' ? '' : 'invalid'
            },
          }
    // When
    const result = runCli(['login', '--url', config.url, '--no-auto'], {
      ...inert,
      ...read,
    })
    // Then
    await expect(result).rejects.toBeInstanceOf(MeterError)
    await expect(result).rejects.toThrow(
      '컴퓨터 식별값을 읽지 못해 연결하지 못했어요.',
    )
    expect(requests).toEqual([])
  },
)

it.each([[], ['--scheduled']])(
  'uploads an existing device without the unreadable hash %j',
  async (...extra) => {
    // Given
    const { runtime, home, bodies } = await cliFixture()
    await saveConfig(home, {
      ...config,
      backfill: 'done',
      backfillRevision: 2,
      auto: 'off',
    })
    // When
    await runCli(['upload', ...extra], {
      ...runtime,
      machineId: async () => {
        throw new TypeError('PRIVATE-RAW')
      },
    })
    // Then
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('machineId')
  },
)

it('does not read the machine identifier for dry-run', async () => {
  // Given
  const { runtime, requests, output } = await cliFixture()
  let reads = 0
  // When
  await runCli(['upload', '--dry-run', '--json'], {
    ...runtime,
    machineId: async () => {
      reads++
      return 'b'.repeat(64)
    },
  })
  // Then
  expect(reads).toBe(0)
  expect(requests).toEqual([])
  expect(JSON.parse(output.join(''))).not.toHaveProperty('machineId')
})

it.each(['access_denied', { code: 'access_denied' }])(
  'stops polling immediately on %j without saving a connection',
  async (error) => {
    // Given
    const { runtime, home } = await cliFixture()
    let polls = 0
    // When
    const result = runCli(['login', '--url', config.url, '--no-auto'], {
      ...runtime,
      fetch: async (input, init) => {
        if (String(input).endsWith('/token')) {
          polls++
          return Response.json({ error }, { status: 400 })
        }
        return runtime.fetch(input, init)
      },
    })
    // Then
    await expect(result).rejects.toBeInstanceOf(MeterError)
    await expect(result).rejects.toThrow(denied)
    expect(polls).toBe(1)
    expect(await readConfig(home)).toBeUndefined()
  },
)

it.each(['upgrade_required', { code: 'upgrade_required' }])(
  'reports the latest CLI command on %j',
  async (error) => {
    // Given
    const { runtime } = await cliFixture()
    const requests: string[] = []
    // When
    const result = runCli(['login', '--url', config.url, '--no-auto'], {
      ...runtime,
      fetch: async (input) => {
        requests.push(String(input))
        return Response.json({ error }, { status: 400 })
      },
    })
    // Then
    await expect(result).rejects.toBeInstanceOf(MeterError)
    await expect(result).rejects.toThrow(
      '새 연결에는 최신 토큰 미터가 필요해요. npx @the-seeker/madefeed@latest 를 실행해 주세요.',
    )
    expect(requests).toEqual([`${config.url}/api/meter/device`])
  },
)
