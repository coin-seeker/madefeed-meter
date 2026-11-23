import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { directory } from '../aggregate'

export async function childDirectories(root: string): Promise<string[]> {
  if (!(await directory(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()
}

export async function flatSessions(root: string): Promise<string[]> {
  if (!(await directory(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(root, entry.name))
    .sort()
}

export async function mainSessions(root: string): Promise<string[]> {
  const paths: string[] = []
  for (const project of await childDirectories(root))
    paths.push(...(await flatSessions(project)))
  return paths
}
