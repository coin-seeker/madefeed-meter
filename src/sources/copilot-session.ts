import { count, modelName, record, timestamp } from '../aggregate'
import type { UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'

const fields = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
] as const
type Parts = Readonly<Record<(typeof fields)[number], number>>
export type CopilotEntry = {
  readonly kind: 'receipt' | 'shutdown'
  readonly session: string
  readonly source: string | undefined
  readonly ms: number
  readonly model: string
  readonly key: string
  readonly watermarked: boolean
  readonly parts: Parts
  readonly reported: readonly (typeof fields)[number][]
}
export function copilotEntries(
  value: unknown,
  context: { readonly session: string; readonly line: number },
): CopilotEntry[] {
  const event = record(value),
    data = record(event['data'])
  const ms = timestamp(event['timestamp'])
  if (!(ms > 0) || !Number.isFinite(new Date(ms).getTime())) return []
  const kind =
    event['type'] === 'session.usage_record'
      ? 'receipt'
      : event['type'] === 'session.shutdown'
        ? 'shutdown'
        : undefined
  if (!kind) return []
  const usage = record(data['usage'])
  const models: readonly (readonly [unknown, Record<string, unknown>])[] =
    kind === 'receipt'
      ? [[usage['model'], usage]]
      : Object.entries(record(data['modelMetrics'])).map(([model, metric]) => [
          model,
          record(record(metric)['usage']),
        ])
  return models.map(([rawModel, counters]) => {
    const model = modelName(
      typeof rawModel === 'string'
        ? rawModel.replace(/-1m(?:-internal)?$/, '')
        : rawModel,
    )
    const cacheRead = count(counters['cacheReadTokens']),
      cacheWrite = count(counters['cacheWriteTokens'])
    const parts = {
      input: Math.max(
        count(counters['inputTokens']) - cacheRead - cacheWrite,
        0,
      ),
      output: count(counters['outputTokens']),
      cacheRead,
      cacheWrite,
      reasoning: count(counters['reasoningTokens']),
    }
    const accounting = record(counters['accounting'])
    const source =
      typeof accounting['sourceSessionId'] === 'string' &&
      accounting['sourceSessionId']
        ? accounting['sourceSessionId']
        : undefined
    const sequence = accounting['sequence']
    const identity =
      kind === 'receipt' &&
      source &&
      Number.isSafeInteger(sequence) &&
      typeof sequence === 'number' &&
      sequence >= 0
        ? ['accounting', source, sequence]
        : [
            context.session,
            typeof event['id'] === 'string' && event['id']
              ? event['id']
              : kind === 'receipt'
                ? context.line
                : [ms, parts],
            model,
          ]
    const rawFields = [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ] as const
    return {
      kind,
      session: context.session,
      source,
      ms,
      model,
      key: JSON.stringify(identity),
      watermarked: Object.values(
        record(data['usageAccountingWatermarks']),
      ).some((value) => count(value) > 0),
      parts,
      reported: fields.filter(
        (_, index) => counters[rawFields[index] ?? 'inputTokens'] !== undefined,
      ),
    }
  })
}
export function copilotRows(
  entries: readonly CopilotEntry[],
  sinceMs: number,
): UsageRow[] {
  const receipts = new Map<string, CopilotEntry>(),
    snapshots = new Map<string, CopilotEntry>()
  const firstReceipt = new Map<string, number>()
  for (const entry of entries) {
    switch (entry.kind) {
      case 'receipt': {
        firstReceipt.set(
          entry.session,
          Math.min(firstReceipt.get(entry.session) ?? Infinity, entry.ms),
        )
        const previous = receipts.get(entry.key)
        if (
          !previous ||
          (entry.session === entry.source &&
            previous.session !== previous.source) ||
          (entry.session !== entry.source &&
            previous.session !== previous.source &&
            entry.session < previous.session)
        )
          receipts.set(entry.key, entry)
        break
      }
      case 'shutdown': {
        const previous = snapshots.get(entry.key)
        if (!previous || previous.ms <= entry.ms)
          snapshots.set(entry.key, entry)
        break
      }
      default: {
        const unreachable: never = entry.kind
        throw new TypeError(String(unreachable))
      }
    }
  }
  const rows: UsageRow[] = []
  const append = (entry: CopilotEntry, parts: Parts) => {
    const tokens =
      parts.input + parts.output + parts.cacheRead + parts.cacheWrite
    if (!tokens || entry.ms < sinceMs) return
    rows.push({
      date: kstDateOf(entry.ms),
      tool: 'copilot',
      model: entry.model,
      provider: 'github-copilot',
      tokens,
      ...Object.fromEntries(
        entry.reported.map((field) => [field, parts[field]]),
      ),
    })
  }
  for (const entry of receipts.values()) append(entry, entry.parts)
  const baselines = new Map<string, Parts>()
  for (const entry of [...snapshots.values()].sort((a, b) => a.ms - b.ms)) {
    const key = JSON.stringify([entry.session, entry.model]),
      previous = baselines.get(key)
    const parts = previous
      ? {
          input: Math.max(entry.parts.input - previous.input, 0),
          output: Math.max(entry.parts.output - previous.output, 0),
          cacheRead: Math.max(entry.parts.cacheRead - previous.cacheRead, 0),
          cacheWrite: Math.max(entry.parts.cacheWrite - previous.cacheWrite, 0),
          reasoning: Math.max(entry.parts.reasoning - previous.reasoning, 0),
        }
      : entry.parts
    baselines.set(key, entry.parts)
    if (
      !entry.watermarked &&
      entry.ms < (firstReceipt.get(entry.session) ?? Infinity)
    )
      append(entry, parts)
  }
  return rows
}
