import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAmp } from '../src/sources/amp'
import { readDroid } from '../src/sources/droid'
import { readCodebuff } from '../src/sources/codebuff'
import { writeAmp } from './ccusage-fixtures/amp'
import { writeDroid } from './ccusage-fixtures/droid'
import { writeCodebuff } from './ccusage-fixtures/codebuff'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'meter-t7-errors-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const sources = [
  { name: 'Amp', env: 'AMP_DATA_DIR', read: readAmp, write: writeAmp },
  {
    name: 'Droid',
    env: 'DROID_SESSIONS_DIR',
    read: readDroid,
    write: writeDroid,
  },
  {
    name: 'Codebuff',
    env: 'CODEBUFF_DATA_DIR',
    read: readCodebuff,
    write: writeCodebuff,
  },
] as const

for (const source of sources) {
  it(`${source.name} returns a supported empty result when stores are absent`, async () => {
    // Given
    const options = { home, sinceMs: 0, env: {} }
    // When
    const result = await source.read(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  })
  it(`${source.name} restores defaults for an empty override`, async () => {
    // Given
    await source.write(home)
    // When
    const result = await source.read({
      home,
      sinceMs: 0,
      env: { [source.env]: '  ' },
    })
    // Then
    expect(result.rows).toHaveLength(1)
  })
  it(`${source.name} skips a malformed document`, async () => {
    // Given
    const path = await source.write(home)
    await writeFile(path, '{')
    // When
    const result = await source.read({ home, sinceMs: 0, env: {} })
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  })
  it(`${source.name} skips an unreadable file`, async () => {
    // Given
    const path = await source.write(home)
    await chmod(path, 0)
    // When
    const result = await source.read({ home, sinceMs: 0, env: {} })
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  })
  it(`${source.name} reports unexpected filesystem errors without paths`, async () => {
    // Given
    const path = join(home, 'loop')
    await symlink(path, path)
    // When
    const result = await source.read({
      home,
      sinceMs: 0,
      env: { [source.env]: path },
    })
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: `${source.name} 기록을 읽지 못해 이번에는 빼고 올려요.`,
    })
  })
}
