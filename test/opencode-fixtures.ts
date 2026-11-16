import { afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sinceMs = Date.parse('2026-11-14T15:00:00Z')
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
export async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-opencode-'))
  homes.push(home)
  const root = join(home, '.local/share/opencode')
  await mkdir(root, { recursive: true })
  return { home, root, sinceMs, env: {} }
}
export function database(root: string, name = 'opencode.db') {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(root, name))
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER);
    CREATE INDEX session_time_created_id_idx ON session(time_created,id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    INSERT INTO session VALUES ('s',0,0);`)
  return db
}
export async function legacy(root: string, id: string, tokens = 50) {
  const dir = join(root, 'storage/message/s')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      modelID: 'model',
      time: { created: sinceMs },
      tokens: { total: tokens },
    }),
  )
}
