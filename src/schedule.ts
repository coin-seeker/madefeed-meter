import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { MeterError } from './aggregate'
import {
  buildCron,
  buildPlist,
  buildService,
  buildTimer,
  buildWrapper,
  label,
  marker,
  schedulePaths,
  timer,
  withoutMarker,
} from './schedule-builders'
import type { ScheduleContext } from './schedule-builders'
export type { Exec, ScheduleContext } from './schedule-builders'
export {
  buildCron,
  buildPlist,
  buildService,
  buildTimer,
  buildWrapper,
} from './schedule-builders'

export type ScheduleStatus = {
  readonly enabled: boolean
  readonly kind: 'launchd' | 'systemd' | 'cron' | 'schtasks' | 'none'
}
export async function fileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}
async function succeeds(
  context: ScheduleContext,
  file: string,
  args: readonly string[],
): Promise<boolean> {
  if (!context.exec) return false
  try {
    await context.exec(file, args)
    return true
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}
async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, text, { mode: 0o600 })
}
async function crontab(context: ScheduleContext): Promise<string> {
  if (!context.exec) return ''
  try {
    return (await context.exec('crontab', ['-l'])).stdout
  } catch (error) {
    if (error instanceof Error) return ''
    throw error
  }
}
export async function installSchedule(
  context: ScheduleContext,
): Promise<ScheduleStatus & { readonly supported: boolean }> {
  const paths = schedulePaths(context)
  if (!context.exec) return { enabled: false, kind: 'none', supported: false }
  switch (context.platform) {
    case 'darwin': {
      if (context.uid === undefined)
        throw new MeterError('사용자 스케줄러를 찾을 수 없어요.')
      const domain = `gui/${context.uid}`
      const service = `${domain}/${label}`
      const plist = buildPlist(context)
      const identical = (await fileText(paths.plist)) === plist
      if (
        identical &&
        (await succeeds(context, 'launchctl', ['print', service]))
      )
        return { enabled: true, kind: 'launchd', supported: true }
      await write(paths.plist, plist)
      await succeeds(context, 'launchctl', ['bootout', service])
      try {
        await context.exec('launchctl', ['bootstrap', domain, paths.plist])
      } catch (error) {
        if (!(error instanceof Error)) throw error
        await setTimeout(1000)
        await context.exec('launchctl', ['bootstrap', domain, paths.plist])
      }
      return { enabled: true, kind: 'launchd', supported: true }
    }
    case 'linux': {
      await write(paths.service, buildService(context))
      await write(paths.timer, buildTimer())
      const loaded = await succeeds(context, 'systemctl', [
        '--user',
        'daemon-reload',
      ])
      if (
        loaded &&
        (await succeeds(context, 'systemctl', [
          '--user',
          'enable',
          '--now',
          timer,
        ]))
      )
        return { enabled: true, kind: 'systemd', supported: true }
      await rm(paths.service, { force: true })
      await rm(paths.timer, { force: true })
      const previous = withoutMarker(await crontab(context))
      const line = buildCron(context)
      if (/[\r\n]/.test(line))
        throw new MeterError('스케줄 경로에 줄바꿈을 사용할 수 없어요.')
      await context.exec('crontab', ['-'], {
        input: `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${line}\n`,
      })
      return { enabled: true, kind: 'cron', supported: true }
    }
    case 'win32':
      await write(paths.wrapper, buildWrapper(context))
      await context.exec('schtasks', [
        '/Create',
        '/F',
        '/SC',
        'HOURLY',
        '/TN',
        'MadeFeed Meter',
        '/TR',
        `"${paths.wrapper}"`,
      ])
      return { enabled: true, kind: 'schtasks', supported: true }
    default:
      return { enabled: false, kind: 'none', supported: false }
  }
}
export async function removeSchedule(context: ScheduleContext): Promise<void> {
  if (!context.exec) return
  const paths = schedulePaths(context)
  switch (context.platform) {
    case 'darwin':
      await succeeds(context, 'launchctl', [
        'bootout',
        `gui/${context.uid}/${label}`,
      ])
      await rm(paths.plist, { force: true })
      return
    case 'linux': {
      await succeeds(context, 'systemctl', [
        '--user',
        'disable',
        '--now',
        timer,
      ])
      await rm(paths.service, { force: true })
      await rm(paths.timer, { force: true })
      await succeeds(context, 'systemctl', ['--user', 'daemon-reload'])
      const previous = await crontab(context)
      const remaining = withoutMarker(previous)
      if (remaining !== previous)
        await context.exec('crontab', ['-'], {
          input: remaining.trim() ? remaining : '',
        })
      return
    }
    case 'win32':
      await succeeds(context, 'schtasks', [
        '/Delete',
        '/F',
        '/TN',
        'MadeFeed Meter',
      ])
      await rm(paths.wrapper, { force: true })
      return
    default:
      return
  }
}
export async function scheduleStatus(
  context: ScheduleContext,
): Promise<ScheduleStatus> {
  const paths = schedulePaths(context)
  switch (context.platform) {
    case 'darwin':
      if (
        (await fileText(paths.plist)) !== undefined ||
        (await succeeds(context, 'launchctl', [
          'print',
          `gui/${context.uid}/${label}`,
        ]))
      )
        return { enabled: true, kind: 'launchd' }
      break
    case 'linux':
      if (
        (await fileText(paths.timer)) !== undefined &&
        (!context.exec ||
          (await succeeds(context, 'systemctl', [
            '--user',
            'is-enabled',
            timer,
          ])))
      )
        return { enabled: true, kind: 'systemd' }
      if (
        (await crontab(context))
          .split('\n')
          .some((line) => line.trimEnd().endsWith(marker))
      )
        return { enabled: true, kind: 'cron' }
      break
    case 'win32':
      if (
        context.exec
          ? await succeeds(context, 'schtasks', [
              '/Query',
              '/TN',
              'MadeFeed Meter',
            ])
          : (await fileText(paths.wrapper)) !== undefined
      )
        return { enabled: true, kind: 'schtasks' }
      break
    default:
      break
  }
  return { enabled: false, kind: 'none' }
}
