import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { aggregate } from '../src/aggregate'
import { readCodex } from '../src/sources/codex'

const usage = ([
  total,
  input,
  cached,
  write,
  output,
  reasoning,
]: readonly number[]) => ({
  total_tokens: total,
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
})

it.each(['.jsonl', '.jsonl.zst'])(
  'tracks provider and part deltas including pre-window baseline and reset in %s',
  async (extension) => {
    // Given
    const home = await mkdtemp(join(tmpdir(), 'madefeed-codex-parts-'))
    try {
      const root = join(home, '.codex/sessions')
      await mkdir(root, { recursive: true })
      const events = [
        { type: 'session_meta', payload: { model_provider: 'OpenAI' } },
        { type: 'turn_context', payload: { model: 'gpt-test' } },
        {
          type: 'event_msg',
          timestamp: '2026-11-14T00:00:00Z',
          payload: {
            type: 'token_count',
            info: { total_token_usage: usage([100, 80, 20, 10, 20, 5]) },
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-11-15T15:30:00Z',
          payload: {
            type: 'token_count',
            info: { total_token_usage: usage([160, 120, 30, 15, 40, 12]) },
          },
        },
        {
          type: 'event_msg',
          timestamp: '2026-11-15T15:30:00Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: usage([20, 15, 4, 2, 5, 3]),
              last_token_usage: usage([10, 7, 2, 1, 3, 1]),
            },
          },
        },
      ]
      const text = events.map((event) => JSON.stringify(event)).join('\n')
      await writeFile(
        join(root, `rollout-parts${extension}`),
        extension.endsWith('.zst') ? zlib.zstdCompressSync(text) : text,
      )
      // When
      const result = await readCodex({
        home,
        sinceMs: Date.parse('2026-11-15'),
        env: {},
      })
      // Then
      expect(aggregate(result.rows)).toEqual([
        {
          date: '2026-11-16',
          tool: 'codex',
          model: 'gpt-test',
          provider: 'openai',
          tokens: 70,
          input: 29,
          output: 23,
          cacheRead: 12,
          cacheWrite: 6,
          reasoning: 8,
        },
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
)
