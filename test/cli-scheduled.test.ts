import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { saveConfig } from '../src/config'
import { agentPath } from '../src/agent'
import { config } from './schedule-fixtures'
import { cliFixture } from './cli-fixtures'
import { setupFailure } from '../src/copy'

it('skips scheduled uploads without a usable token and never requests login', async () => {
  // Given
  const { runtime, calls, requests, output } = await cliFixture()
  // When
  await runCli(['upload', '--scheduled', '--days', '3'], runtime)
  // Then
  expect(requests).toEqual([])
  expect(calls).toEqual([])
  expect(output).toHaveLength(1)
  expect(output[0]).toContain('건너뛰었어요')
})
it('skips a scheduled run with an invalid stored token', async () => {
  // Given
  const { runtime, home, requests, output } = await cliFixture()
  await saveConfig(home, config)
  await writeFile(
    join(home, '.config/madefeed/cli.json'),
    JSON.stringify({ ...config, deviceToken: '' }),
  )
  // When
  await runCli(['upload', '--scheduled'], runtime)
  // Then
  expect(requests).toEqual([])
  expect(output).toHaveLength(1)
  expect(output[0]).toContain('건너뛰었어요')
})
it('prints diagnostics and one timestamped result while uploading only the three-day window', async () => {
  // Given
  const { runtime, home, requests, bodies, output, diagnostic, calls } =
    await cliFixture()
  await saveConfig(home, { ...config, auto: 'on', backfill: 'done' })
  const database = join(home, '.local/share/opencode')
  await mkdir(database, { recursive: true })
  await writeFile(join(database, 'opencode.db'), 'not a database')
  // When
  await runCli(['upload', '--scheduled', '--days', '3'], runtime)
  // Then
  expect(requests).toEqual(['https://example.com/api/meter/usage'])
  expect(bodies).toEqual([
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
  expect(output).toHaveLength(1)
  expect(output[0]).toMatch(/^2026-11-16T09:00:00\.000Z .*1건/)
  expect(diagnostic.some((line) => line.includes('OpenCode'))).toBe(true)
  expect(output.join('') + diagnostic.join('')).not.toContain(
    config.deviceToken,
  )
  expect(calls).toEqual([])
  await expect(stat(agentPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('trims the scheduled log before returning for a missing token', async () => {
  // Given
  const { runtime, home } = await cliFixture()
  await mkdir(join(home, '.config/madefeed'), { recursive: true })
  const log = join(home, '.config/madefeed/auto.log')
  const lines = Array.from(
    { length: 300 },
    (_, index) => `${index}:${'x'.repeat(1000)}`,
  )
  await writeFile(log, lines.join('\n') + '\n')
  const inode = (await stat(log)).ino
  // When
  await runCli(['--scheduled'], runtime)
  // Then
  expect(await readFile(log, 'utf8')).toBe(lines.slice(-200).join('\n') + '\n')
  expect((await stat(log)).ino).toBe(inode)
})
it('keeps manual uploads usable when copying the bundle fails', async () => {
  // Given
  const { runtime, home, output, diagnostic, calls } = await cliFixture()
  await saveConfig(home, config)
  // When
  await runCli(['upload'], { ...runtime, self: join(home, 'missing.mjs') })
  // Then
  expect(output.at(-1)).toContain('1건')
  expect(diagnostic.filter((line) => line === setupFailure)).toHaveLength(1)
  expect(calls).toEqual([])
})
