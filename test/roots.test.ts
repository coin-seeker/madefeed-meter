import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRoots, singleRoot } from '../src/sources/roots'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-roots-'))
  homes.push(home)
  await mkdir(join(home, 'default'))
  await mkdir(join(home, 'custom'))
  return home
}

it('splits commas, trims paths, expands home and deduplicates realpaths', async () => {
  // Given
  const home = await fixture()
  await symlink(join(home, 'custom'), join(home, 'alias'))
  await writeFile(join(home, 'file'), '')
  // When
  const roots = await listRoots(
    ' ~/custom , ~/alias, ~ , ~/missing, ~/file, ~/file/child, ',
    [],
    home,
  )
  // Then
  expect(roots).toEqual([join(home, 'custom'), home])
})
it.each([undefined, '', '  \t '])(
  'uses defaults for blank override %s',
  async (value) => {
    // Given
    const home = await fixture()
    // When
    const roots = await listRoots(value, ['~/default'], home)
    // Then
    expect(roots).toEqual([join(home, 'default')])
  },
)
it('does not fall back when a nonblank override has no existing directory', async () => {
  // Given
  const home = await fixture()
  // When
  const roots = await listRoots('~/missing, ,~/absent', ['~/default'], home)
  // Then
  expect(roots).toEqual([])
})
it.each([undefined, '', '  '])('uses the single default for %s', (value) => {
  // Given / When / Then
  expect(singleRoot(value, '/default')).toBe('/default')
})
it('trims a single root without splitting commas', () => {
  // Given / When / Then
  expect(singleRoot(' /one,two ', '/default')).toBe('/one,two')
})
