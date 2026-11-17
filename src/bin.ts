import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { runCli } from './cli'
import type { Runtime } from './cli-options'
import { machineId } from './machine-id'
import { MeterError } from './aggregate'
import * as copy from './copy'

// npm runs the bin through a symlink (node_modules/.bin/madefeed), so compare
// real paths; a missing or unreadable argv[1] means this file was imported.
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

if (invokedDirectly()) {
  const entry = process.argv[1]
  const exec: NonNullable<Runtime['exec']> = (file, args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
        { encoding: 'utf8' },
        (error, stdout) => {
          if (error) reject(error)
          else resolve({ stdout })
        },
      )
      child.stdin?.on('error', (error: Error) => reject(error))
      child.stdin?.end(options?.input)
    })
  runCli(process.argv.slice(2), {
    exec,
    machineId: () =>
      machineId({
        platform: process.platform,
        exec,
        read: (path) => readFile(path, 'utf8'),
      }),
    ...(entry ? { self: realpathSync(entry) } : {}),
    platform: process.platform,
    ...(process.getuid ? { uid: process.getuid() } : {}),
  }).catch((error: unknown) => {
    // Only controlled errors reach output: filesystem/network errors can contain private paths.
    const message =
      error instanceof MeterError ? error.message : copy.localFailure
    if (process.argv.includes('--json'))
      console.error(JSON.stringify({ error: message }))
    else console.error(message)
    process.exitCode = 1
  })
}
