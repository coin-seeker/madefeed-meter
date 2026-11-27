import { readFile, stat } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  buildPlist,
  installSchedule,
  removeSchedule,
  scheduleStatus,
} from '../src/schedule'
import {
  buildCron,
  buildService,
  buildWrapper,
  schedulePaths,
} from '../src/schedule-builders'
import { fixture } from './schedule-fixtures'

it('forwards all new source overrides to every schedule format', async () => {
  // Given
  const { context } = await fixture()
  const keys = [
    'AMP_DATA_DIR',
    'DROID_SESSIONS_DIR',
    'CODEBUFF_DATA_DIR',
    'CLINE_DATA_DIR',
    'XDG_CONFIG_HOME',
    'GOOSE_PATH_ROOT',
    'OPENCLAW_DIR',
    'KILO_DATA_DIR',
    'KIMI_DATA_DIR',
    'QWEN_DATA_DIR',
    'COPILOT_HOME',
    'ZCODE_HOME',
    'DSH_HOME',
  ]
  const configured = {
    ...context,
    env: Object.fromEntries(keys.map((key) => [key, `/custom/${key}`])),
  }
  // When
  const formats = [
    buildPlist(configured),
    buildService(configured),
    buildCron(configured),
    buildWrapper(configured),
  ]
  // Then
  for (const output of formats)
    for (const key of keys) expect(output).toContain(`/custom/${key}`)
})

it('removes the darwin plist before bootout', async () => {
  // Given
  const { context, exec } = await fixture()
  await installSchedule(context)
  let removed = false
  // When
  await removeSchedule({
    ...context,
    exec: async (file, args, options) => {
      if (args[0] === 'bootout') {
        try {
          await stat(schedulePaths(context).plist)
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            removed = true
          else throw error
        }
      }
      return exec(file, args, options)
    },
  })
  // Then
  expect(removed).toBe(true)
})

it('installs an escaped launchd plist and bootstraps the precise argument array', async () => {
  // Given
  const { context, calls } = await fixture()
  const paths = schedulePaths(context)
  // When
  const result = await installSchedule(context)
  // Then
  const plist = await readFile(paths.plist, 'utf8')
  expect(plist).toBe(buildPlist(context))
  expect(plist).toContain('한 글 &amp;%')
  expect(plist).toContain('<string>/node path/node</string>')
  expect(plist).toContain(
    '<string>upload</string><string>--days</string><string>3</string><string>--scheduled</string>',
  )
  expect(plist).toContain('<key>StartInterval</key><integer>3600</integer>')
  expect(plist).toContain('<key>RunAtLoad</key><false/>')
  expect(plist).toContain(
    `<key>StandardOutPath</key><string>${paths.log.replaceAll('&', '&amp;')}</string>`,
  )
  expect(plist).not.toMatch(/ProcessType|LowPriorityIO|EnvironmentVariables/)
  expect(calls).toEqual([
    {
      file: 'launchctl',
      args: ['bootout', 'gui/501/dev.madefeed.meter'],
      input: undefined,
    },
    {
      file: 'launchctl',
      args: ['bootstrap', 'gui/501', paths.plist],
      input: undefined,
    },
  ])
  expect(result).toEqual({ enabled: true, kind: 'launchd', supported: true })
})
it('does not unload or rewrite an identical loaded launch agent', async () => {
  // Given
  const { context, calls } = await fixture()
  await installSchedule(context)
  const before = await stat(schedulePaths(context).plist)
  calls.length = 0
  // When
  await installSchedule(context)
  // Then
  expect(calls.map((call) => call.args)).toEqual([
    ['print', 'gui/501/dev.madefeed.meter'],
  ])
  expect((await stat(schedulePaths(context).plist)).mtimeMs).toBe(
    before.mtimeMs,
  )
})
it('retries bootstrap once after a bootout race', async () => {
  // Given
  const { context, calls, exec } = await fixture()
  let bootstraps = 0
  // When
  await installSchedule({
    ...context,
    exec: async (file, args, options) => {
      await exec(file, args, options)
      if (args[0] === 'bootstrap' && ++bootstraps === 1)
        throw new Error('bootout race')
      return { stdout: '' }
    },
  })
  // Then
  expect(calls.filter((call) => call.args[0] === 'bootstrap')).toHaveLength(2)
})
it('repairs changed or unloaded launch agents', async () => {
  // Given
  const { context, calls, exec } = await fixture()
  await installSchedule(context)
  calls.length = 0
  // When
  await installSchedule({
    ...context,
    exec: async (file, args, options) => {
      await exec(file, args, options)
      if (args[0] === 'print') throw new Error('not loaded')
      return { stdout: '' }
    },
  })
  // Then
  expect(calls.map((call) => call.args[0])).toEqual([
    'print',
    'bootout',
    'bootstrap',
  ])
})
it('removes launchd files even when bootout rejects', async () => {
  // Given
  const { context, exec } = await fixture()
  await installSchedule(context)
  // When
  await removeSchedule({
    ...context,
    exec: async (file, args, options) => {
      await exec(file, args, options)
      throw new Error('not loaded')
    },
  })
  // Then
  await expect(stat(schedulePaths(context).plist)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
it('carries only explicitly configured environment variables into launchd', async () => {
  // Given
  const { context } = await fixture()
  // When
  const plist = buildPlist({
    ...context,
    env: {
      OPENCODE_DATA_DIR: '<db>&"\'',
      XDG_DATA_HOME: '',
      GEMINI_DATA_DIR: '한 글',
      MADEFEED_URL: 'https://example.com',
      SECRET: 'excluded',
    },
  })
  // Then
  expect(plist).toContain(
    '<key>OPENCODE_DATA_DIR</key><string>&lt;db&gt;&amp;&quot;&apos;</string>',
  )
  expect(plist).toContain('<key>XDG_DATA_HOME</key><string></string>')
  expect(plist).toContain('<key>GEMINI_DATA_DIR</key><string>한 글</string>')
  expect(plist).toContain(
    '<key>MADEFEED_URL</key><string>https://example.com</string>',
  )
  expect(plist).not.toContain('excluded')
})
it('reports file-only state without an executor and never mutates it', async () => {
  // Given
  const { context, calls } = await fixture()
  await installSchedule(context)
  calls.length = 0
  const { exec: _exec, ...inert } = context
  // When
  const state = await scheduleStatus(inert)
  await removeSchedule(inert)
  // Then
  expect(state).toEqual({ enabled: true, kind: 'launchd' })
  expect(calls).toEqual([])
  expect(await readFile(schedulePaths(context).plist, 'utf8')).toBe(
    buildPlist(context),
  )
})
it('does not install anything on unsupported platforms', async () => {
  // Given
  const { context, calls } = await fixture('freebsd')
  // When
  const state = await installSchedule(context)
  // Then
  expect(state).toEqual({ enabled: false, kind: 'none', supported: false })
  expect(calls).toEqual([])
})
