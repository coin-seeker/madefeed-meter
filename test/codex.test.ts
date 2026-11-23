import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { aggregate, jsonLines } from '../src/aggregate'
import { readCodex, recentRollout, rolloutLines } from '../src/sources/codex'
import { zstdDecompressor } from '../src/zstd'

const sinceMs = Date.parse('2026-11-15T00:00:00Z')
const homes: string[] = []
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  )
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-codex-'))
  homes.push(home)
  return { home, sinceMs, env: {} }
}
function content(total = 70) {
  return [
    { type: 'turn_context', payload: { model: 'gpt-test' } },
    {
      type: 'event_msg',
      timestamp: '2026-11-15T15:30:00Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: total } },
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\r\n')
}
async function put(
  path: string,
  data: string | Uint8Array,
  mtime = sinceMs + 1,
) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  await utimes(path, new Date(mtime), new Date(mtime))
}
function row(tokens = 70) {
  return {
    date: '2026-11-16',
    tool: 'codex',
    model: 'gpt-test',
    provider: 'unknown',
    tokens,
  }
}

it('reads compressed rollouts with the same rows as plain rollouts', async () => {
  // Given
  const options = await fixture()
  const plainHome = await fixture()
  await put(
    join(options.home, '.codex/sessions/nested/rollout-a.jsonl.zst'),
    zlib.zstdCompressSync(content()),
  )
  await put(join(plainHome.home, '.codex/sessions/rollout-a.jsonl'), content())
  // When
  const compressed = await readCodex(options)
  const plain = await readCodex(plainHome)
  // Then
  expect(compressed).toEqual({ supported: true, rows: [row()] })
  expect(compressed).toEqual(plain)
})
it('prefers plain twins across roots even when compressed content differs', async () => {
  // Given
  const options = await fixture()
  await put(
    join(options.home, '.codex/archived_sessions/rollout-a.jsonl.zst'),
    zlib.zstdCompressSync(content(999)),
  )
  await put(join(options.home, '.codex/sessions/rollout-a.jsonl'), content())
  // When
  const result = await readCodex(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [row()] })
})
it('reads archived sessions recursively', async () => {
  // Given
  const options = await fixture()
  await put(
    join(options.home, '.codex/archived_sessions/nested/rollout-a.jsonl'),
    content(),
  )
  // When
  const result = await readCodex(options)
  // Then
  expect(result.rows).toEqual([row()])
})
it('honors comma-separated CODEX_HOME and ignores duplicate homes and empty entries', async () => {
  // Given
  const options = await fixture()
  const custom = join(options.home, 'custom')
  const second = join(options.home, 'second')
  await put(
    join(options.home, '.codex/sessions/rollout-default.jsonl'),
    content(10),
  )
  await put(join(custom, 'sessions/rollout-custom.jsonl'), content(20))
  await put(
    join(second, 'archived_sessions/rollout-second.jsonl.zst'),
    zlib.zstdCompressSync(content(30)),
  )
  // When
  const result = await readCodex({
    ...options,
    env: {
      CODEX_HOME: `,${custom},${custom}/.,,${join(options.home, '.codex')},${second},`,
    },
  })
  // Then
  expect(aggregate(result.rows)).toEqual([row(60)])
})
it('ignores temporary compressed files and unrelated basenames', async () => {
  // Given
  const options = await fixture()
  for (const name of [
    'rollout-x.jsonl.zst.tmp',
    'other.jsonl',
    'other.jsonl.zst',
  ])
    await put(
      join(options.home, '.codex/sessions', name),
      zlib.zstdCompressSync(content()),
    )
  // When
  const result = await readCodex({ ...options, zstd: null })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('discards plain totals when an in-window compressed rollout requires unavailable zstd', async () => {
  // Given
  const options = await fixture()
  await put(
    join(options.home, '.codex/sessions/rollout-plain.jsonl'),
    content(),
  )
  await put(
    join(options.home, '.codex/sessions/rollout-zst.jsonl.zst'),
    zlib.zstdCompressSync(content()),
  )
  // When
  const result = await readCodex({ ...options, zstd: null })
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason:
      '압축된 Codex 기록을 읽으려면 Node.js 22.15 이상이 필요해서 이번에는 Codex를 빼고 올려요.',
  })
})
it.each([false, true])(
  'reads plain files without zstd when stale compressed file presence is %s',
  async (stale) => {
    // Given
    const options = await fixture()
    await put(
      join(options.home, '.codex/sessions/rollout-plain.jsonl'),
      content(),
    )
    if (stale)
      await put(
        join(options.home, '.codex/sessions/rollout-old.jsonl.zst'),
        zlib.zstdCompressSync(content(999)),
        sinceMs - 1,
      )
    // When
    const result = await readCodex({ ...options, zstd: null })
    // Then
    expect(result).toEqual({ supported: true, rows: [row()] })
  },
)
it.each(['truncated', 'garbage'])(
  'rejects %s zstd without partial rows or hanging',
  async (kind) => {
    // Given
    const options = await fixture()
    const data = zlib.zstdCompressSync(
      `${content()}\n${Array.from({ length: 10000 }, (_, i) => JSON.stringify({ text: `한글-${i}` })).join('\n')}`,
    )
    await put(join(options.home, '.codex/sessions/rollout-a.jsonl'), content())
    await put(
      join(options.home, '.codex/sessions/rollout-b.jsonl.zst'),
      kind === 'truncated'
        ? data.subarray(0, data.length - 11)
        : Buffer.from('garbage'),
    )
    // When
    const result = await readCodex(options)
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'Codex 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  },
  5000,
)
it('decodes concatenated zstd frames completely', async () => {
  // Given
  const options = await fixture()
  const data = Buffer.concat([
    zlib.zstdCompressSync(`${content(10)}\n`),
    zlib.zstdCompressSync(content(70)),
  ])
  await put(join(options.home, '.codex/sessions/rollout-a.jsonl.zst'), data)
  // When
  const result = await readCodex(options)
  // Then
  expect(aggregate(result.rows)).toEqual([row()])
})
it.each(['.jsonl', '.jsonl.zst'])(
  'parses BOM-prefixed lines in %s',
  async (extension) => {
    // Given
    const options = await fixture()
    const text = `\uFEFF${content().replace('\r\n', '\r\n\uFEFF')}`
    await put(
      join(options.home, `.codex/sessions/rollout-a${extension}`),
      extension.endsWith('.zst') ? zlib.zstdCompressSync(text) : text,
    )
    // When
    const result = await readCodex(options)
    // Then
    expect(result.rows).toEqual([row()])
  },
)
it.each(['.jsonl', '.jsonl.zst'])(
  'retries a vanished %s path using its counterpart',
  async (extension) => {
    // Given
    const options = await fixture()
    const base = join(options.home, 'rollout-a.jsonl')
    const compressed = extension === '.jsonl'
    await put(
      compressed ? `${base}.zst` : base,
      compressed ? zlib.zstdCompressSync(content()) : content(),
    )
    // When
    const lines = await Array.fromAsync(
      rolloutLines(
        extension === '.jsonl' ? base : `${base}.zst`,
        zstdDecompressor(),
      ),
    )
    // Then
    expect(lines).toEqual(content().split('\r\n'))
  },
)
it('skips files whose chosen mtime is before the window', async () => {
  // Given
  const options = await fixture()
  await put(
    join(options.home, '.codex/sessions/rollout-a.jsonl'),
    content(),
    sinceMs - 1,
  )
  await put(
    join(options.home, '.codex/sessions/rollout-a.jsonl.zst'),
    zlib.zstdCompressSync(content(999)),
  )
  // When
  const result = await readCodex({ ...options, zstd: null })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('keeps jsonLines plain-file BOM parsing compatible with other readers', async () => {
  // Given
  const options = await fixture()
  const path = join(options.home, 'plain.jsonl')
  await put(path, '\uFEFF{"text":"한글"}')
  // When
  const values = await Array.fromAsync(jsonLines(path))
  // Then
  expect(values).toEqual([{ text: '한글' }])
})

it('follows a rollout that Codex compressed between listing and reading', async () => {
  // Given: only the compressed twin is left where a plain rollout was listed.
  const options = await fixture()
  const listed = join(options.home, '.codex/sessions/rollout-a.jsonl')
  await put(`${listed}.zst`, zlib.zstdCompressSync(content()))
  // When
  const present = await recentRollout(listed, options.sinceMs)
  const gone = await recentRollout(
    join(options.home, '.codex/sessions/rollout-b.jsonl'),
    options.sinceMs,
  )
  // Then
  expect(present).toBe(`${listed}.zst`)
  expect(gone).toBeUndefined()
})
