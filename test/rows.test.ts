import { expect, it } from 'vitest'
import {
  aggregate,
  MAX_ROW_TOKENS,
  MeterError,
  providerName,
} from '../src/aggregate'
import type { UsageRow } from '../src/aggregate'
import { uploadChunks } from '../src/chunks'

const row: UsageRow = {
  date: '2026-11-16',
  tool: 'codex',
  model: 'gpt',
  provider: 'openai',
  tokens: 10,
}

it.each([
  ['OpenAI', 'openai'],
  ['with space', 'unknown'],
  ['x'.repeat(41), 'unknown'],
  [42, 'unknown'],
])('normalizes provider %s', (value, expected) => {
  // Given / When / Then
  expect(providerName(value)).toBe(expected)
})
it('separates providers and sums only reported parts in sorted rows', () => {
  // Given
  const rows = [
    { ...row, provider: 'openrouter' },
    { ...row, input: 3, output: 7 },
    row,
    { ...row, input: 2 },
  ]
  // When
  const result = aggregate(rows)
  // Then
  expect(result).toEqual([
    { ...row, tokens: 30, input: 5, output: 7 },
    { ...row, provider: 'openrouter' },
  ])
})
it.each([MAX_ROW_TOKENS + 1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'drops invalid part sums without dropping tokens (%s)',
  (input) => {
    // Given / When
    const result = aggregate([{ ...row, input }])
    // Then
    expect(result).toEqual([row])
  },
)
it('drops overflowing accumulated parts and preserves other reported parts', () => {
  // Given / When
  const result = aggregate([
    { ...row, input: MAX_ROW_TOKENS, reasoning: 2 },
    { ...row, input: 1 },
  ])
  // Then
  expect(result).toEqual([{ ...row, tokens: 20, reasoning: 2 }])
})
it('moves an entire three-provider group past the 100-row boundary', () => {
  // Given
  const rows = [
    ...Array.from({ length: 99 }, (_, i) => ({ ...row, model: `a-${i}` })),
    ...['a', 'b', 'c'].map((provider) => ({ ...row, model: 'z', provider })),
  ]
  // When
  const chunks = uploadChunks(rows)
  // Then
  expect(chunks.map((chunk) => chunk.length)).toEqual([99, 3])
  expect(chunks[1]).toEqual(rows.slice(99))
})
it('never splits groups across a 250-row mixture', () => {
  // Given
  const rows = Array.from({ length: 250 }, (_, i) => ({
    ...row,
    model: `model-${Math.floor(i / 3)}`,
    provider: `p-${i % 3}`,
  }))
  // When
  const chunks = uploadChunks(rows)
  // Then
  expect(chunks.flat()).toEqual(rows)
  expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true)
  for (let i = 1; i < chunks.length; i++)
    expect(chunks[i - 1]?.at(-1)?.model).not.toBe(chunks[i]?.[0]?.model)
})
it('returns one empty heartbeat chunk for empty input', () => {
  // Given / When / Then
  expect(uploadChunks([])).toEqual([[]])
})
it('rejects an oversized group before uploading anything', () => {
  // Given
  const rows = Array.from({ length: 101 }, (_, i) => ({
    ...row,
    provider: `p-${i}`,
  }))
  // When / Then
  expect(() => uploadChunks(rows)).toThrow(MeterError)
  expect(() => uploadChunks(rows.slice(0, 3), 2)).toThrow(MeterError)
})
