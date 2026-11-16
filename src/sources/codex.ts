import { join, basename } from 'node:path'
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

export async function readCodex(options: SourceOptions): Promise<SourceResult> {
  const rows: UsageRow[] = []
  try {
    const root = join(options.home, '.codex/sessions')
    // A tool that was never used here is an empty result, not a warning.
    if (!(await directory(root))) return { supported: true, rows: [] }
    for await (const path of files(root)) {
      if (
        !basename(path).startsWith('rollout-') ||
        !path.endsWith('.jsonl') ||
        !(await recentFile(path, options.sinceMs))
      )
        continue
      let model = 'unknown'
      let previous = 0
      for await (const value of jsonLines(path)) {
        const event = record(value)
        const data = record(event['payload'])
        if (event['type'] === 'turn_context') {
          model = modelName(data['model'])
          continue
        }
        if (event['type'] !== 'event_msg' || data['type'] !== 'token_count')
          continue
        const info = record(data['info'])
        const total = record(info['total_token_usage'])['total_tokens']
        if (
          typeof total !== 'number' ||
          !Number.isSafeInteger(total) ||
          total < 0
        )
          continue
        const delta =
          total >= previous
            ? total - previous
            : count(record(info['last_token_usage'])['total_tokens'])
        previous = total
        const ms = timestamp(event['timestamp'])
        if (Number.isFinite(ms) && ms >= options.sinceMs && delta > 0)
          rows.push({
            date: kstDateOf(ms),
            tool: 'codex',
            model,
            tokens: delta,
          })
      }
    }
    return { supported: true, rows }
  } catch (error) {
    return unsupported(error, 'Codex 기록을 읽지 못해 이번에는 빼고 올려요.')
  }
}
