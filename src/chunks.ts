import { MeterError } from './aggregate'
import type { UsageRow } from './aggregate'

export function uploadChunks(
  rows: readonly UsageRow[],
  size = 100,
): UsageRow[][] {
  const groups = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.date, row.tool, row.model])
    const group = groups.get(key) ?? []
    group.push(row)
    if (group.length > size)
      throw new MeterError(
        '같은 날짜·도구·모델의 제공사 기록이 요청 허용 행 수를 넘어요.',
      )
    groups.set(key, group)
  }
  const chunks: UsageRow[][] = []
  let chunk: UsageRow[] = []
  for (const group of groups.values()) {
    if (chunk.length + group.length > size) {
      chunks.push(chunk)
      chunk = []
    }
    chunk.push(...group)
  }
  if (chunk.length || chunks.length === 0) chunks.push(chunk)
  return chunks
}
