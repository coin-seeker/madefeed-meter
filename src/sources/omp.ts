import { join } from 'node:path'
import { directory, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { childDirectories, flatSessions, mainSessions } from './pi-roots'
import { readPiSessions } from './pi-session'

export async function readOmp(options: SourceOptions): Promise<SourceResult> {
  try {
    const base = join(options.home, '.omp')
    const roots = [join(base, 'agent/sessions')]
    for (const profile of await childDirectories(join(base, 'profiles')))
      roots.push(join(profile, 'agent/sessions'))
    const xdg = options.env?.['XDG_DATA_HOME']
    if (xdg && (await directory(join(xdg, 'omp')))) {
      const app = join(xdg, 'omp')
      roots.push(join(app, 'sessions'))
      for (const profile of await childDirectories(join(app, 'profiles')))
        roots.push(join(profile, 'sessions'))
    }
    const paths: string[] = []
    for (const root of roots) {
      const mains = await mainSessions(root)
      paths.push(...mains)
      for (const main of mains) {
        const artifacts = main.slice(0, -'.jsonl'.length)
        paths.push(...(await flatSessions(artifacts)))
        for (const child of await childDirectories(artifacts))
          paths.push(...(await flatSessions(child)))
      }
    }
    return await readPiSessions(paths, 'omp', options)
  } catch (error) {
    return unsupported(error, 'oh-my-pi 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
