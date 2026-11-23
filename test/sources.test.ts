import { afterEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaude } from '../src/sources/claude'
import { readCodex } from '../src/sources/codex'
import { readOpenCode } from '../src/sources/opencode'
import { aggregate, payload, MAX_ROW_TOKENS } from '../src/aggregate'
import { kstDateOf } from '../src/kst'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  )
})
async function homeFor(source: string) {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-test-'))
  homes.push(home)
  const directory = join(
    home,
    source === 'claude'
      ? '.claude/projects/fixture'
      : '.codex/sessions/2026/11/15',
  )
  await mkdir(directory, { recursive: true })
  await cp(
    new URL(`./fixtures/${source}.jsonl`, import.meta.url),
    join(directory, 'rollout-fixture.jsonl'),
  )
  return home
}
describe('usage readers', () => {
  it('aggregates rows above two billion and rejects sums above the new cap', () => {
    // Given
    const row = {
      date: '2026-11-15',
      tool: 'opencode' as const,
      model: 'model',
      tokens: 3_124_282_929,
    }
    // When / Then
    expect(aggregate([row])[0]?.tokens).toBe(3_124_282_929)
    expect(aggregate([{ ...row, tokens: MAX_ROW_TOKENS }])[0]?.tokens).toBe(
      MAX_ROW_TOKENS,
    )
    expect(() =>
      aggregate([
        { ...row, tokens: MAX_ROW_TOKENS },
        { ...row, tokens: 1 },
      ]),
    ).toThrow('100,000,000,000')
  })
  it.each([
    ['Claude Code', readClaude],
    ['Codex', readCodex],
  ])(
    'treats a machine that never used %s as empty without a warning',
    async (_name, read) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), 'madefeed-test-'))
      homes.push(home)
      // When
      const result = await read({ home, sinceMs: 0, env: {} })
      // Then
      expect(result).toEqual({ supported: true, rows: [] })
    },
  )
  it('counts Claude duplicate message.id + requestId once and strips private fields', async () => {
    // Given
    const home = await homeFor('claude')
    // When
    const result = await readClaude({
      home,
      sinceMs: Date.parse('2026-11-15'),
      env: {},
    })
    const body = payload('test-device', aggregate(result.rows))
    // Then
    expect(body.rows).toEqual([
      {
        date: '2026-11-16',
        tool: 'claude-code',
        model: 'claude-test',
        tokens: 100,
      },
    ])
    expect(Object.keys(body).sort()).toEqual(['deviceName', 'rows'])
    expect(Object.keys(body.rows[0] ?? {}).sort()).toEqual([
      'date',
      'model',
      'tokens',
      'tool',
    ])
    expect(JSON.stringify(body)).not.toMatch(
      /SECRET-PROMPT|secret-repo|\/Users/,
    )
  })
  it('deduplicates Claude snapshots across default and comma-configured roots', async () => {
    // Given
    const home = await homeFor('claude')
    const custom = join(home, 'custom')
    const second = join(home, 'second')
    for (const [root, id, tokens] of [
      [join(home, '.config/claude'), 'duplicate', 17],
      [custom, 'duplicate', 23],
      [second, 'distinct', 31],
    ] as const) {
      await mkdir(join(root, 'projects'), { recursive: true })
      await writeFile(
        join(root, 'projects/session.jsonl'),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-15T15:30:00Z',
          requestId: 'request',
          message: {
            id,
            model: 'claude-test',
            usage: { input_tokens: tokens },
          },
        }),
      )
    }
    // When
    const result = await readClaude({
      home,
      sinceMs: Date.parse('2026-11-15'),
      env: { CLAUDE_CONFIG_DIR: `,${custom},${custom}/.,,${second},` },
    })
    // Then
    expect(result.supported).toBe(true)
    expect(aggregate(result.rows)[0]?.tokens).toBe(154)
  })
  it('adds zero for repeated Codex cumulative events and handles reset and pre-window baseline', async () => {
    // Given
    const home = await homeFor('codex')
    // When
    const result = await readCodex({
      home,
      sinceMs: Date.parse('2026-11-15'),
      env: {},
    })
    // Then
    expect(aggregate(result.rows)).toEqual([
      { date: '2026-11-16', tool: 'codex', model: 'gpt-test', tokens: 70 },
    ])
  })
  it('buckets UTC 15:30 on the next KST date at the midnight boundary', () => {
    // Given / When / Then
    expect([
      kstDateOf('2026-11-15T14:59:59.999Z'),
      kstDateOf('2026-11-15T15:00:00Z'),
      kstDateOf('2026-11-15T15:30:00Z'),
    ]).toEqual(['2026-11-15', '2026-11-16', '2026-11-16'])
  })
  it('uses the larger OpenCode parts sum on an older schema without ids', async () => {
    // Given
    const home = await homeFor('claude')
    const directory = join(home, '.local/share/opencode')
    await mkdir(directory, { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(join(directory, 'opencode.db'))
    db.exec(
      'CREATE TABLE message (time_created INTEGER, data TEXT); CREATE INDEX message_time ON message(time_created)',
    )
    const insert = db.prepare('INSERT INTO message VALUES (?, ?)')
    for (const tokens of [
      { total: 123, input: 999 },
      { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    ]) {
      insert.run(
        Date.parse('2026-11-15T15:30:00Z'),
        JSON.stringify({
          role: 'assistant',
          modelID: 'gpt-test',
          tokens,
          content: 'SECRET-PROMPT',
        }),
      )
    }
    db.close()
    // When
    const result = await readOpenCode({
      home,
      env: {},
      sinceMs: Date.parse('2026-11-15'),
    })
    // Then
    expect(result.supported).toBe(true)
    expect(aggregate(result.rows)[0]?.tokens).toBe(1014)
  })
  it('reads an older schema without a time index alongside distinct legacy JSON', async () => {
    // Given
    const home = await homeFor('claude')
    const directory = join(home, '.local/share/opencode')
    await mkdir(join(directory, 'storage/message/session'), { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(join(directory, 'opencode.db'))
    db.exec('CREATE TABLE message (time_created INTEGER, data TEXT)')
    db.close()
    await writeFile(
      join(directory, 'storage/message/session/m.json'),
      JSON.stringify({
        role: 'assistant',
        modelID: 'bad model',
        time: { created: Date.parse('2026-11-15T15:30:00Z') },
        tokens: { total: 15 },
      }),
    )
    // When
    const result = await readOpenCode({
      home,
      env: {},
      sinceMs: Date.parse('2026-11-15'),
    })
    // Then
    expect(aggregate(result.rows)).toEqual([
      { date: '2026-11-16', tool: 'opencode', model: 'unknown', tokens: 15 },
    ])
  })
})
