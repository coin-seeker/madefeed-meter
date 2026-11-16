import { installAgent, removeAgent, trimLog, agentPath } from './agent'
import { MeterError } from './aggregate'
import { saveConfig } from './config'
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
const failure =
  '자동 전송을 설정할 수 없어요. madefeed upload로 수동 전송할 수 있어요.'
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
  async function safely(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      if (error instanceof Error) diagnostic(failure)
      else throw error
    }
  }
  return {
    async status(): Promise<ScheduleStatus> {
      try {
        return await scheduleStatus(context)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        diagnostic(failure)
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
          diagnostic(failure)
          return
        }
        await saveConfig(home, { ...config, auto: 'on' })
        if (config.auto !== 'on')
          diagnostic(
            '이제 한 시간마다 사용량을 자동 전송해요. 끄려면 madefeed auto off를 실행해 주세요.',
          )
      })
    },
    async remove(): Promise<void> {
      if (!active) return
      // Independent cleanup: a scheduler failure must not leave the agent behind.
      await safely(() => removeSchedule(context))
      await safely(() => removeAgent(home))
    },
    async trim(): Promise<void> {
      await safely(() => trimLog(home))
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
      if (!config)
        throw new MeterError('먼저 madefeed login으로 기기를 연결해 주세요.')
      await auto.install(config)
      break
    case 'off':
      await auto.remove()
      if (config) await saveConfig(options.home, { ...config, auto: 'off' })
      break
    case 'status':
      break
    default:
      throw new MeterError('auto on, off, status 중 하나를 사용해 주세요.')
  }
  return auto.status()
}
