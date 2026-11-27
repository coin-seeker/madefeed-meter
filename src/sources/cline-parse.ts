import {
  modelName,
  parseJson,
  providerName,
  record,
  timestamp,
} from '../aggregate'
import type { UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { inferProvider } from './vendor'

export type ClineKind = 'extension' | 'cli'
export type ClineEntry = { readonly ms: number; readonly row: UsageRow }

export function parseCline(value: unknown, kind: ClineKind): ClineEntry[] {
  const messages: unknown =
    kind === 'extension' ? value : record(value)['messages']
  if (!Array.isArray(messages)) return []
  const entries: ClineEntry[] = []
  for (const value of messages) {
    const message = record(value)
    const info = record(message['modelInfo'])
    let usage: Record<string, unknown>
    let model: unknown
    let provider: unknown
    let ms: number
    let names: readonly string[]
    switch (kind) {
      case 'extension':
        if (
          message['type'] !== 'say' ||
          message['say'] !== 'api_req_started' ||
          message['partial'] === true ||
          typeof message['text'] !== 'string'
        )
          continue
        usage = record(parseJson(message['text']))
        model = info['modelId']
        provider = info['providerId']
        ms = typeof message['ts'] === 'number' ? message['ts'] : NaN
        names = ['tokensIn', 'tokensOut', 'cacheReads', 'cacheWrites']
        break
      case 'cli':
        if (message['role'] !== 'assistant') continue
        usage = record(message['metrics'])
        model = info['id']
        provider = info['provider']
        ms =
          'ts' in message
            ? typeof message['ts'] === 'number'
              ? message['ts']
              : NaN
            : typeof message['timestamp'] === 'string'
              ? timestamp(message['timestamp'])
              : NaN
        names = [
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
        ]
        break
      default: {
        const exhaustive: never = kind
        return exhaustive
      }
    }
    if (
      ms < 0 ||
      !Number.isFinite(new Date(ms).getTime()) ||
      typeof model !== 'string' ||
      !model.trim() ||
      model.trim().toLowerCase() === 'unknown'
    )
      continue
    const counts = names.map((name) => usage[name])
    if (
      !counts.every(
        (value): value is number =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0,
      )
    )
      continue
    const [rawInput = 0, output = 0, cacheRead = 0, cacheWrite = 0] = counts
    const input = kind === 'cli' ? rawInput - cacheRead - cacheWrite : rawInput
    const tokens = input + output + cacheRead + cacheWrite
    if (input < 0 || tokens <= 0 || !Number.isSafeInteger(tokens)) continue
    entries.push({
      ms,
      row: {
        date: kstDateOf(ms),
        tool: 'cline',
        model: modelName(model.trim()),
        provider:
          typeof provider === 'string' && provider.trim()
            ? providerName(provider.trim())
            : inferProvider(model),
        tokens,
        input,
        output,
        cacheRead,
        cacheWrite,
      },
    })
  }
  return entries
}
