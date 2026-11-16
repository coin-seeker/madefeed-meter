import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { Exec, ScheduleContext } from '../src/schedule'

export type Call = {
  readonly file: string
  readonly args: readonly string[]
  readonly input: string | undefined
}
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
export async function fixture(platform: NodeJS.Platform = 'darwin') {
  const home = await mkdtemp(join(tmpdir(), 'madefeed 한 글 &%-'))
  homes.push(home)
  const self = join(home, 'bundle.mjs')
  await writeFile(self, 'export const version = 1')
  const calls: Call[] = []
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, input: options?.input })
    return { stdout: '' }
  }
  const context: ScheduleContext = {
    platform,
    home,
    uid: 501,
    node: '/node path/node',
    agent: join(home, '.config/madefeed/agent/cli.mjs'),
    exec,
    env: {},
  }
  return { home, self, calls, exec, context }
}
export const config = {
  url: 'https://example.com',
  deviceName: 'test-device',
  deviceToken: 'mfd_test',
} as const
