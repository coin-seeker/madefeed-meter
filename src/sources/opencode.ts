import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  count,
  directory,
  files,
  parseJson,
  record,
  timestamp,
  modelName,
  providerName,
  MeterError,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { databaseWorker } from './opencode-db'
import type { DatabaseInput, DatabaseResult } from './opencode-db'

const failure = 'OpenCode 기록을 제한 시간 안에 읽지 못해 이번에는 빼고 올려요.'

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
    const input = count(tokens['input'])
    const reasoning = count(tokens['reasoning'])
    const output = count(tokens['output']) + reasoning
    const cacheRead = count(cache['read'])
    const cacheWrite = count(cache['write'])
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
      provider: providerName(data['providerID']),
      tokens: sum,
      ...(input + output + cacheRead + cacheWrite > 0
        ? { input, output, cacheRead, cacheWrite, reasoning }
        : {}),
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
            ...[env['LOCALAPPDATA'], env['APPDATA']].flatMap((dir) =>
              dir ? [join(dir, 'opencode')] : [],
            ),
          ]
    const rows: UsageRow[] = []
    const seen = new Set<string>()
    const uniqueRoots = new Map(
      roots.filter(Boolean).map((root) => [resolve(root), root]),
    )
    for (const root of uniqueRoots.values()) {
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
          ...result.totals.map(
            ([
              date,
              model,
              provider,
              tokens,
              input,
              output,
              cacheRead,
              cacheWrite,
              reasoning,
              reported,
            ]) => ({
              date,
              tool: 'opencode' as const,
              model: modelName(model),
              provider: providerName(provider),
              tokens,
              ...(reported
                ? { input, output, cacheRead, cacheWrite, reasoning }
                : {}),
            }),
          ),
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
