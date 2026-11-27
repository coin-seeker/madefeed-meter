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
import { readGrok } from './grok'
import { readAmp } from './amp'
import { readDroid } from './droid'
import { readCodebuff } from './codebuff'
import { readCline } from './cline'
import { readKimi } from './kimi'
import { readQwen } from './qwen'
import { readGoose } from './goose'
import { readKilo } from './kilo'
import { readZcode } from './zcode'
import { readOpenClaw } from './openclaw'
import { readCopilot } from './copilot'
import { readDsh } from './dsh'

const newSourceReaders = [
  readAmp,
  readDroid,
  readCodebuff,
  readCline,
  readKimi,
  readQwen,
  readGoose,
  readKilo,
  readZcode,
  readOpenClaw,
  readCopilot,
  readDsh,
] as const

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
  readGrok,
  ...newSourceReaders,
] as const

export async function readSources(options: SourceOptions) {
  const results = await Promise.all(sourceReaders.map((read) => read(options)))
  const codex = results[sourceReaders.indexOf(readCodex)]?.supported === true
  const agy = results[sourceReaders.indexOf(readAgy)]?.supported === true
  const hermes = results[sourceReaders.indexOf(readHermes)]?.supported === true
  const newSourcesOk = newSourceReaders.every(
    (read) => results[sourceReaders.indexOf(read)]?.supported === true,
  )
  return { results, codex, agy, hermes, newSourcesOk }
}
