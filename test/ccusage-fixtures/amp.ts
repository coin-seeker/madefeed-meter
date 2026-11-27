// Ported from ccusage 30e8907 rust/adapters/amp tests (MIT)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ampMessage = {
  role: 'assistant',
  messageId: 10,
  timestamp: '2026-11-16T16:00:00Z',
  model: 'gpt-5',
  usage: {
    inputTokens: 10,
    outputTokens: 178,
    cacheCreationInputTokens: 986,
    cacheReadInputTokens: 11372,
  },
} as const
export const ampThread = { id: 'T-example', messages: [ampMessage] } as const
export async function writeAmp(
  home: string,
  value: unknown = ampThread,
  relative = '.local/share/amp/threads/nested/thread.json',
) {
  const path = join(home, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
  return path
}
