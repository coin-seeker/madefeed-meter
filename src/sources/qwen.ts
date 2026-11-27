import { basename, join, relative, sep } from 'node:path'
import {
  count,
  directory,
  files,
  jsonLines,
  modelName,
  record,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { inferProvider } from './vendor'

const failure = 'Qwen Code 기록을 읽지 못해 이번에는 빼고 올려요.'
type Entry = {
  readonly key: string
  readonly ms: number
  readonly row: UsageRow
}

function parseEntry(
  value: unknown,
  fallbackSession: string,
): Entry | undefined {
  const event = record(value)
  if (event['type'] !== 'assistant' || typeof event['timestamp'] !== 'string')
    return
  const ms = Date.parse(event['timestamp'])
  if (!Number.isFinite(ms)) return
  const usage = record(event['usageMetadata'])
  const prompt = count(usage['promptTokenCount'])
  const total = count(usage['totalTokenCount'])
  const candidates = count(usage['candidatesTokenCount'])
  const hasCandidates = 'candidatesTokenCount' in usage
  const hasPrompt =
    typeof usage['promptTokenCount'] === 'number' &&
    Number.isSafeInteger(usage['promptTokenCount']) &&
    usage['promptTokenCount'] >= 0
  const cacheRead = Math.min(count(usage['cachedContentTokenCount']), prompt)
  const input = prompt - cacheRead
  const rawOutput = hasCandidates
    ? total > prompt
      ? Math.min(candidates, total - prompt)
      : candidates
    : hasPrompt
      ? Math.max(total - prompt, 0)
      : 0
  const reasoning = count(usage['thoughtsTokenCount'])
  const remainder = Math.max(total - prompt - rawOutput, 0)
  const thoughtsOnly = !hasCandidates && total === 0
  const separateReasoning = thoughtsOnly
    ? reasoning
    : Math.min(reasoning, remainder)
  const extra = thoughtsOnly ? separateReasoning : remainder
  const tokens = prompt + rawOutput + extra
  if (tokens <= 0 || !Number.isSafeInteger(tokens)) return
  const output = rawOutput + separateReasoning
  const loggedModel = event['model']
  const model =
    typeof loggedModel === 'string' && loggedModel.trim()
      ? loggedModel.trim()
      : 'unknown'
  const loggedSession = event['sessionId']
  const session =
    typeof loggedSession === 'string' && loggedSession.trim()
      ? loggedSession.trim()
      : fallbackSession
  const replayOutput =
    thoughtsOnly || hasCandidates || rawOutput > 0 ? rawOutput : remainder
  const replayExtra = thoughtsOnly || hasCandidates || rawOutput > 0 ? extra : 0
  return {
    key: JSON.stringify([
      session,
      event['timestamp'],
      model,
      input,
      replayOutput,
      cacheRead,
      replayExtra,
    ]),
    ms,
    row: {
      date: kstDateOf(ms),
      tool: 'qwen',
      model: modelName(model),
      provider: inferProvider(model),
      tokens,
      ...(input + output + cacheRead > 0
        ? {
            input,
            output,
            cacheRead,
            ...(Object.hasOwn(usage, 'thoughtsTokenCount')
              ? { reasoning }
              : {}),
          }
        : {}),
    },
  }
}

export async function readQwen(options: SourceOptions): Promise<SourceResult> {
  try {
    const roots = await listRoots(
      options.env?.['QWEN_DATA_DIR'],
      [join(options.home, '.qwen')],
      options.home,
    )
    const seen = new Set<string>()
    const rows: UsageRow[] = []
    for (const root of roots) {
      const projects = join(root, 'projects')
      if (!(await directory(projects))) continue
      const paths: string[] = []
      for await (const path of files(projects)) {
        const parts = relative(projects, path).split(sep)
        if (
          parts[1] === 'chats' &&
          (parts.length === 3 ||
            (parts.length === 4 && parts[2] === 'archive')) &&
          path.endsWith('.jsonl')
        )
          paths.push(path)
      }
      for (const path of paths.sort()) {
        const project = relative(projects, path).split(sep)[0] ?? 'unknown'
        const session = `${project}-${basename(path, '.jsonl')}`
        for await (const value of jsonLines(path)) {
          const entry = parseEntry(value, session)
          if (!entry || seen.has(entry.key)) continue
          seen.add(entry.key)
          if (entry.ms >= options.sinceMs) rows.push(entry.row)
        }
      }
    }
    return capped(rows, failure)
  } catch (error) {
    return unsupported(error, failure)
  }
}
