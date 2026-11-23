import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCallLog } from '../src/sources/hermes-log'
import { call, day, logs, timestamp } from './hermes-fixtures'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-hermes-log-'))
  homes.push(home)
  return home
}
it('L1 parses fresh input, cache reads and writes when a full call is logged', async () => {
  // Given
  const home = await fixture()
  await logs(home, [call(day(2), { write: 10 })])
  // When
  const result = await readCallLog(home)
  // Then
  expect(result.calls.get('private-session\0gpt-6\0openai')).toEqual([
    { ms: day(2), buckets: [190, 80, 1000, 10] },
  ])
})
it('L2 interprets timestamps as local wall clock when reading a log', async () => {
  // Given
  const home = await fixture()
  const ms = new Date(2026, 10, 3, 4, 5, 6, 789).getTime()
  await logs(home, [call(ms)])
  // When
  const result = await readCallLog(home)
  // Then
  expect(result.oldest).toBe(ms)
  expect([...result.calls.values()][0]?.[0]?.ms).toBe(ms)
})
it('L3 tracks oldest but ignores other loggers and unavailable usage', async () => {
  // Given
  const home = await fixture()
  await logs(home, [
    `${timestamp(day(1))} INFO [private-session] other: API call #1: ignored`,
    call(day(2)).replace(/in=\d+ out=\d+ total=\d+/, 'in=? out=? total=?') +
      ' usage=unavailable',
  ])
  // When
  const result = await readCallLog(home)
  // Then
  expect(result.oldest).toBe(day(1))
  expect(result.calls.size).toBe(0)
})
it('L4 reads numbered rotation but ignores lock files and duplicate calls', async () => {
  // Given
  const home = await fixture()
  await logs(home, [call(day(1))], 'agent.log.lock')
  await logs(home, [call(day(2))], 'agent.log.3')
  await logs(home, [call(day(2))])
  // When
  const result = await readCallLog(home)
  // Then
  expect(result.files).toBe(2)
  expect(result.oldest).toBe(day(2))
  expect([...result.calls.values()].flat()).toHaveLength(1)
})
it('L5 returns empty coverage when logs directory is missing', async () => {
  // Given
  const home = await fixture()
  // When
  const result = await readCallLog(home)
  // Then
  expect(result).toEqual({ files: 0, oldest: undefined, calls: new Map() })
})
