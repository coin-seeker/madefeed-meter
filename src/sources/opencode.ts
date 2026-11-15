import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  count,
  files,
  parseJson,
  record,
  timestamp,
  modelName,
  MeterError,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'

// Runs outside the main event loop so even SQLite prepare/lock/iteration is killable.
function databaseWorker() {
  const { parentPort, workerData } = process.getBuiltinModule(
    'node:worker_threads',
  )
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite')
    if (!sqlite) throw new TypeError('sqlite unavailable')
    const db = new sqlite.DatabaseSync(workerData.path, { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')
      const sql =
        'SELECT time_created, data FROM message WHERE time_created >= ?'
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(workerData.sinceMs)
      // Never silently upload a partial rowid tail: it would overwrite complete totals.
      if (
        plan.some(
          (row) =>
            typeof row['detail'] !== 'string' ||
            !/SEARCH message .*INDEX .*\(time_created>\?\)/.test(row['detail']),
        )
      )
        throw new TypeError('no time index')
      const rows = []
      for (const row of db.prepare(sql).iterate(workerData.sinceMs)) {
        if (rows.length >= 200_000) throw new RangeError('row budget')
        rows.push(row)
      }
      parentPort?.postMessage({ rows })
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof Error) parentPort?.postMessage({ error: true })
    else throw error
  }
}

async function databaseRows(options: SourceOptions): Promise<unknown[]> {
  const worker = new Worker(`(${databaseWorker.toString()})()`, {
    eval: true,
    workerData: {
      path: join(options.home, '.local/share/opencode/opencode.db'),
      sinceMs: options.sinceMs,
    },
  })
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new MeterError('OpenCode DB 시간 예산을 초과해요.')),
        2500,
      )
      const fail = () => {
        clearTimeout(timer)
        reject(new MeterError('OpenCode DB를 안전하게 조회할 수 없어요.'))
      }
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', (value: unknown) => {
        clearTimeout(timer)
        const rows = record(value)['rows']
        if (Array.isArray(rows)) resolve(rows)
        else fail()
      })
    })
  } finally {
    await worker.terminate()
  }
}

function usage(value: unknown, ms: number): UsageRow | undefined {
  const data = record(value)
  if (data['role'] !== 'assistant') return undefined
  const tokens = record(data['tokens'])
  const cache = record(tokens['cache'])
  const total = tokens['total']
  const sum =
    typeof total === 'number'
      ? count(total)
      : count(tokens['input']) +
        count(tokens['output']) +
        count(tokens['reasoning']) +
        count(cache['read']) +
        count(cache['write'])
  return {
    date: kstDateOf(ms),
    tool: 'opencode',
    model: modelName(data['modelID']),
    tokens: sum,
  }
}

export async function readOpenCode(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const rows: UsageRow[] = []
    for (const value of await databaseRows(options)) {
      const row = record(value)
      const ms = timestamp(row['time_created'])
      if (typeof row['data'] !== 'string' || !Number.isFinite(ms)) continue
      const parsed = usage(parseJson(row['data']), ms)
      if (parsed) rows.push(parsed)
    }
    return { supported: true, rows }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  try {
    const rows: UsageRow[] = []
    for await (const path of files(
      join(options.home, '.local/share/opencode/storage/message'),
    )) {
      if (!path.endsWith('.json')) continue
      const data = parseJson(await readFile(path, 'utf8'))
      const ms = timestamp(record(record(data)['time'])['created'])
      if (!Number.isFinite(ms) || ms < options.sinceMs) continue
      const parsed = usage(data, ms)
      if (parsed) rows.push(parsed)
    }
    return { supported: true, reason: 'OpenCode legacy JSON을 사용해요.', rows }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return {
      supported: false,
      reason:
        'OpenCode는 시간 인덱스·조회 시간 예산 또는 legacy JSON을 사용할 수 없어 unsupported로 처리해요.',
      rows: [],
    }
  }
}
