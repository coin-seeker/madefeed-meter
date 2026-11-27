import { count, modelName, providerName, record, timestamp } from '../aggregate'
import type { UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { inferProvider } from './vendor'

export type ClawEntry = {
  readonly session: string
  readonly id: string | undefined
  readonly ms: number
  readonly migration: string
  readonly content: string
  readonly row: UsageRow
}
export class ClawFold {
  private model: unknown
  private provider: unknown
  constructor(private readonly session: string) {}

  accept(value: unknown, fallback?: unknown): ClawEntry | undefined {
    const event = record(value)
    if (
      event['type'] === 'model_change' ||
      (event['type'] === 'custom' && event['customType'] === 'model-snapshot')
    ) {
      const data = event['data'] === undefined ? event : record(event['data'])
      this.model = data['modelId'] ?? data['model'] ?? this.model
      this.provider = data['provider'] ?? this.provider
      return undefined
    }
    const message = record(event['message'])
    if (event['type'] !== 'message' || message['role'] !== 'assistant')
      return undefined
    const usage = record(message['usage'])
    const ms = timestamp(message['timestamp'] ?? event['timestamp'] ?? fallback)
    if (
      !(ms > 0) ||
      !Number.isFinite(ms) ||
      !Number.isFinite(new Date(ms).getTime())
    )
      return undefined
    const input = count(usage['input']),
      output = count(usage['output'])
    const cacheRead = count(usage['cacheRead']),
      cacheWrite = count(usage['cacheWrite'])
    const sum = input + output + cacheRead + cacheWrite
    const tokens = Math.max(count(usage['totalTokens']), sum)
    if (!tokens) return undefined
    const model = modelName(
      message['modelId'] ?? message['model'] ?? this.model,
    )
    const rawProvider = message['provider'] ?? this.provider
    const provider =
      rawProvider === undefined
        ? inferProvider(model)
        : providerName(rawProvider)
    const migration = JSON.stringify([
      this.session,
      ms,
      model,
      input,
      output,
      cacheWrite,
      cacheRead,
      tokens - sum,
    ])
    const parts: Partial<UsageRow> =
      sum > 0
        ? {
            ...(usage['input'] !== undefined ? { input } : {}),
            ...(usage['output'] !== undefined ? { output } : {}),
            ...(usage['cacheRead'] !== undefined ? { cacheRead } : {}),
            ...(usage['cacheWrite'] !== undefined ? { cacheWrite } : {}),
          }
        : {}
    return {
      session: this.session,
      id: typeof event['id'] === 'string' ? event['id'] : undefined,
      ms,
      migration,
      content: JSON.stringify([migration, record(usage['cost'])['total'] ?? 0]),
      row: {
        date: kstDateOf(ms),
        tool: 'openclaw',
        model,
        provider,
        tokens,
        ...parts,
      },
    }
  }
}
