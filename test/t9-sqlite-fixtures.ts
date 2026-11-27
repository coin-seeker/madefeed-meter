import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
})
export function homeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'madefeed-t9-'))
  homes.push(home)
  return home
}
export function database(path: string, sql: string) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(sql)
  return db
}
export const gooseSchema = `CREATE TABLE sessions (
  id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT,
  total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER)`
export const kiloSchema =
  'CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)'
export const zcodeSchema = `CREATE TABLE session (id TEXT, directory TEXT, version TEXT);
  CREATE TABLE model_usage (id TEXT, session_id TEXT, started_at INTEGER, model_id TEXT,
  provider_id TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
  cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`
export const kiloMessage = {
  id: 'msg-1',
  role: 'assistant',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
  time: { created: 1767312000000 },
  tokens: {
    input: 100,
    output: 50,
    reasoning: 5,
    cache: { read: 10, write: 20 },
  },
}
