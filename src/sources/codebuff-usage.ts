import { count, record, timestamp } from '../aggregate'

type Usage = {
  readonly model: string | undefined
  readonly input: number
  readonly output: number | undefined
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
}
export function codebuffText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
export function codebuffTime(value: unknown): number {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0
      ? value < 100_000_000_000
        ? value * 1000
        : value
      : NaN
  return timestamp(value)
}
function parseUsage(raw: unknown): Usage {
  const data = record(raw)
  const pick = (keys: readonly string[]) =>
    keys.map((key) => count(data[key])).find((value) => value > 0) ?? 0
  const outputs = [
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  ]
    .map((key) => data[key])
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    )
  return {
    model: codebuffText(data['model']),
    input: pick([
      'inputTokens',
      'input_tokens',
      'promptTokens',
      'prompt_tokens',
    ]),
    output: outputs.find((value) => value > 0) ?? outputs[0],
    cacheRead: Math.max(
      pick(['cacheReadInputTokens', 'cache_read_input_tokens']),
      count(record(data['promptTokensDetails'])['cachedTokens']),
      count(record(data['prompt_tokens_details'])['cached_tokens']),
    ),
    cacheWrite: pick([
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
      'cacheCreationTokens',
      'cache_creation_tokens',
      'cachedTokensCreated',
      'cached_tokens_created',
    ]),
    total: pick(['totalTokens', 'total_tokens', 'total']),
  }
}
function merge(primary: Usage, fallback: Usage): Usage {
  return {
    model: primary.model ?? fallback.model,
    input: primary.input || fallback.input,
    output:
      primary.output !== undefined && primary.output > 0
        ? primary.output
        : (fallback.output ?? primary.output),
    cacheRead: primary.cacheRead || fallback.cacheRead,
    cacheWrite: primary.cacheWrite || fallback.cacheWrite,
    total: primary.total || fallback.total,
  }
}
export function codebuffUsage(message: Record<string, unknown>): Usage {
  const metadata = record(message['metadata'])
  let usage = merge(
    {
      ...parseUsage(metadata['usage']),
      model:
        codebuffText(metadata['model']) ??
        codebuffText(record(metadata['usage'])['model']),
    },
    parseUsage(record(metadata['codebuff'])['usage']),
  )
  const history = record(
    record(record(metadata['runState'])['sessionState'])['mainAgentState'],
  )['messageHistory']
  if (!Array.isArray(history)) return usage
  for (const raw of history.toReversed()) {
    const entry = record(raw)
    if (entry['role'] !== 'assistant') continue
    const options = record(entry['providerOptions'])
    const codebuff = record(options['codebuff'])
    const parsed = merge(
      parseUsage(options['usage']),
      parseUsage(codebuff['usage']),
    )
    usage = merge(usage, {
      ...parsed,
      model: codebuffText(codebuff['model']) ?? parsed.model,
    })
  }
  return usage
}
