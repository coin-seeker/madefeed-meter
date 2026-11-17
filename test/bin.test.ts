import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'

// npm installs the bin as a symlink (node_modules/.bin/madefeed -> dist/cli.mjs).
// The bundle must still run when it is started through that link.

const run = promisify(execFile)
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'madefeed-bin-'))
  await build({
    entryPoints: [fileURLToPath(new URL('../src/bin.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(dir, 'pkg', 'cli.mjs'),
    logLevel: 'silent',
  })
  await symlink(join(dir, 'pkg', 'cli.mjs'), join(dir, 'madefeed'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('prints the version when started through the bin symlink', async () => {
  // Given / When
  const { stdout } = await run(
    process.execPath,
    [join(dir, 'madefeed'), '--version'],
    { env: {} },
  )
  // Then
  expect(stdout.trim()).toBe(manifest.version)
})

it('prints the version when started by its real path', async () => {
  // Given / When
  const { stdout } = await run(
    process.execPath,
    [join(dir, 'pkg', 'cli.mjs'), '--version'],
    { env: {} },
  )
  // Then
  expect(stdout.trim()).toBe(manifest.version)
})
