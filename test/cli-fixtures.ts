import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './schedule-fixtures'

export async function cliFixture() {
  const base = await fixture()
  const { home } = base
  const output: string[] = []
  const diagnostic: string[] = []
  const requests: string[] = []
  const bodies: unknown[] = []
  await mkdir(join(home, '.gemini/tmp'), { recursive: true })
  await writeFile(
    join(home, '.gemini/tmp/session.json'),
    JSON.stringify({
      messages: [
        {
          type: 'gemini',
          model: 'gemini-test',
          timestamp: '2026-11-16T00:00:00Z',
          tokens: { total: 12 },
        },
        {
          type: 'gemini',
          model: 'old',
          timestamp: '2026-11-12T00:00:00Z',
          tokens: { total: 99 },
        },
      ],
    }),
  )
  const runtime = {
    home,
    self: base.self,
    exec: base.exec,
    env: {},
    platform: 'darwin' as const,
    uid: 501,
    now: Date.parse('2026-11-16T09:00:00Z'),
    output: (text: string) => {
      output.push(text)
    },
    diagnostic: (text: string) => {
      diagnostic.push(text)
    },
    sleep: async () => {},
    machineId: async () => 'a'.repeat(64),
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/device'))
        return Response.json({
          device_code: 'test-code',
          user_code: 'ABCD',
          verification_uri: 'https://example.com/verify',
          expires_in: 600,
          interval: 1,
        })
      if (url.endsWith('/token')) return Response.json({ token: 'mfd_test' })
      if (url.endsWith('/revoke')) return Response.json({ ok: true })
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ accepted: 1, weekTokens: 12, votesGranted: 0 })
    },
  }
  return { ...base, runtime, output, diagnostic, requests, bodies }
}
