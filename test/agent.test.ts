import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentPath, installAgent, removeAgent, trimLog } from '../src/agent'
import { fixture } from './schedule-fixtures'

it('atomically refreshes the agent and skips copying itself', async () => {
  // Given
  const { home, self } = await fixture()
  await installAgent(self, home)
  await writeFile(self, 'export const version = 2')
  // When
  await installAgent(self, home)
  const before = await stat(agentPath(home))
  await installAgent(agentPath(home), home)
  // Then
  expect(await readFile(agentPath(home), 'utf8')).toBe(
    'export const version = 2',
  )
  expect((await stat(agentPath(home))).ino).toBe(before.ino)
  expect(before.mode & 0o777).toBe(0o600)
  expect((await stat(join(home, '.config/madefeed/agent'))).mode & 0o777).toBe(
    0o700,
  )
})
it('removes only the agent directory and leaves neighbours intact', async () => {
  // Given
  const { home, self } = await fixture()
  await installAgent(self, home)
  const neighbour = join(home, '.config/madefeed/prod.env')
  await writeFile(neighbour, 'unchanged')
  // When
  await removeAgent(home)
  // Then
  await expect(stat(agentPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(neighbour, 'utf8')).toBe('unchanged')
})
it('trims oversized logs to their last 200 lines without replacing the open inode', async () => {
  // Given
  const { home } = await fixture()
  await mkdir(join(home, '.config/madefeed'), { recursive: true })
  const log = join(home, '.config/madefeed/auto.log')
  const lines = Array.from(
    { length: 400 },
    (_, index) => `${index} ${'x'.repeat(1000)}`,
  )
  await writeFile(log, lines.join('\n') + '\n')
  const descriptor = await open(log, 'a')
  const before = await descriptor.stat()
  try {
    // When
    await trimLog(home)
    await descriptor.write('still open\n')
    // Then
    expect((await stat(log)).ino).toBe(before.ino)
    expect(await readFile(log, 'utf8')).toBe(
      lines.slice(-200).join('\n') + '\nstill open\n',
    )
  } finally {
    await descriptor.close()
  }
})
it('leaves small logs byte-identical', async () => {
  // Given
  const { home } = await fixture()
  await mkdir(join(home, '.config/madefeed'), { recursive: true })
  const log = join(home, '.config/madefeed/auto.log')
  await writeFile(log, 'unchanged\n')
  // When
  await trimLog(home)
  // Then
  expect(await readFile(log, 'utf8')).toBe('unchanged\n')
})
