import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { directory, MeterError, modelName, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult } from '../aggregate'
import { databaseWorker } from './agy-db'
import type { DatabaseInput, DatabaseResult } from './agy-db'

const failure = 'Antigravity 기록을 읽지 못해 이번에는 빼고 올려요.'

async function databaseRows(input: DatabaseInput): Promise<DatabaseResult> {
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage((${databaseWorker.toString()})(workerData))`,
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
    const root = join(options.home, '.gemini/antigravity-cli/conversations')
    if (!(await directory(root))) return { supported: true, rows: [] }
    const paths: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue
      const path = join(root, entry.name)
      if (
        (await stat(path)).mtimeMs >= options.sinceMs ||
        (await walMtime(path)) >= options.sinceMs
      )
        paths.push(path)
    }
    if (paths.length === 0) return { supported: true, rows: [] }
    const result = await databaseRows({
      paths: paths.toSorted(),
      sinceMs: options.sinceMs,
    })
    if ('error' in result)
      return { supported: false, rows: [], reason: failure }
    return {
      supported: true,
      rows: result.totals.map(([date, model, tokens]) => ({
        date,
        tool: 'agy',
        model: modelName(model),
        tokens,
      })),
    }
  } catch (error) {
    return unsupported(error, failure)
  }
}
