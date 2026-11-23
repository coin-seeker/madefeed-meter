import { parseArgs } from 'node:util'
import { MeterError } from './aggregate'
import type { AutoRuntime } from './auto'
import { helpText, invalidOptions } from './copy'
import type { Decompressor } from './zstd'

export type Runtime = AutoRuntime & {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly now?: number
  readonly fetch?: typeof fetch
  readonly output?: (text: string) => void
  readonly diagnostic?: (text: string) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly machineId?: () => Promise<string>
  readonly zstd?: Decompressor | null
}

export const VERSION = '0.7.0'
export const help = helpText(VERSION)

export function cliOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' },
        'no-auto': { type: 'boolean' },
        scheduled: { type: 'boolean' },
        days: { type: 'string' },
        url: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    })
  } catch (error) {
    if (error instanceof Error) throw new MeterError(invalidOptions)
    throw error
  }
}
