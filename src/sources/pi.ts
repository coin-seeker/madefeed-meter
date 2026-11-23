import { join } from 'node:path'
import { unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { flatSessions, mainSessions } from './pi-roots'
import { readPiSessions } from './pi-session'
import { customSessionDir, expandTilde } from './pi-settings'

export async function readPi(options: SourceOptions): Promise<SourceResult> {
  try {
    const configured = options.env?.['PI_CODING_AGENT_DIR']
    const agent = configured
      ? expandTilde(configured, options.home)
      : join(options.home, '.pi/agent')
    const custom = await customSessionDir({
      agent,
      home: options.home,
      env: options.env?.['PI_CODING_AGENT_SESSION_DIR'],
      commented: false,
    })
    const paths = await mainSessions(join(agent, 'sessions'))
    if (custom) paths.push(...(await flatSessions(custom)))
    return await readPiSessions(paths, 'pi', options)
  } catch (error) {
    return unsupported(error, 'Pi 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
