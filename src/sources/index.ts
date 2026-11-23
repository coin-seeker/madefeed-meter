import type { SourceOptions } from '../aggregate'
import { readClaude } from './claude'
import { readCodex } from './codex'
import { readOpenCode } from './opencode'
import { readGemini } from './gemini'
import { readPi } from './pi'
import { readOmp } from './omp'
import { readOmo } from './omo'
import { readAgy } from './agy'

export const sourceReaders = [
  readClaude,
  readCodex,
  readOpenCode,
  readGemini,
  readPi,
  readOmp,
  readOmo,
  readAgy,
] as const

export async function readSources(options: SourceOptions) {
  const results = await Promise.all(sourceReaders.map((read) => read(options)))
  // A history sum is complete only when Codex, compressed logs included, was read.
  const codex = results[sourceReaders.indexOf(readCodex)]?.supported === true
  return { results, codex }
}
