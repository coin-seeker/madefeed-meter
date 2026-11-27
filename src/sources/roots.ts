import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function singleRoot(
  value: string | undefined,
  fallback: string,
): string {
  return value?.trim() || fallback
}

export async function listRoots(
  value: string | undefined,
  defaults: readonly string[],
  home: string,
): Promise<string[]> {
  const paths = value?.trim() ? value.split(',') : defaults
  const roots = new Map<string, string>()
  for (const raw of paths) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const path =
      trimmed === '~'
        ? home
        : trimmed.startsWith('~/')
          ? join(home, trimmed.slice(2))
          : trimmed
    try {
      if (!(await stat(path)).isDirectory()) continue
      const canonical = await realpath(path)
      if (!roots.has(canonical)) roots.set(canonical, path)
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        continue
      throw error
    }
  }
  return [...roots.values()]
}
