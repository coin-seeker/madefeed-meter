import { MAX_ROW_TOKENS } from '../aggregate'
import type { SourceResult, UsageRow } from '../aggregate'

export function capped(
  rows: readonly UsageRow[],
  failure: string,
): SourceResult {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = JSON.stringify([row.date, row.model])
    const total = (totals.get(key) ?? 0) + row.tokens
    if (total > MAX_ROW_TOKENS)
      return { supported: false, reason: failure, rows: [] }
    totals.set(key, total)
  }
  return { supported: true, rows }
}
