// Ported from ccusage 30e8907 rust/adapters/droid tests (MIT)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const droidSettings = {
  model: 'Claude-Sonnet-4-[Anthropic]',
  providerLock: 'anthropic',
  providerLockTimestamp: '2026-11-16T16:00:00Z',
  tokenUsage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 20,
    cacheReadTokens: 10,
    thinkingTokens: 5,
  },
} as const
export async function writeDroid(
  home: string,
  value: unknown = droidSettings,
  relative = '.factory/sessions/nested/session.settings.json',
) {
  const path = join(home, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
  return path
}
