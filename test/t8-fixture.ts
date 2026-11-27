import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const ms = Date.parse('2026-11-16T15:00:00Z')
export async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-t8-'))
  async function put(relative: string, value: unknown) {
    const path = join(home, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    )
    return path
  }
  async function lines(relative: string, values: readonly unknown[]) {
    return put(
      relative,
      values
        .map((value) =>
          typeof value === 'string' ? value : JSON.stringify(value),
        )
        .join('\n'),
    )
  }
  return {
    home,
    put,
    lines,
    remove: () => rm(home, { recursive: true, force: true }),
  }
}
