import { expect, it } from 'vitest'
import { MAX_ROW_TOKENS } from '../src/aggregate'
import type { UsageRow } from '../src/aggregate'
import { capped } from '../src/sources/row-cap'

const row: UsageRow = {
  date: '2026-11-15',
  tool: 'amp',
  model: 'glm-5',
  provider: 'zai',
  tokens: 1,
}
it('keeps rows whose day and model sum equals the cap', () => {
  // Given
  const rows = [{ ...row, tokens: MAX_ROW_TOKENS - 1 }, row]
  // When
  const result = capped(rows, '실패')
  // Then
  expect(result).toEqual({ supported: true, rows })
})
it('discards the whole source when a model total across providers exceeds the cap', () => {
  // Given
  const rows = [
    { ...row, tokens: MAX_ROW_TOKENS },
    { ...row, provider: 'other' },
  ]
  // When
  const result = capped(rows, '고정 실패 사유')
  // Then
  expect(result).toEqual({
    supported: false,
    reason: '고정 실패 사유',
    rows: [],
  })
})
it('keeps separate dates and models below their individual caps', () => {
  // Given
  const rows = [
    { ...row, tokens: MAX_ROW_TOKENS },
    { ...row, date: '2026-11-16' },
    { ...row, model: 'glm-4' },
  ]
  // When
  const result = capped(rows, '실패')
  // Then
  expect(result).toEqual({ supported: true, rows })
})
