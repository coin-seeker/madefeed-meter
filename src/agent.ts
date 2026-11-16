import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function agentPath(home: string): string {
  return join(home, '.config/madefeed/agent/cli.mjs')
}
export async function installAgent(
  self: string,
  home: string,
): Promise<string> {
  const target = agentPath(home)
  const source = await realpath(self)
  if (source === resolve(target)) return target
  try {
    if (source === (await realpath(target))) return target
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
  const directory = join(home, '.config/madefeed/agent')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `${randomUUID()}.tmp`)
  try {
    const input = await open(source, 'r')
    try {
      const output = await open(temporary, 'wx', 0o600)
      try {
        await output.writeFile(await input.readFile())
      } finally {
        await output.close()
      }
    } finally {
      await input.close()
    }
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return target
}
export async function removeAgent(home: string): Promise<void> {
  await rm(join(home, '.config/madefeed/agent'), {
    recursive: true,
    force: true,
  })
}
export async function removeLog(home: string): Promise<void> {
  await rm(join(home, '.config/madefeed/auto.log'), { force: true })
}
export async function trimLog(home: string): Promise<void> {
  let file
  try {
    file = await open(join(home, '.config/madefeed/auto.log'), 'r+')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  try {
    if ((await file.stat()).size <= 256 * 1024) return
    const text = await file.readFile('utf8')
    const lines =
      text.replace(/\n$/, '').split('\n').slice(-200).join('\n') + '\n'
    await file.truncate(0)
    await file.write(lines, 0, 'utf8')
  } finally {
    await file.close()
  }
}
