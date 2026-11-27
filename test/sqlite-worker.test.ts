import { expect, it } from 'vitest'
import { runSqliteWorker } from '../src/sources/sqlite-worker'

it('runs a self-contained function with builtin dependencies and cloned input', async () => {
  // Given
  const input = { pieces: ['one', 'two'] }
  // When
  const result = await runSqliteWorker((value: typeof input) => {
    const path = process.getBuiltinModule('node:path')
    return { path: path.join(...value.pieces) }
  }, input)
  // Then
  expect(result).toEqual({ path: 'one/two' })
})
it('returns an error when the worker throws', async () => {
  // Given / When
  const result = await runSqliteWorker(() => JSON.parse('{'), null)
  // Then
  expect(result).toEqual({ error: true })
})
it('returns an error when the worker exits without a message', async () => {
  // Given / When
  const result = await runSqliteWorker(() => process.exit(0), null)
  // Then
  expect(result).toEqual({ error: true })
})
it('terminates a stuck worker after its timeout', async () => {
  // Given / When
  const result = await runSqliteWorker(
    () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      return 1
    },
    null,
    100,
  )
  // Then
  expect(result).toEqual({ error: true })
})
it('returns an error for input that cannot be cloned', async () => {
  // Given / When
  const result = await runSqliteWorker(
    () => 1,
    () => 2,
  )
  // Then
  expect(result).toEqual({ error: true })
})
