import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { textLines } from '../aggregate'

export type Buckets = readonly [
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
]
export type LoggedCall = { readonly ms: number; readonly buckets: Buckets }
export type LogInfo = {
  readonly files: number
  readonly oldest: number | undefined
  readonly calls: ReadonlyMap<string, readonly LoggedCall[]>
}

export async function readCallLog(dir: string): Promise<LogInfo> {
  const root = join(dir, 'logs')
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return []
      throw error
    },
  )
  const files = entries.filter(
    (e) =>
      e.isFile() &&
      (e.name === 'agent.log' || /^agent\.log\.\d+$/.test(e.name)),
  )
  const calls = new Map<string, LoggedCall[]>()
  const seen = new Set<string>()
  let oldest: number | undefined
  for (const file of files) {
    for await (const line of textLines(join(root, file.name))) {
      const stamp =
        /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) /.exec(line)
      if (!stamp) continue
      const ms = new Date(
        Number(stamp[1]),
        Number(stamp[2]) - 1,
        Number(stamp[3]),
        Number(stamp[4]),
        Number(stamp[5]),
        Number(stamp[6]),
        Number(stamp[7]),
      ).getTime()
      oldest = oldest === undefined ? ms : Math.min(oldest, ms)
      const match =
        /^(\S+ \S+) \S+ \[([^\]\s]+)\] agent\.conversation_loop: API call #(\d+): model=(\S+) provider=(\S+) in=(\d+) out=(\d+) total=\d+ latency=\S+(.*)$/.exec(
          line,
        )
      if (!match) continue
      const [
        ,
        stampText,
        session,
        number,
        model,
        provider,
        input,
        output,
        tail = '',
      ] = match
      const cache = Number(/(?:^| )cache=(\d+)\//.exec(tail)?.[1] ?? 0)
      const write = Number(/(?:^| )write=(\d+)(?: |$)/.exec(tail)?.[1] ?? 0)
      const fingerprint = JSON.stringify([
        session,
        model,
        provider,
        number,
        stampText,
        input,
        output,
        cache,
        write,
      ])
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      const key = `${session}\0${model}\0${provider}`
      const values = calls.get(key) ?? []
      values.push({
        ms,
        buckets: [
          Math.max(0, Number(input) - cache - write),
          Number(output),
          cache,
          write,
        ],
      })
      calls.set(key, values)
    }
  }
  return { files: files.length, oldest, calls }
}
