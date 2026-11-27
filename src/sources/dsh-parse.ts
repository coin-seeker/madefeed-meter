import { createReadStream } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import {
  count,
  modelName,
  parseJson,
  providerName,
  record,
  textLines,
} from '../aggregate'
import type { UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import type { Decompressor } from '../zstd'
import { inferProvider } from './vendor'

export type DshEntry = {
  readonly key: string
  readonly ms: number
  readonly rank: readonly number[]
  readonly row: UsageRow
}
class DshFold {
  private header: Record<string, unknown> | undefined
  private rejected = false
  private seeded = false
  private model: unknown
  private provider: unknown
  private readonly entries: DshEntry[] = []
  constructor(private readonly fallback: string) {}

  accept(line: string): void {
    if (!line.trim() || this.rejected) return
    const event = record(parseJson(line)),
      data = record(event['data'])
    if (!this.header) {
      if (event['type'] !== 'session') {
        this.rejected = true
        return
      }
      this.header = event
      this.seeded = event['isSeeded'] === true
      return
    }
    let usage: Record<string, unknown>,
      model = this.model,
      provider = this.provider
    switch (event['type']) {
      case 'request/header':
      case 'request/context': {
        const route =
          event['type'] === 'request/header'
            ? record(record(data['header'])['config'])
            : data
        if (typeof route['model'] === 'string' && route['model']) {
          this.model = route['model']
          this.provider = route['provider']
        }
        return
      }
      case 'session/end-seed':
        if (data['inherited'] === true) {
          this.entries.length = 0
          this.seeded = false
        }
        return
      case 'assistant/message':
      case 'assistant/attempt': {
        let settled = data['usage']
        if (settled === undefined || settled === null) {
          const stream = data['stream']
          if (Array.isArray(stream)) {
            for (let i = stream.length - 1; i >= 0; i--) {
              const item = record(stream[i]),
                chunk = record(item['chunk'])
              if (item['type'] === 'chunk' && chunk['type'] === 'usage') {
                settled = chunk['usage']
                break
              }
            }
          }
        }
        usage = record(settled)
        break
      }
      case 'compaction/summary':
        usage = record(data['usage'])
        model = data['model']
        provider = data['provider']
        break
      default:
        return
    }
    const ms = count(event['time']) || count(this.header['createdAt'])
    if (!ms || !Number.isFinite(new Date(ms).getTime())) return
    const input = count(usage['inputTokens']),
      cacheRead = count(usage['cacheReadTokens']),
      cacheWrite = count(usage['cacheWriteTokens'])
    const output =
      usage['outputTokens'] === undefined &&
      typeof usage['inputTokens'] === 'number'
        ? Math.max(
            count(usage['totalTokens']) - input - cacheRead - cacheWrite,
            0,
          )
        : count(usage['outputTokens'])
    const sum = input + output + cacheRead + cacheWrite,
      tokens = Math.max(sum, count(usage['totalTokens']))
    if (!tokens) return
    const remainder = tokens - sum,
      normalizedModel = modelName(model)
    const session =
      typeof this.header['id'] === 'string' && this.header['id']
        ? this.header['id']
        : this.fallback
    const seq = event['seq']
    const key = JSON.stringify(
      Number.isSafeInteger(seq)
        ? [session, seq]
        : [
            session,
            ms,
            normalizedModel,
            input,
            output || remainder,
            cacheWrite,
            cacheRead,
          ],
    )
    this.entries.push({
      key,
      ms,
      rank: [sum, output, input, cacheWrite, remainder, -ms],
      row: {
        date: kstDateOf(ms),
        tool: 'dsh',
        model: normalizedModel,
        provider:
          provider === undefined
            ? inferProvider(normalizedModel)
            : providerName(provider),
        tokens,
        ...(sum > 0
          ? {
              ...(usage['inputTokens'] !== undefined ? { input } : {}),
              ...(usage['outputTokens'] !== undefined || output > 0
                ? { output }
                : {}),
              ...(usage['cacheReadTokens'] !== undefined ? { cacheRead } : {}),
              ...(usage['cacheWriteTokens'] !== undefined
                ? { cacheWrite }
                : {}),
            }
          : {}),
      },
    })
  }
  finish(): readonly DshEntry[] {
    return this.seeded ? [] : this.entries
  }
}
export function preferDsh(next: DshEntry, previous: DshEntry): boolean {
  for (const [index, value] of next.rank.entries()) {
    const difference = value - (previous.rank[index] ?? 0)
    if (difference) return difference > 0
  }
  return (
    JSON.stringify([next.row.model, next.row.provider]) >
    JSON.stringify([previous.row.model, previous.row.provider])
  )
}
export async function dshSession(
  path: string,
  zstd?: Decompressor,
): Promise<readonly DshEntry[]> {
  const fold = new DshFold(basename(dirname(path)))
  if (!path.endsWith('.zstd')) {
    for await (const line of textLines(path)) fold.accept(line)
    return fold.finish()
  }
  if (!zstd) return []
  const stream = zstd(),
    decoder = new StringDecoder('utf8')
  let tail = '',
    complete = 0
  // Consume decoded data before a trailing frame error destroys the stream.
  stream.on('data', (chunk: Buffer) => {
    tail += decoder.write(chunk)
    let end = tail.indexOf('\n')
    while (end >= 0) {
      fold.accept(tail.slice(0, end))
      complete++
      tail = tail.slice(end + 1)
      end = tail.indexOf('\n')
    }
  })
  try {
    await pipeline(createReadStream(path), stream)
    tail += decoder.end()
    if (tail) fold.accept(tail)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['Z_BUF_ERROR', 'Z_DATA_ERROR'].includes(String(error.code)) ||
      !complete
    )
      throw error
  }
  return fold.finish()
}
