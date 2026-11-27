import { Worker } from 'node:worker_threads'

export async function runSqliteWorker<I, O>(
  fn: (input: I) => O,
  input: I,
  timeoutMs = 45_000,
): Promise<O | { error: true }> {
  let worker: Worker
  try {
    worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads'); parentPort.postMessage((${fn.toString()})(workerData))`,
      { eval: true, workerData: input },
    )
  } catch (error) {
    if (error instanceof Error) return { error: true }
    throw error
  }
  try {
    return await new Promise<O | { error: true }>((resolve) => {
      const fail = () => {
        clearTimeout(timer)
        resolve({ error: true })
      }
      const timer = setTimeout(fail, timeoutMs)
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', (value: O) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  } finally {
    await worker.terminate()
  }
}
