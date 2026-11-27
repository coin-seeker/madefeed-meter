import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readOpenClaw } from '../src/sources/openclaw'
import { clawMessage, jsonl, ms } from './t10-fixtures'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'madefeed-claw-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const state = {
  type: 'model_change',
  modelId: 'gpt-5.2',
  provider: 'openai-codex',
}
const path = () => join(home, '.openclaw/agents/a/sessions/s.jsonl')
const read = (sinceMs = 0) => readOpenClaw({ home, sinceMs, env: {} })
const expected = {
  date: '2026-11-16',
  tool: 'openclaw',
  model: 'gpt-5.2',
  provider: 'openai-codex',
  input: 1660,
  output: 55,
  cacheRead: 108928,
  tokens: 110643,
}

it('inherits model state and reads deleted/reset logs while deduplicating content', async () => {
  // Given
  await jsonl(path(), [state, clawMessage(), '{broken'])
  await jsonl(path() + '.deleted.1', [state, clawMessage()])
  await jsonl(path().replace('s.jsonl', 'other.jsonl.reset.1'), [
    state,
    clawMessage(),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([expected, expected])
})
it('prefers SQLite migration copies even when cost and provider differ', async () => {
  // Given
  await jsonl(path(), [state, clawMessage()])
  const dbPath = join(home, '.openclaw/agents/a/agent/openclaw-agent.sqlite')
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(
      'CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)',
    )
    const insert = db.prepare(
      'INSERT INTO transcript_events VALUES (?, ?, ?, ?)',
    )
    insert.run('s', 1, JSON.stringify({ ...state, provider: 'openai' }), ms)
    const event = clawMessage({
      input: 1660,
      output: 55,
      cacheRead: 108928,
      cost: { total: 2 },
    })
    insert.run('s', 2, JSON.stringify(event), ms)
    insert.run('s', 3, JSON.stringify(event), ms)
  } finally {
    db.close()
  }
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([{ ...expected, provider: 'openai' }])
})
it('tracks partial custom snapshots and keeps total-only remainder without invented parts', async () => {
  // Given
  await jsonl(path(), [
    state,
    { type: 'custom', customType: 'model-snapshot', data: { model: 'glm-5' } },
    clawMessage({ totalTokens: 9 }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-16',
      tool: 'openclaw',
      model: 'glm-5',
      provider: 'openai-codex',
      tokens: 9,
    },
  ])
})
it('follows JSONL symlink directories without looping and deduplicates root aliases', async () => {
  // Given
  await jsonl(join(home, 'outside/s.jsonl'), [state, clawMessage()])
  await mkdir(join(home, '.openclaw'), { recursive: true })
  await symlink(join(home, 'outside'), join(home, '.openclaw/linked'))
  await symlink(join(home, '.openclaw'), join(home, 'outside/loop'))
  // When
  const result = await readOpenClaw({
    home,
    sinceMs: 0,
    env: { OPENCLAW_DIR: `${home}/.openclaw,${home}/outside` },
  })
  // Then
  expect(result.rows).toEqual([expected])
})
it('filters invalid timestamps, zero usage, non-assistants and pre-window records', async () => {
  // Given
  await jsonl(path(), [
    state,
    clawMessage({ input: 0 }),
    {
      type: 'message',
      message: { role: 'user', usage: { input: 8 }, timestamp: ms },
    },
    {
      type: 'message',
      message: { role: 'assistant', usage: { input: 9 }, timestamp: 'bad' },
    },
    clawMessage(),
  ])
  // When
  const result = await read(ms + 1)
  // Then
  expect(result.rows).toEqual([])
})
it('rejects day-model totals above the cap', async () => {
  // Given
  await jsonl(path(), [clawMessage({ input: 100_000_000_001 })])
  // When
  const result = await read()
  // Then
  expect(result).toMatchObject({ supported: false, rows: [] })
})
it('returns an empty supported source when stores are absent', async () => {
  // Given / When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
