import type { SourceOptions } from '../aggregate'
import { readClaude } from './claude'
import { readCodex } from './codex'
import { readOpenCode } from './opencode'
import { readGemini } from './gemini'
import { readPi } from './pi'
import { readOmp } from './omp'
import { readOmo } from './omo'
import { readAgy } from './agy'
import { readHermes } from './hermes'

export const sourceReaders = [
  readClaude,
  readCodex,
  readOpenCode,
  readGemini,
  readPi,
  readOmp,
  readOmo,
  readAgy,
  readHermes,
] as const

export async function readSources(options: SourceOptions) {
  const results = await Promise.all(sourceReaders.map((read) => read(options)))
  const codex = results[sourceReaders.indexOf(readCodex)]?.supported === true
  const agy = results[sourceReaders.indexOf(readAgy)]?.supported === true
  const hermes = results[sourceReaders.indexOf(readHermes)]?.supported === true
  return { results, codex, agy, hermes }
}
