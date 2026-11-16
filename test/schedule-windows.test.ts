import { readFile, stat } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  buildWrapper,
  installSchedule,
  removeSchedule,
  scheduleStatus,
} from '../src/schedule'
import { schedulePaths } from '../src/schedule-builders'
import { fixture } from './schedule-fixtures'

it('builds a UTF-8 Windows wrapper with quoted arguments and explicit environment only', async () => {
  // Given
  const { context } = await fixture('win32')
  const windows = {
    ...context,
    home: 'C:\\Users\\한 글',
    node: 'C:\\Program Files\\node.exe',
    agent: 'C:\\Users\\한 글\\.config\\madefeed\\agent\\cli.mjs',
  }
  // When
  const wrapper = buildWrapper({
    ...windows,
    env: {
      OPENCODE_DATA_DIR: 'D:\\db 100%',
      XDG_DATA_HOME: '',
      GEMINI_DATA_DIR: 'D:\\한 글',
      MADEFEED_URL: 'https://example.com',
    },
  })
  // Then
  expect(wrapper).toContain(
    '@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul',
  )
  expect(wrapper).toContain('set "OPENCODE_DATA_DIR=D:\\db 100%%"')
  expect(wrapper).toContain('set "XDG_DATA_HOME="')
  expect(wrapper).toContain('set "GEMINI_DATA_DIR=D:\\한 글"')
  expect(wrapper).toContain('set "MADEFEED_URL=https://example.com"')
  expect(wrapper).toContain(
    '"C:\\Program Files\\node.exe" "C:\\Users\\한 글\\.config\\madefeed\\agent\\cli.mjs" "upload" "--days" "3" "--scheduled" >> "C:\\Users\\한 글\\.config\\madefeed\\auto.log" 2>&1',
  )
  expect(buildWrapper(windows)).not.toContain('set "')
})
it('creates and removes the named Windows task with argument arrays', async () => {
  // Given: use POSIX fixture paths to exercise filesystem operations on this host.
  const { context, calls } = await fixture('win32')
  const paths = schedulePaths(context)
  // When
  const result = await installSchedule(context)
  // Then
  expect(result.kind).toBe('schtasks')
  expect(await readFile(paths.wrapper, 'utf8')).toBe(buildWrapper(context))
  expect(calls[0]).toMatchObject({
    file: 'schtasks',
    args: [
      '/Create',
      '/F',
      '/SC',
      'HOURLY',
      '/TN',
      'MadeFeed Meter',
      '/TR',
      `"${paths.wrapper}"`,
    ],
  })
  expect(await scheduleStatus(context)).toEqual({
    enabled: true,
    kind: 'schtasks',
  })
  await removeSchedule(context)
  expect(calls.at(-1)).toMatchObject({
    file: 'schtasks',
    args: ['/Delete', '/F', '/TN', 'MadeFeed Meter'],
  })
  await expect(stat(paths.wrapper)).rejects.toMatchObject({ code: 'ENOENT' })
})
