import { basename, isAbsolute, join } from 'node:path'
import { unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { childDirectories, flatSessions, mainSessions } from './pi-roots'
import { readPiSessions, sessionHeader } from './pi-session'
import { customSessionDir } from './pi-settings'

export async function readOmo(options: SourceOptions): Promise<SourceResult> {
  try {
    const agent =
      options.env?.['OMO_CODING_AGENT_DIR']?.trim() ||
      join(options.home, '.omo/agent')
    const paths = [
      ...(await mainSessions(join(agent, 'sessions'))),
      ...(await mainSessions(
        join(options.home, '.omo/desktop/userdata/omo-sessions'),
      )),
    ]
    const custom = await customSessionDir({
      agent,
      home: options.home,
      env: options.env?.['OMO_CODING_AGENT_SESSION_DIR'],
      commented: true,
    })
    if (custom) paths.push(...(await flatSessions(custom)))
    const cwds = new Set<string>()
    for (const path of paths) {
      const cwd = (await sessionHeader(path))['cwd']
      if (typeof cwd === 'string' && isAbsolute(cwd)) cwds.add(cwd)
    }
    for (const cwd of cwds) {
      for (const task of await childDirectories(
        join(cwd, '.omo/senpi-task/children'),
      )) {
        if (!basename(task).startsWith('st_')) continue
        for (const session of await childDirectories(join(task, 'sessions')))
          if (basename(session).startsWith('st_'))
            paths.push(...(await flatSessions(session)))
      }
    }
    return await readPiSessions(paths, 'omo', options)
  } catch (error) {
    return unsupported(error, 'OmO 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
