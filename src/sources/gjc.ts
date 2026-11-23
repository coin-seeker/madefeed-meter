import { join } from 'node:path'
import { unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { childDirectories, flatSessions, mainSessions } from './pi-roots'
import { readPiSessions } from './pi-session'

export async function readGjc(options: SourceOptions): Promise<SourceResult> {
  try {
    const root = join(options.home, '.gjc/agent/sessions')
    const paths: string[] = []
    const mains = await mainSessions(root)
    paths.push(...mains)
    for (const main of mains) {
      const artifacts = main.slice(0, -'.jsonl'.length)
      paths.push(...(await flatSessions(artifacts)))
      for (const child of await childDirectories(artifacts))
        paths.push(...(await flatSessions(child)))
    }
    return await readPiSessions(paths, 'gjc', options)
  } catch (error) {
    return unsupported(error, 'Gajae Code 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
