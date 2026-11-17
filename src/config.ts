import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MeterError, parseJson, record } from './aggregate'
import { invalidConfig, invalidUrl, unsafeUrl } from './copy'

export type Config = {
  readonly url: string
  readonly deviceToken: string
  readonly deviceName: string
  readonly auto?: 'on' | 'off'
  readonly backfill?: 'done'
}
export function serviceUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    if (error instanceof TypeError) throw new MeterError(invalidUrl)
    throw error
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new MeterError(unsafeUrl)
  return url.origin
}
export async function readConfig(home: string): Promise<Config | undefined> {
  try {
    const data = record(
      parseJson(
        await readFile(join(home, '.config/madefeed/cli.json'), 'utf8'),
      ),
    )
    if (
      typeof data['url'] !== 'string' ||
      typeof data['deviceToken'] !== 'string' ||
      !/^mfd_[A-Za-z0-9_-]+$/.test(data['deviceToken']) ||
      typeof data['deviceName'] !== 'string'
    )
      throw new MeterError(invalidConfig)
    return {
      url: serviceUrl(data['url']),
      deviceToken: data['deviceToken'],
      deviceName: data['deviceName'],
      ...(data['backfill'] === 'done' ? { backfill: 'done' as const } : {}),
      ...(data['auto'] === 'on' || data['auto'] === 'off'
        ? { auto: data['auto'] }
        : {}),
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}
export async function saveConfig(home: string, config: Config): Promise<void> {
  const directory = join(home, '.config/madefeed')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `cli-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(config), {
      mode: 0o600,
      flag: 'wx',
    })
    await chmod(temporary, 0o600)
    await rename(temporary, join(directory, 'cli.json'))
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function logout(home: string): Promise<void> {
  await rm(join(home, '.config/madefeed/cli.json'), { force: true })
  try {
    await rmdir(join(home, '.config/madefeed'))
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOTEMPTY' ||
        error.code === 'EEXIST' ||
        error.code === 'ENOENT')
    )
      return
    throw error
  }
}
