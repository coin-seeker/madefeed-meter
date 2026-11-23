import { readFile, stat } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  buildCron,
  buildService,
  installSchedule,
  removeSchedule,
  scheduleStatus,
} from '../src/schedule'
import { jobEnvironment, schedulePaths } from '../src/schedule-builders'
import { fixture } from './schedule-fixtures'

it('passes the Antigravity and Hermes overrides to the job', async () => {
  // Given
  const { context } = await fixture('linux')
  const env = {
    ANTIGRAVITY_DATA_DIR: '/agy a,/agy b',
    HERMES_HOME: '/hermes',
    UNRELATED: 'x',
  }
  // When
  const keys = jobEnvironment({ ...context, env }).map(([key]) => key)
  // Then
  expect(keys).toEqual(['ANTIGRAVITY_DATA_DIR', 'HERMES_HOME'])
})

it('installs systemd service and hourly persistent timer with quoted Unicode paths', async () => {
  // Given
  const { context, calls } = await fixture('linux')
  // When
  await installSchedule(context)
  // Then
  const paths = schedulePaths(context)
  const service = await readFile(paths.service, 'utf8')
  expect(service).toContain('Type=oneshot')
  expect(service).toContain('ExecStart="/node path/node"')
  expect(service).toContain('한 글 &%%')
  expect(service).toContain('"upload" "--days" "3" "--scheduled"')
  expect(service).not.toContain('Environment=')
  expect(await readFile(paths.timer, 'utf8')).toContain(
    'OnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target',
  )
  expect(calls.map((call) => [call.file, call.args])).toEqual([
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'madefeed-meter.timer']],
  ])
  expect(await scheduleStatus(context)).toEqual({
    enabled: true,
    kind: 'systemd',
  })
})
it.each(['daemon-reload', 'enable'])(
  'falls back to cron when systemd %s fails and preserves unrelated lines',
  async (failure) => {
    // Given
    const { context, calls, exec } = await fixture('linux')
    let cron =
      'MAILTO=someone\n15 * * * * backup\n1 * * * * old # madefeed-meter\n'
    const fallback = {
      ...context,
      exec: async (
        file: string,
        args: readonly string[],
        options?: { readonly input?: string },
      ) => {
        await exec(file, args, options)
        if (file === 'systemctl' && args.includes(failure))
          throw new Error('systemd unavailable')
        if (file === 'crontab' && args[0] === '-l') return { stdout: cron }
        if (file === 'crontab' && args[0] === '-') cron = options?.input ?? ''
        return { stdout: '' }
      },
    }
    // When
    const result = await installSchedule(fallback)
    // Then
    expect(result.kind).toBe('cron')
    expect(cron).toContain('MAILTO=someone\n15 * * * * backup\n')
    expect(cron).not.toContain(' old ')
    expect(cron).toContain('한 글 &\\%')
    expect(cron.match(/# madefeed-meter/g)).toHaveLength(1)
    expect(calls.at(-1)).toMatchObject({
      file: 'crontab',
      args: ['-'],
      input: cron,
    })
    await expect(stat(schedulePaths(context).service)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(schedulePaths(context).timer)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await scheduleStatus(fallback)).toEqual({
      enabled: true,
      kind: 'cron',
    })
    // Removal is independently observable through the crontab adapter.
    await removeSchedule(fallback)
    expect(cron).toBe('MAILTO=someone\n15 * * * * backup\n')
    expect(
      calls.some(
        (call) =>
          call.args.join(' ') === '--user disable --now madefeed-meter.timer',
      ),
    ).toBe(true)
  },
)
it('creates a crontab even when crontab -l rejects', async () => {
  // Given
  const { context, calls, exec } = await fixture('linux')
  // When
  await installSchedule({
    ...context,
    exec: async (file, args, options) => {
      await exec(file, args, options)
      if (file === 'systemctl' || args[0] === '-l')
        throw new Error('no crontab')
      return { stdout: '' }
    },
  })
  // Then
  expect(calls.at(-1)).toMatchObject({
    file: 'crontab',
    args: ['-'],
    input: `${buildCron(context)}\n`,
  })
})
it('writes an empty crontab when removing its only marker line', async () => {
  // Given
  const { context, calls, exec } = await fixture('linux')
  // When
  await removeSchedule({
    ...context,
    exec: async (file, args, options) => {
      await exec(file, args, options)
      return {
        stdout: file === 'crontab' ? '0 * * * * job # madefeed-meter\n' : '',
      }
    },
  })
  // Then
  expect(calls.at(-1)).toMatchObject({
    file: 'crontab',
    args: ['-'],
    input: '',
  })
})
it('quotes environment values for systemd and cron without ambient variables', async () => {
  // Given
  const { context } = await fixture('linux')
  const env = {
    OPENCODE_DATA_DIR: '/db %/한 글',
    XDG_DATA_HOME: '',
    GEMINI_DATA_DIR: "a'b",
    MADEFEED_URL: 'https://example.com',
  }
  // When
  const unit = buildService({ ...context, env })
  const cron = buildCron({ ...context, env })
  // Then
  expect(unit).toContain('Environment="OPENCODE_DATA_DIR=/db %%/한 글"')
  expect(unit).toContain('Environment="XDG_DATA_HOME="')
  expect(unit).toContain('Environment="GEMINI_DATA_DIR=a\'b"')
  expect(cron).toContain(
    "OPENCODE_DATA_DIR='/db \\%/한 글' XDG_DATA_HOME='' GEMINI_DATA_DIR='a'\\''b' MADEFEED_URL='https://example.com'",
  )
  expect(buildCron(context)).not.toMatch(
    /OPENCODE_DATA_DIR|XDG_DATA_HOME|GEMINI_DATA_DIR|MADEFEED_URL/,
  )
  expect(buildCron(context).split(' ')[0]).toBe(
    buildCron({ ...context, agent: '/different agent.mjs' }).split(' ')[0],
  )
  expect(Number(cron.split(' ')[0])).toBeLessThan(60)
})
it('passes the source directory overrides to the job after the original four keys', async () => {
  // Given
  const { context } = await fixture('linux')
  const env = {
    OMO_CODING_AGENT_SESSION_DIR: '/omo sessions',
    CODEX_HOME: '/codex a,/codex b',
    MADEFEED_URL: 'https://example.com',
    CLAUDE_CONFIG_DIR: '/claude',
    PI_CODING_AGENT_DIR: '/pi',
    PI_CODING_AGENT_SESSION_DIR: '/pi sessions',
    OMO_CODING_AGENT_DIR: '/omo',
    GROK_HOME: '/grok',
    UNRELATED: 'excluded',
  }
  // When
  const keys = jobEnvironment({ ...context, env }).map(([key]) => key)
  // Then
  expect(keys).toEqual([
    'MADEFEED_URL',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'OMO_CODING_AGENT_DIR',
    'OMO_CODING_AGENT_SESSION_DIR',
    'GROK_HOME',
  ])
})
