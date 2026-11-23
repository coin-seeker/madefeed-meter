import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sinceMs = Date.parse('2026-11-01T00:00:00+09:00')
export const day = (n: number) =>
  Date.parse(`2026-11-${String(n).padStart(2, '0')}T09:00:00+09:00`)
export type Counts = readonly [number, number, number, number, number]
export type Session = {
  readonly id?: string
  readonly model?: string | null
  readonly provider?: string | null
  readonly start?: number
  readonly counts?: Counts
}
export type Usage = Session & {
  readonly task?: string
  readonly first?: number | null
  readonly last?: number | null
}
export async function database(
  root: string,
  data: {
    readonly sessions?: readonly Session[]
    readonly usage?: readonly Usage[]
    readonly legacy?: boolean
    readonly missingSessions?: boolean
  } = {},
) {
  await mkdir(root, { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(root, 'state.db'))
  try {
    if (!data.missingSessions) {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT,
        started_at REAL, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        billing_provider TEXT)`)
      for (const s of data.sessions ?? [])
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
          s.id ?? 'private-session',
          'cli',
          s.model === undefined ? 'gpt-6' : s.model,
          (s.start ?? day(2)) / 1000,
          ...(s.counts ?? [100, 50, 1000, 10, 20]),
          s.provider === undefined ? 'openai' : s.provider,
        )
    }
    if (!data.legacy) {
      db.exec(`CREATE TABLE session_model_usage (
        session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
        billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '',
        task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
        actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
        PRIMARY KEY(session_id,model,billing_provider,billing_base_url,billing_mode,task))`)
      for (const u of data.usage ?? [])
        db.prepare(`INSERT INTO session_model_usage
          (session_id,model,billing_provider,task,input_tokens,output_tokens,cache_read_tokens,
          cache_write_tokens,reasoning_tokens,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          u.id ?? 'private-session',
          u.model ?? 'gpt-6',
          u.provider ?? 'openai',
          u.task ?? '',
          ...(u.counts ?? [100, 50, 1000, 10, 20]),
          u.first === null ? null : (u.first ?? day(2)) / 1000,
          u.last === null ? null : (u.last ?? day(2)) / 1000,
        )
    }
  } finally {
    db.close()
  }
}

export function timestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, length = 2) => String(n).padStart(length, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
}
export function call(
  ms: number,
  options: {
    readonly id?: string
    readonly model?: string
    readonly provider?: string
    readonly number?: number
    readonly input?: number
    readonly output?: number
    readonly cache?: number
    readonly write?: number
  } = {},
): string {
  const input = options.input ?? 1200
  const output = options.output ?? 80
  return `${timestamp(ms)} INFO [${options.id ?? 'private-session'}] agent.conversation_loop: API call #${options.number ?? 1}: model=${options.model ?? 'gpt-6'} provider=${options.provider ?? 'openai'} in=${input} out=${output} total=${input + output} latency=6.4s cache=${options.cache ?? 1000}/${input} (100%) write=${options.write ?? 0}`
}
export async function logs(
  root: string,
  lines: readonly string[],
  name = 'agent.log',
) {
  await mkdir(join(root, 'logs'), { recursive: true })
  await writeFile(join(root, 'logs', name), lines.join('\n') + '\n')
}
