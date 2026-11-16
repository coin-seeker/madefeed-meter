import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { readConfig, saveConfig } from '../src/config'
import { agentPath } from '../src/agent'
import { schedulePaths } from '../src/schedule-builders'
import { config } from './schedule-fixtures'
import { cliFixture } from './cli-fixtures'
import { setupFailure } from '../src/copy'

it('installs an agent and launchd job after a successful login', async () => {
  // Given
  const { runtime, home, self, calls, diagnostic, output } = await cliFixture()
  // When
  await runCli(['login', '--url', config.url], runtime)
  // Then
  expect(await readFile(agentPath(home), 'utf8')).toBe(
    await readFile(self, 'utf8'),
  )
  expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true)
  expect((await readConfig(home))?.auto).toBe('on')
  expect(diagnostic.join('\n')).toContain('auto off')
  expect(output.join('\n') + diagnostic.join('\n')).not.toContain(
    config.deviceToken,
  )
})
it('enables automatic upload for a previously connected device on its next upload', async () => {
  // Given
  const { runtime, home, calls, requests } = await cliFixture()
  await saveConfig(home, config)
  // When
  await runCli(['upload'], runtime)
  // Then
  expect((await readConfig(home))?.auto).toBe('on')
  expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true)
  expect(requests).toEqual(['https://example.com/api/meter/usage'])
})
it.each(['--no-auto', '--dry-run', '--scheduled', 'env', 'off'])(
  'does not install or remember a new choice for %s',
  async (skip) => {
    // Given
    const { runtime, home, calls } = await cliFixture()
    await saveConfig(home, {
      ...config,
      ...(skip === 'off' ? { auto: 'off' as const } : {}),
    })
    // When
    await runCli(['upload', ...(skip.startsWith('--') ? [skip] : [])], {
      ...runtime,
      env: skip === 'env' ? { MADEFEED_NO_AUTO: '1' } : {},
    })
    // Then
    expect(calls).toEqual([])
    expect((await readConfig(home))?.auto).toBe(
      skip === 'off' ? 'off' : undefined,
    )
    await expect(stat(agentPath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  },
)
it.each(['--no-auto', 'env'])(
  'does not auto-install on login with %s',
  async (skip) => {
    // Given
    const { runtime, home, calls } = await cliFixture()
    // When
    await runCli(
      ['login', '--url', config.url, ...(skip === '--no-auto' ? [skip] : [])],
      {
        ...runtime,
        env: skip === 'env' ? { MADEFEED_NO_AUTO: '1' } : {},
      },
    )
    // Then
    expect((await readConfig(home))?.auto).toBeUndefined()
    expect(calls).toEqual([])
  },
)
it('refreshes the agent and repairs a missing job when the stored choice is on', async () => {
  // Given
  const { runtime, home, self, calls } = await cliFixture()
  await saveConfig(home, { ...config, auto: 'on' })
  await writeFile(self, 'new version')
  // When
  await runCli(['upload'], runtime)
  // Then
  expect(await readFile(agentPath(home), 'utf8')).toBe('new version')
  expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true)
})
it.each(['off', 'logout'])(
  'preserves neighbouring secret files when executing %s',
  async (action) => {
    // Given
    const { runtime, home, context, calls } = await cliFixture()
    await saveConfig(home, config)
    await runCli(['auto', 'on'], runtime)
    const directory = join(home, '.config/madefeed')
    for (const name of ['prod.env', 'google-oauth-web.json'])
      await writeFile(join(directory, name), `unchanged ${name}`)
    await writeFile(join(directory, 'auto.log'), 'earlier run\n')
    calls.length = 0
    // When
    await runCli(action === 'logout' ? ['logout'] : ['auto', 'off'], runtime)
    // Then
    for (const name of ['prod.env', 'google-oauth-web.json'])
      expect(await readFile(join(directory, name), 'utf8')).toBe(
        `unchanged ${name}`,
      )
    expect(calls.some((call) => call.args[0] === 'bootout')).toBe(true)
    await expect(stat(schedulePaths(context).plist)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(agentPath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(join(directory, 'auto.log'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readConfig(home)).toEqual(
      action === 'logout' ? undefined : { ...config, auto: 'off' },
    )
  },
)
it('enables again after an explicit off choice', async () => {
  // Given
  const { runtime, home, calls } = await cliFixture()
  await saveConfig(home, { ...config, auto: 'off' })
  // When
  await runCli(['auto', 'on'], runtime)
  // Then
  expect((await readConfig(home))?.auto).toBe('on')
  expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true)
})
it('keeps a successful upload successful when scheduler registration fails', async () => {
  // Given
  const { runtime, home, output, diagnostic } = await cliFixture()
  await saveConfig(home, config)
  // When
  await runCli(['upload'], {
    ...runtime,
    exec: async () => {
      throw new Error('scheduler unavailable')
    },
  })
  // Then
  expect(output.at(-1)).toContain('1건')
  expect(diagnostic.filter((line) => line === setupFailure)).toHaveLength(1)
  expect((await readConfig(home))?.auto).toBeUndefined()
})
it('does not hide an upload error when scheduling also fails', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await saveConfig(home, config)
  // When / Then
  await expect(
    runCli(['upload'], {
      ...runtime,
      exec: async () => {
        throw new Error('scheduler unavailable')
      },
      fetch: async () => Response.json({}, { status: 401 }),
    }),
  ).rejects.toThrow('HTTP 401')
})
it.each([['auto'], ['auto', 'status'], ['status']])(
  'reports JSON automatic state without refreshing for %j',
  async (...args) => {
    // Given
    const { runtime, home, calls, output } = await cliFixture()
    await saveConfig(home, { ...config, auto: 'on' })
    // When
    await runCli([...args, '--json'], {
      ...runtime,
      exec: async (file, parameters, options) => {
        await runtime.exec(file, parameters, options)
        throw new Error('not loaded')
      },
    })
    // Then
    const result = JSON.parse(output.join(''))
    expect(args[0] === 'status' ? result.auto : result).toEqual({
      enabled: false,
      kind: 'none',
    })
    expect(calls.every((call) => call.args[0] === 'print')).toBe(true)
    await expect(stat(agentPath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  },
)
