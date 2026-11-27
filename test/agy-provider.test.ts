import { expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { readAgy } from '../src/sources/agy'
import { chatGeneration, database, fixture, seconds } from './agy-fixtures'

it.each([
  ['openai/gpt-oss-120b', 'unknown', 'unknown'],
  ['gpt-oss-120b-medium', 'gpt-oss-120b', 'openai'],
])(
  'handles Antigravity model %s without treating paths as model identities',
  async (text, model, provider) => {
    // Given
    const options = await fixture()
    try {
      database(options.root, 'a.db', {
        tables: ['gen_metadata'],
        generations: [
          chatGeneration({ secs: seconds, text, call: { input: 7 } }),
        ],
      })
      // When
      const result = await readAgy(options)
      // Then
      expect(result.supported).toBe(true)
      expect(result.rows).toEqual([
        expect.objectContaining({ model, provider, tokens: 7 }),
      ])
    } finally {
      await rm(options.home, { recursive: true, force: true })
    }
  },
)
