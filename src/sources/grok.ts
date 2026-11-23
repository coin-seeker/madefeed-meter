import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  MAX_ROW_TOKENS,
  directory,
  files,
  modelName,
  parseJson,
  recentFile,
  record,
  textLines,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'

const failure = 'Grok Build 기록을 읽지 못해 이번에는 빼고 올려요.'

function grokRoot(options: SourceOptions): string {
  return options.env?.['GROK_HOME']?.trim() || join(options.home, '.grok')
}

function amount(value: unknown): number {
  const result =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0
  return Number.isSafeInteger(result) ? result : 0
}

function eventMs(
  event: Record<string, unknown>,
  params: Record<string, unknown>,
): number {
  const ms = record(params['_meta'])['agentTimestampMs']
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms
  const seconds = event['timestamp']
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : NaN
}

async function summaryOf(dir: string): Promise<Record<string, unknown>> {
  try {
    return record(parseJson(await readFile(join(dir, 'summary.json'), 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return {}
    throw error
  }
}

export async function readGrok(options: SourceOptions): Promise<SourceResult> {
  try {
    const sessions = join(grokRoot(options), 'sessions')
    if (!(await directory(sessions))) return { supported: true, rows: [] }
    const paths: string[] = []
    for await (const path of files(sessions))
      if (basename(path) === 'updates.jsonl') paths.push(path)
    // Mutable cross-file accumulator: fork copies keep their earliest event time.
    const entries = new Map<
      string,
      { readonly ms: number; readonly row: UsageRow }
    >()
    for (const path of paths.sort()) {
      if (!(await recentFile(path, options.sinceMs))) continue
      const summary = await summaryOf(dirname(path))
      const kind = summary['session_kind']
      if (typeof kind === 'string' && kind.startsWith('subagent')) continue
      for await (const line of textLines(path)) {
        if (!line.includes('"turn_completed"')) continue
        const event = record(parseJson(line))
        const params = record(event['params'])
        const update = record(params['update'])
        const usage = update['usage']
        if (
          update['sessionUpdate'] !== 'turn_completed' ||
          typeof usage !== 'object' ||
          usage === null ||
          Array.isArray(usage)
        )
          continue
        const ms = eventMs(event, params)
        if (!Number.isFinite(ms)) continue
        const data = record(usage)
        const models = Object.entries(record(data['modelUsage']))
        const perModel: readonly (readonly [
          string,
          Record<string, unknown>,
        ])[] =
          models.length > 0
            ? models.map(([model, value]) => [modelName(model), record(value)])
            : [[modelName(summary['current_model_id']), data]]
        for (const [model, value] of perModel) {
          const input = amount(value['inputTokens'])
          const output = amount(value['outputTokens'])
          const cacheRead = Math.min(amount(value['cachedReadTokens']), input)
          const cacheWrite = Math.min(
            amount(value['cacheCreationTokens']),
            input - cacheRead,
          )
          const reasoning = amount(value['reasoningTokens'])
          const tokens = input + output
          if (tokens === 0) continue
          const promptId = update['prompt_id']
          const eventId = record(params['_meta'])['eventId']
          const sessionId = params['sessionId']
          const key = JSON.stringify(
            typeof promptId === 'string' && promptId.length > 0
              ? ['p', promptId, model]
              : typeof eventId === 'string' && eventId.length > 0
                ? ['e', eventId, model]
                : [
                    's',
                    typeof sessionId === 'string' && sessionId.length > 0
                      ? sessionId
                      : basename(dirname(path)),
                    ms,
                    model,
                    input,
                    output,
                    cacheRead,
                    cacheWrite,
                    reasoning,
                  ],
          )
          const previous = entries.get(key)
          if (!previous || ms < previous.ms)
            entries.set(key, {
              ms,
              row: {
                date: kstDateOf(ms),
                tool: 'grok',
                model,
                provider: model.startsWith('grok-') ? 'xai' : 'unknown',
                tokens,
                input: input - cacheRead - cacheWrite,
                output,
                cacheRead,
                cacheWrite,
                reasoning,
              },
            })
        }
      }
    }
    const rows = [...entries.values()]
      .filter((entry) => entry.ms >= options.sinceMs)
      .map((entry) => entry.row)
    // The format is not confirmed on a real install: a day total no real use
    // reaches means the fields moved, and such a row would fail the whole upload.
    const totals = new Map<string, number>()
    for (const row of rows) {
      const key = JSON.stringify([row.date, row.model])
      const total = (totals.get(key) ?? 0) + row.tokens
      if (total > MAX_ROW_TOKENS)
        return { supported: false, rows: [], reason: failure }
      totals.set(key, total)
    }
    return { supported: true, rows }
  } catch (error) {
    return unsupported(error, failure)
  }
}
