import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { environmentKeys } from '../src/schedule-builders'
import { allToolsFixture, expectedTokens } from './t16-fixtures'

it('prints all 12 new tools through the bundled CLI with an isolated fixture HOME', async () => {
  // Given
  const f = await allToolsFixture()
  try {
    const bundle = process.env['T16_QA_BUNDLE'] ?? join(f.home, 'dist/cli.mjs')
    if (!process.env['T16_QA_BUNDLE'])
      await build({
        entryPoints: [fileURLToPath(new URL('../src/bin.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile: bundle,
        logLevel: 'silent',
      })
    const unset = [
      ...environmentKeys,
      'LOCALAPPDATA',
      'APPDATA',
      'USERPROFILE',
      'NODE_OPTIONS',
    ].flatMap((key) => ['-u', key])
    // When
    const { stdout } = await promisify(execFile)(
      '/usr/bin/env',
      [
        ...unset,
        `HOME=${f.home}`,
        process.execPath,
        bundle,
        '--dry-run',
        '--json',
        '--days',
        '35',
      ],
      { timeout: 30_000 },
    )
    // Then
    const body: unknown = JSON.parse(stdout)
    expect(body).toMatchObject({
      cliVersion: '0.10.0',
      rows: expect.any(Array),
    })
    if (
      typeof body !== 'object' ||
      body === null ||
      !('rows' in body) ||
      !Array.isArray(body.rows)
    )
      throw new TypeError('dry-run rows missing')
    expect(body.rows).toHaveLength(12)
    for (const [tool, tokens] of Object.entries(expectedTokens))
      expect(body.rows).toContainEqual(
        expect.objectContaining({ tool, tokens }),
      )
    const evidence = process.env['T16_EVIDENCE_PATH']
    if (evidence) await writeFile(evidence, stdout)
  } finally {
    await f.remove()
  }
})
