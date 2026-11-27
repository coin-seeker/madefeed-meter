import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  directory,
  MAX_ROW_TOKENS,
  MeterError,
  modelName,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { databaseWorker } from './agy-db'
import type { DatabaseInput, DatabaseResult } from './agy-db'
import { antigravityProto } from './agy-proto'
import { antigravityModels } from './agy-model'
import { antigravityMerge } from './agy-merge'
import { inferProvider } from './vendor'

const failure = 'Antigravity 기록을 읽지 못해 이번에는 빼고 올려요.'

async function databaseRows(input: DatabaseInput): Promise<DatabaseResult> {
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage((${databaseWorker.toString()})(workerData,(${antigravityProto.toString()})(),(${antigravityModels.toString()})(),(${antigravityMerge.toString()})()))`,
    { eval: true, workerData: input },
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

async function walMtime(path: string): Promise<number> {
  try {
    return (await stat(`${path}-wal`)).mtimeMs
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return -Infinity
    throw error
  }
}

export async function readAgy(options: SourceOptions): Promise<SourceResult> {
  try {
    const custom = options.env?.['ANTIGRAVITY_DATA_DIR']
    const roots =
      custom !== undefined
        ? custom.split(',').filter(Boolean)
        : [
            '.gemini/antigravity',
            '.gemini/antigravity-cli',
            '.gemini/antigravity-ide',
            '.gemini/antigravity-backup',
            '.gemini/antigravity-acp',
            '.config/antigravity',
          ].map((root) => join(options.home, root, 'conversations'))
    const paths: string[] = []
    const seen = new Set<string>()
    for (const candidate of roots) {
      const nested = join(candidate, 'conversations')
      const root =
        custom !== undefined && (await directory(nested)) ? nested : candidate
      if (!(await directory(root))) continue
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.db')) continue
        const path = join(root, entry.name)
        const canonical = await realpath(path)
        if (seen.has(canonical)) continue
        seen.add(canonical)
        if (
          (await stat(path)).mtimeMs >= options.sinceMs ||
          (await walMtime(path)) >= options.sinceMs
        )
          paths.push(path)
      }
    }
    if (paths.length === 0) return { supported: true, rows: [] }
    const result = await databaseRows({
      paths: paths.toSorted(),
      sinceMs: options.sinceMs,
    })
    // The layout is reverse-engineered: a total no real day reaches means the
    // fields moved, and such a row would make the whole upload fail.
    if (
      'error' in result ||
      result.totals.some(([, , tokens]) => tokens > MAX_ROW_TOKENS)
    )
      return { supported: false, rows: [], reason: failure }
    return {
      supported: true,
      rows: result.totals.map(
        ([
          date,
          model,
          tokens,
          input,
          output,
          cacheRead,
          cacheWrite,
          reasoning,
        ]) => ({
          date,
          tool: 'agy',
          // Model ids have no slash here; a path-like string is not a model name.
          model: model.includes('/') ? 'unknown' : modelName(model),
          provider: model.includes('/')
            ? 'unknown'
            : inferProvider(modelName(model)),
          tokens,
          input,
          output,
          cacheRead,
          cacheWrite,
          reasoning,
        }),
      ),
    }
  } catch (error) {
    return unsupported(error, failure)
  }
}
