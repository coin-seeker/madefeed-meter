import { afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const sinceMs = Date.parse('2026-11-14T15:00:00Z')
export const iso = '2026-11-15T15:00:00Z'
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
export async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-pi-'))
  homes.push(home)
  return { home, sinceMs, env: {} }
}
export function message(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    role: 'assistant',
    model: 'model',
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    ...fields,
  }
}
export function event(fields: Readonly<Record<string, unknown>> = {}) {
  return { type: 'message', timestamp: iso, message: message(), ...fields }
}
export async function textFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
export async function session(path: string, lines: readonly unknown[]) {
  await textFile(path, lines.map((line) => JSON.stringify(line)).join('\n'))
  await utimes(path, new Date(iso), new Date(iso))
}
