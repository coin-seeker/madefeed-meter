import { readClaude } from './claude'
import { readCodex } from './codex'
import { readOpenCode } from './opencode'
import { readGemini } from './gemini'

export const sourceReaders = [
  readClaude,
  readCodex,
  readOpenCode,
  readGemini,
] as const
