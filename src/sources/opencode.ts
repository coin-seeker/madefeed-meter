import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  count,
  files,
  parseJson,
  record,
  timestamp,
  modelName,
  MeterError,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { databaseWorker } from './opencode-db'
import type { DatabaseInput, DatabaseResult } from './opencode-db'

const failure =
  'OpenCode DB를 제한 시간 안에 읽을 수 없어 부분 집계 없이 unsupported로 처리해요.'

async function databaseRows(input: DatabaseInput): Promise<DatabaseResult> {
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage((${databaseWorker.toString()})(workerData))`,
    {
      eval: true,
      workerData: input,
    },
  )
  try {
    return await new Promise<DatabaseResult>((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer)
        reject(new MeterError(failure))
      }
      const timer = setTimeout(fail, 45_000)
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', (value: DatabaseResult) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  } finally {
    await worker.terminate()
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

async function legacyRows(root: string, options: SourceOptions) {
  const rows = new Map<string, UsageRow>()
  const storage = join(root, 'storage/message')
  if (!(await directory(storage))) return rows
  for await (const path of files(storage)) {
    if (!path.endsWith('.json') || (await stat(path)).mtimeMs < options.sinceMs)
      continue
    const data = record(parseJson(await readFile(path, 'utf8')))
    const ms = timestamp(record(data['time'])['created'])
    if (
      !Number.isFinite(ms) ||
      ms < options.sinceMs ||
      typeof data['modelID'] !== 'string'
    )
      continue
    const raw = data['tokens']
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const tokens = record(raw)
    const cache = record(tokens['cache'])
    const sum = Math.max(
      count(tokens['total']),
      count(tokens['input']) +
        count(tokens['output']) +
        count(tokens['reasoning']) +
        count(cache['read']) +
        count(cache['write']),
    )
    if (sum === 0) continue
    const id =
      typeof data['id'] === 'string' ? data['id'] : basename(path, '.json')
    rows.set(id, {
      date: kstDateOf(ms),
      tool: 'opencode',
      model: modelName(data['modelID']),
      tokens: sum,
    })
  }
  return rows
}

export async function readOpenCode(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const env = options.env ?? {}
    const custom = env['OPENCODE_DATA_DIR']
    const xdg = env['XDG_DATA_HOME']
    const roots =
      custom !== undefined
        ? custom.split(',')
        : [
            xdg && isAbsolute(xdg)
              ? join(xdg, 'opencode')
              : join(options.home, '.local/share/opencode'),
          ]
    const rows: UsageRow[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      if (!root || !(await directory(root))) continue
      const legacy = await legacyRows(root, options)
      const entries = await readdir(root, { withFileTypes: true })
      const names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
      const db = names.includes('opencode.db')
        ? 'opencode.db'
        : names.filter((name) => /^opencode-.*\.db$/.test(name)).sort()[0]
      if (db) {
        const result = await databaseRows({
          path: join(root, db),
          sinceMs: options.sinceMs,
          legacyIds: [...legacy.keys()],
          excludedIds: [...seen],
        })
        if ('error' in result)
          return { supported: false, reason: failure, rows: [] }
        rows.push(
          ...result.totals.map(([date, model, tokens]) => ({
            date,
            tool: 'opencode' as const,
            model: modelName(model),
            tokens,
          })),
        )
        for (const id of result.knownIds) seen.add(id)
      }
      for (const [id, row] of legacy) {
        if (seen.has(id)) continue
        rows.push(row)
        seen.add(id)
      }
    }
    return { supported: true, rows }
  } catch (error) {
    return unsupported(error, failure)
  }
}
