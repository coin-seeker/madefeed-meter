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
