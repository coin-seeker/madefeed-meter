import { join } from 'node:path'
import {
  count,
  directory,
  files,
  jsonLines,
  recentFile,
  record,
  timestamp,
  modelName,
  unsupported,
} from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'

export async function readClaude(
  options: SourceOptions,
): Promise<SourceResult> {
  const messages = new Map<string, UsageRow>()
  try {
    const root = join(options.home, '.claude/projects')
    // A tool that was never used here is an empty result, not a warning.
    if (!(await directory(root))) return { supported: true, rows: [] }
    for await (const path of files(root)) {
      if (
        !path.endsWith('.jsonl') ||
        !(await recentFile(path, options.sinceMs))
      )
        continue
      for await (const value of jsonLines(path)) {
        const event = record(value)
        if (event['type'] !== 'assistant') continue
        const message = record(event['message'])
        const ms = timestamp(event['timestamp'])
        if (
          !Number.isFinite(ms) ||
          ms < options.sinceMs ||
          message['model'] === '<synthetic>'
        )
          continue
        if (
          typeof message['id'] !== 'string' ||
          typeof event['requestId'] !== 'string'
        )
          continue
        const usage = record(message['usage'])
        const tokens =
          count(usage['input_tokens']) +
          count(usage['output_tokens']) +
          count(usage['cache_creation_input_tokens']) +
          count(usage['cache_read_input_tokens'])
        const key = JSON.stringify([message['id'], event['requestId']])
        // Streaming/resumed snapshots may repeat with a larger final output count.
        if (tokens > (messages.get(key)?.tokens ?? -1))
          messages.set(key, {
            date: kstDateOf(ms),
            tool: 'claude-code',
            model: modelName(message['model']),
            tokens,
          })
      }
    }
    return { supported: true, rows: [...messages.values()] }
  } catch (error) {
    return unsupported(
      error,
      'Claude Code 기록을 읽지 못해 이번에는 빼고 올려요.',
    )
  }
}
