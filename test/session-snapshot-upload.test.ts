import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadUsage } from '../src/api'
import { MeterError, parseJson, record } from '../src/aggregate'
import { uploadChunks } from '../src/chunks'
import { readDroid } from '../src/sources/droid'
import { readGoose } from '../src/sources/goose'
import { droidSettings, writeDroid } from './ccusage-fixtures/droid'
import { database, gooseSchema } from './t9-sqlite-fixtures'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'session-upload-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

for (const tool of ['droid', 'goose'] as const) {
  it(`${tool} uploads one complete cumulative snapshot after a model switch`, async () => {
    // Given
    const path = join(home, '.local/share/goose/sessions/sessions.db')
    if (tool === 'droid') await writeDroid(home)
    else {
      const db = database(path, gooseSchema)
      db.exec(
        `INSERT INTO sessions VALUES ('s', '{"model_name":"claude-sonnet-4"}', 'anthropic', '2026-11-16T16:00:00Z', 185, 100, 85, NULL, NULL, NULL)`,
      )
      db.close()
    }
    const reader = tool === 'droid' ? readDroid : readGoose
    const bodies: Record<string, unknown>[] = []
    const api = {
      url: 'https://example.com',
      fetch: async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        bodies.push(record(parseJson(String(init?.body))))
        return Response.json({ accepted: 1, weekTokens: 0, votesGranted: 0 })
      },
    }
    const initial = await reader({ home, sinceMs: 0, env: {} })
    await uploadUsage(api, 'mfd_test', {
      deviceName: 'fixture',
      rows: initial.rows,
    })
    // When
    if (tool === 'droid')
      await writeDroid(home, {
        ...droidSettings,
        model: 'gpt-5',
        providerLock: 'openai',
        tokenUsage: { totalTokens: 200 },
      })
    else {
      const db = database(path, '')
      db.exec(
        `UPDATE sessions SET model_config_json = '{"model_name":"gpt-5"}', provider_name = 'openai', total_tokens = 200`,
      )
      db.close()
    }
    const updated = await reader({ home, sinceMs: 0, env: {} })
    await uploadUsage(api, 'mfd_test', {
      deviceName: 'fixture',
      rows: updated.rows,
    })
    // Then
    expect(bodies).toEqual([
      expect.objectContaining({
        completeTools: [tool],
        rows: [
          expect.objectContaining({
            tool,
            model: 'claude-sonnet-4',
            tokens: 185,
          }),
        ],
      }),
      expect.objectContaining({
        completeTools: [tool],
        rows: [
          expect.objectContaining({
            date: '2026-11-17',
            tool,
            model: 'gpt-5',
            tokens: 200,
          }),
        ],
      }),
    ])
  })

  it(`${tool} refuses to split a complete date-tool group across chunks`, () => {
    // Given
    const rows = Array.from({ length: 101 }, (_, index) => ({
      date: '2026-11-17',
      tool,
      model: `model-${index}`,
      provider: 'unknown',
      tokens: 1,
    }))
    // When / Then
    expect(() => uploadChunks(rows)).toThrow(MeterError)
  })
}
