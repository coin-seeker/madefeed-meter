import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  aggregate,
  directory,
  MeterError,
  modelName,
  providerName,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { hermesWorker } from './hermes-db'
import type { HermesDatabaseResult } from './hermes-db'
import { readCallLog } from './hermes-log'
import type { LogInfo } from './hermes-log'
import { splitHermes } from './hermes-split'

const failure = 'Hermes 기록을 읽지 못해 이번에는 빼고 올려요.'
const emptyLog: LogInfo = { files: 0, oldest: undefined, calls: new Map() }

async function databaseRows(
  input: Parameters<typeof hermesWorker>[0],
): Promise<HermesDatabaseResult> {
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage((${hermesWorker.toString()})(workerData))`,
    { eval: true, workerData: input },
  )
  try {
    return await new Promise<HermesDatabaseResult>((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer)
        reject(new MeterError(failure))
      }
      const timer = setTimeout(fail, 45_000)
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', (result: HermesDatabaseResult) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  } finally {
    await worker.terminate()
  }
}

async function fileStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}
async function databasePaths(options: SourceOptions): Promise<string[]> {
  const env = options.env ?? process.env
  const homes =
    env['HERMES_HOME'] !== undefined
      ? env['HERMES_HOME'].split(',').filter(Boolean)
      : [
          join(options.home, '.hermes'),
          ...(env['LOCALAPPDATA'] ? [join(env['LOCALAPPDATA'], 'hermes')] : []),
        ]
  const paths = new Map<string, string>()
  for (const home of homes) {
    const candidates = [join(home, 'state.db')]
    const profiles = join(home, 'profiles')
    if (await directory(profiles))
      for (const entry of await readdir(profiles, { withFileTypes: true })) {
        if (entry.isDirectory())
          candidates.push(join(profiles, entry.name, 'state.db'))
      }
    for (const path of candidates) {
      const info = await fileStat(path)
      if (!info?.isFile()) continue
      const canonical = await realpath(path)
      if (paths.has(canonical)) continue
      paths.set(canonical, path)
    }
  }
  const recent: string[] = []
  for (const path of [...paths.values()].sort()) {
    const info = await fileStat(path)
    if (
      (info?.mtimeMs ?? -Infinity) >= options.sinceMs ||
      ((await fileStat(`${path}-wal`))?.mtimeMs ?? -Infinity) >= options.sinceMs
    )
      recent.push(path)
  }
  return recent
}

export async function readHermes(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const paths = await databasePaths(options)
    if (paths.length === 0) return { supported: true, rows: [] }
    const result = await databaseRows({ paths, sinceMs: options.sinceMs })
    if ('error' in result)
      return { supported: false, rows: [], reason: failure }
    const logs = new Map<number, LogInfo>()
    const rows: UsageRow[] = []
    for (const key of result.keys) {
      const [dbIndex, , , , first, last] = key
      if (kstDateOf(first) !== kstDateOf(last) && !logs.has(dbIndex)) {
        const path = paths[dbIndex]
        if (path === undefined) throw new MeterError(failure)
        logs.set(dbIndex, await readCallLog(dirname(path)))
      }
      for (const allocation of splitHermes(
        key,
        logs.get(dbIndex) ?? emptyLog,
      )) {
        const {
          ms,
          buckets: [input, output, cacheRead, cacheWrite],
          split,
        } = allocation
        const tokens = input + output + cacheRead + cacheWrite
        if (ms < options.sinceMs || tokens === 0) continue
        rows.push({
          date: kstDateOf(ms),
          tool: 'hermes',
          model: modelName(key[2]),
          provider: providerName(key[3]),
          tokens,
          input,
          output,
          cacheRead,
          cacheWrite,
          ...(split ? {} : { reasoning: key[10] }),
        })
      }
    }
    return { supported: true, rows: aggregate(rows) }
  } catch (error) {
    return unsupported(error, failure)
  }
}
