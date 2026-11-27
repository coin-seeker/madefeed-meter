// Ported from ccusage 30e8907 rust/adapters/codebuff tests (MIT)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const codebuffMessage = {
  id: 'assistant-message',
  role: 'assistant',
  timestamp: '2026-11-16T16:00:00Z',
  metadata: {
    model: 'claude-sonnet-4-20250514',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 10,
    },
  },
  credits: 1.25,
} as const
export async function writeCodebuff(
  home: string,
  value: unknown = [codebuffMessage],
  relative = '.config/manicode/projects/project/chats/chat/chat-messages.json',
) {
  const path = join(home, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
  return path
}
