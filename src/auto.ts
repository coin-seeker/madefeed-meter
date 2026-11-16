import {
  installAgent,
  removeAgent,
  removeLog,
  trimLog,
  agentPath,
} from './agent'
import { MeterError } from './aggregate'
import { logout, saveConfig } from './config'
import {
  autoEnabled,
  cleanupFailure,
  connectionRequired,
  invalidAuto,
  setupFailure,
} from './copy'
import type { Config } from './config'
import { installSchedule, removeSchedule, scheduleStatus } from './schedule'
import type { Exec, ScheduleContext, ScheduleStatus } from './schedule'

export type AutoRuntime = {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly self?: string
  readonly exec?: Exec
}
export type AutoOptions = {
  readonly runtime: AutoRuntime
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly diagnostic: (text: string) => void
}
export function automatic(options: AutoOptions) {
  const { runtime, home, env, diagnostic } = options
  const active = runtime.exec !== undefined && runtime.self !== undefined
  const context: ScheduleContext = {
    platform: runtime.platform ?? process.platform,
    home,
    uid: runtime.uid,
    node: process.execPath,
    agent: agentPath(home),
    env,
    ...(active ? { exec: runtime.exec } : {}),
  }
  async function safely(
    action: () => Promise<void>,
    message: string,
  ): Promise<void> {
    try {
      await action()
    } catch (error) {
      if (error instanceof Error) diagnostic(message)
      else throw error
    }
  }
  return {
    async status(): Promise<ScheduleStatus> {
      try {
        return await scheduleStatus(context)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        diagnostic(setupFailure)
        return { enabled: false, kind: 'none' }
      }
    },
    async install(config: Config): Promise<void> {
      const self = runtime.self
      if (!active || !self) return
      await safely(async () => {
        await installAgent(self, home)
        const result = await installSchedule(context)
        if (!result.supported) {
          diagnostic(setupFailure)
          return
        }
        await saveConfig(home, { ...config, auto: 'on' })
        if (config.auto !== 'on')
          for (const line of autoEnabled) diagnostic(line)
      }, setupFailure)
    },
    async remove(scope: 'auto' | 'device'): Promise<void> {
      const failure = cleanupFailure(scope)
      if (active) {
        await safely(() => removeAgent(home), failure)
        await safely(() => removeLog(home), failure)
      }
      try {
        if (scope === 'device') await logout(home)
      } finally {
        if (active) await safely(() => removeSchedule(context), failure)
      }
    },
    async trim(): Promise<void> {
      await safely(() => trimLog(home), setupFailure)
    },
  }
}
export async function autoCommand(
  action: string,
  config: Config | undefined,
  options: AutoOptions,
): Promise<ScheduleStatus> {
  const auto = automatic(options)
  switch (action) {
    case 'on':
      if (!config) throw new MeterError(connectionRequired)
      await auto.install(config)
      break
    case 'off':
      await auto.remove('auto')
      if (config) await saveConfig(options.home, { ...config, auto: 'off' })
      break
    case 'status':
      break
    default:
      throw new MeterError(invalidAuto)
  }
  return auto.status()
}
