import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { MeterError } from '../src/aggregate'
import { readConfig, saveConfig } from '../src/config'
import { schedulePaths } from '../src/schedule-builders'
import { cliFixture } from './cli-fixtures'
import { config } from './schedule-fixtures'

const unauthorized = () =>
  Response.json({ error: { code: 'unauthorized' } }, { status: 401 })

it('cleans scheduled disconnections before bootout and resolves with one line', async () => {
  // Given
  const f = await cliFixture()
  await saveConfig(f.home, config)
  await runCli(['auto', 'on'], f.runtime)
  const directory = join(f.home, '.config/madefeed')
  await writeFile(join(directory, 'auto.log'), 'log')
  const paths = [
    schedulePaths(f.context).plist,
    join(directory, 'agent'),
    join(directory, 'auto.log'),
    join(directory, 'cli.json'),
  ]
  f.output.length = 0
  let checked = false
  // When
  await expect(
    runCli(['upload', '--scheduled'], {
      ...f.runtime,
      fetch: async () => unauthorized(),
      exec: async (file, args, options) => {
        if (args[0] === 'bootout') {
          for (const path of paths)
            await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(f.output).toHaveLength(1)
          checked = true
        }
        return f.exec(file, args, options)
      },
    }),
  ).resolves.toBeUndefined()
  // Then
  expect(checked).toBe(true)
  expect(f.output).toHaveLength(1)
  for (const path of paths)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cleans interactive disconnections and rejects with MeterError', async () => {
  // Given
  const { home, runtime } = await cliFixture()
  await saveConfig(home, config)
  // When
  const result = runCli(['upload', '--no-auto'], {
    ...runtime,
    fetch: async () => unauthorized(),
  })
  // Then
  await expect(result).rejects.toBeInstanceOf(MeterError)
  expect(await readConfig(home)).toBeUndefined()
})

it('keeps config for an unclassified HTTP 401', async () => {
  // Given
  const { home, runtime } = await cliFixture()
  await saveConfig(home, config)
  // When
  const result = runCli(['upload', '--no-auto'], {
    ...runtime,
    fetch: async () => Response.json({}, { status: 401 }),
  })
  // Then
  await expect(result).rejects.toThrow('HTTP 401')
  expect(await readConfig(home)).toEqual(config)
})

it.each(['revoked', 'already', 'unreachable', 'malformed', 'legacy'] as const)(
  'revokes only at the issuing URL and cleans local files for %s',
  async (outcome) => {
    // Given
    const f = await cliFixture()
    await saveConfig(f.home, config)
    await runCli(['auto', 'on'], f.runtime)
    const directory = join(f.home, '.config/madefeed')
    await writeFile(join(directory, 'auto.log'), 'log')
    f.output.length = 0
    const requests: {
      readonly url: string
      readonly authorization: string | null
      readonly body: unknown
    }[] = []
    // When
    await runCli(['logout', '--json', '--url', 'https://other.example'], {
      ...f.runtime,
      env: { MADEFEED_URL: 'https://ignored.example' },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        })
        switch (outcome) {
          case 'revoked':
            return Response.json({ ok: true })
          case 'already':
            return unauthorized()
          case 'unreachable':
            throw new TypeError('offline')
          case 'malformed':
            return Response.json({ accepted: 0 })
          case 'legacy':
            return new Response('<html>not found</html>', { status: 404 })
          default:
            throw new TypeError('unexpected outcome')
        }
      },
    })
    // Then
    expect(requests).toEqual([
      {
        url: `${config.url}/api/meter/revoke`,
        authorization: 'Bearer mfd_test',
        body: {},
      },
    ])
    expect(JSON.parse(f.output.join(''))).toEqual({
      loggedIn: false,
      server:
        outcome === 'revoked' || outcome === 'already'
          ? outcome
          : 'unreachable',
    })
    for (const path of [directory, schedulePaths(f.context).plist])
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('logs out an invalid config without requesting the server', async () => {
  // Given
  const { home, runtime, output } = await cliFixture()
  await saveConfig(home, { ...config, deviceToken: '' })
  // When
  await runCli(['logout', '--json'], {
    ...runtime,
    fetch: async () => {
      throw new Error('network forbidden')
    },
  })
  // Then
  expect(JSON.parse(output.join(''))).toEqual({
    loggedIn: false,
    server: 'none',
  })
  await expect(
    stat(join(home, '.config/madefeed/cli.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([false, true])(
  'removes only an empty config directory when neighbour=%s',
  async (neighbour) => {
    // Given
    const { home, runtime } = await cliFixture()
    await saveConfig(home, config)
    const directory = join(home, '.config/madefeed')
    if (neighbour) await writeFile(join(directory, 'prod.env'), 'keep')
    // When
    await runCli(['logout'], runtime)
    // Then
    if (neighbour)
      expect(await readFile(join(directory, 'prod.env'), 'utf8')).toBe('keep')
    else await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(home, '.config'))).isDirectory()).toBe(true)
  },
)

it('reconnects login when cli.json is invalid', async () => {
  // Given
  const { home, runtime } = await cliFixture()
  await saveConfig(home, { ...config, deviceToken: '' })
  // When
  await runCli(['login', '--url', config.url, '--no-auto'], runtime)
  // Then
  expect((await readConfig(home))?.deviceToken).toBe('mfd_test')
})
