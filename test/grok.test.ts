import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGrok } from '../src/sources/grok'
import { windowStart } from '../src/kst'

// SIZE_OK: the approved contract requires all 18 independent fixture-heavy behaviours in this file.
let home: string
const ms = Date.parse('2026-11-16T00:00:00Z')
const usage = { inputTokens: 10, outputTokens: 5 }
const row = {
  date: '2026-11-16',
  tool: 'grok',
  model: 'unknown',
  provider: 'unknown',
  tokens: 15,
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'madefeed-grok-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
function turn(
  update: Record<string, unknown> = {},
  meta: Record<string, unknown> = { agentTimestampMs: ms },
) {
  return {
    params: {
      _meta: meta,
      update: { sessionUpdate: 'turn_completed', usage, ...update },
    },
  }
}
async function session(
  events: readonly unknown[],
  options: { name?: string; summary?: unknown; root?: string } = {},
) {
  const dir = join(
    options.root ?? join(home, '.grok'),
    'sessions',
    'nested',
    options.name ?? 'main',
  )
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'updates.jsonl')
  await writeFile(
    path,
    events
      .map((event) =>
        typeof event === 'string' ? event : JSON.stringify(event),
      )
      .join('\n'),
  )
  if (options.summary !== undefined)
    await writeFile(
      join(dir, 'summary.json'),
      typeof options.summary === 'string'
        ? options.summary
        : JSON.stringify(options.summary),
    )
  return path
}
const read = (sinceMs = 0) => readGrok({ home, sinceMs, env: {} })

it('splits modelUsage into two rows with per-model parts', async () => {
  // Given
  await session([
    turn({
      usage: {
        ...usage,
        modelUsage: {
          'grok-a': {
            inputTokens: 20,
            outputTokens: 7,
            cachedReadTokens: 3,
            cacheCreationTokens: 2,
            reasoningTokens: 4,
          },
          'grok-b': usage,
        },
      },
    }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    {
      ...row,
      model: 'grok-a',
      provider: 'xai',
      tokens: 27,
      input: 15,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 4,
    },
    { ...row, model: 'grok-b', provider: 'xai' },
  ])
})
it('falls back to summary model for empty or absent modelUsage, but not invalid entries', async () => {
  // Given
  await session(
    [
      turn(),
      turn({ usage: { ...usage, modelUsage: {} }, prompt_id: 'empty' }),
      turn({ usage: { ...usage, modelUsage: { invalid: null } } }),
    ],
    { summary: { current_model_id: 'grok-summary' } },
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual(
    Array.from({ length: 2 }, () => ({
      ...row,
      model: 'grok-summary',
      provider: 'xai',
    })),
  )
})
it('uses unknown without a summary or with an invalid model string', async () => {
  // Given
  await session([turn()], { name: 'a' })
  await session([turn()], {
    name: 'b',
    summary: { current_model_id: 'invalid model' },
  })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([row, row])
})
it('floors and clamps parts, rejects unsafe or nonnumeric amounts and skips zero totals', async () => {
  // Given
  await session([
    turn({
      prompt_id: 'read',
      usage: {
        inputTokens: 10.9,
        outputTokens: 2.9,
        cachedReadTokens: 99,
        cacheCreationTokens: 99,
        reasoningTokens: 1.9,
        totalTokens: 999,
      },
    }),
    turn({
      prompt_id: 'write',
      usage: {
        inputTokens: 10,
        outputTokens: -1,
        cachedReadTokens: 3.9,
        cacheCreationTokens: 99,
        reasoningTokens: '5',
      },
    }),
    turn({ usage: { inputTokens: -5, outputTokens: '5', totalTokens: 99 } }),
    turn({
      usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: null },
    }),
    turn({
      prompt_id: 'invalid',
      usage: {
        inputTokens: '5',
        outputTokens: 2,
        cachedReadTokens: -1,
        cacheCreationTokens: true,
      },
    }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    { ...row, tokens: 12, input: 0, output: 2, cacheRead: 10, reasoning: 1 },
    { ...row, tokens: 10, input: 0, output: 0, cacheRead: 3, cacheWrite: 7 },
    { ...row, tokens: 2, input: 0, output: 2 },
  ])
})
it('prefers agent milliseconds and converts fallback timestamp seconds', async () => {
  // Given
  await session([
    { ...turn(), timestamp: ms / 1000 - 86400 },
    {
      ...turn({ prompt_id: 'seconds' }, { agentTimestampMs: -1 }),
      timestamp: ms / 1000 + 86400,
    },
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows.map((entry) => entry.date)).toEqual([
    '2026-11-16',
    '2026-11-17',
  ])
})
it('skips missing timestamps even with a fresh mtime', async () => {
  // Given
  await session([turn({}, {}), { ...turn({}, {}), timestamp: 0 }])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([])
})
it('includes only the KST window boundary and later events', async () => {
  // Given
  const boundary = Date.parse('2026-11-15T15:00:00Z')
  await session([
    turn({ prompt_id: 'before' }, { agentTimestampMs: boundary - 1 }),
    turn({}, { agentTimestampMs: boundary }),
  ])
  // When
  const result = await read(windowStart(Date.parse('2026-11-16T09:00:00Z'), 1))
  // Then
  expect(result.rows).toEqual([row])
})
it('deduplicates prompt forks before filtering and keeps the earlier date across files', async () => {
  // Given: later copies sort first; a pre-window original must suppress its fork.
  await session(
    [turn({ prompt_id: 'visible' }), turn({ prompt_id: 'outside' })],
    { name: 'a-fork' },
  )
  await session(
    [
      turn({ prompt_id: 'visible' }, { agentTimestampMs: ms - 86400000 }),
      turn({ prompt_id: 'outside' }, { agentTimestampMs: ms - 172800000 }),
    ],
    { name: 'z-original' },
  )
  // When
  const result = await read(ms - 86400000)
  // Then
  expect(result.rows).toEqual([{ ...row, date: '2026-11-15' }])
})
it('deduplicates eventId without prompt_id while preserving different models and fallback tuples', async () => {
  // Given
  const event = turn({}, { agentTimestampMs: ms, eventId: 'shared' })
  await session([event, turn(), turn()], { name: 'a' })
  await session(
    [
      event,
      turn(
        { usage: { modelUsage: { 'grok-other': usage } } },
        { agentTimestampMs: ms, eventId: 'shared' },
      ),
    ],
    { name: 'b' },
  )
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([
    row,
    row,
    { ...row, model: 'grok-other', provider: 'xai' },
  ])
})
it('skips subagent kinds and treats malformed summaries as normal sessions', async () => {
  // Given
  await session([turn()], { name: 'a', summary: { session_kind: 'subagent' } })
  await session([turn()], {
    name: 'b',
    summary: { session_kind: 'subagent_task' },
  })
  await session([turn()], { name: 'c', summary: '{broken' })
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([row])
})
it('trims GROK_HOME overrides and falls back to home for blank overrides', async () => {
  // Given
  const root = join(home, 'override')
  await session([turn()], {
    root,
    summary: { current_model_id: 'grok-override' },
  })
  await session([turn()])
  // When
  const override = await readGrok({
    home,
    sinceMs: 0,
    env: { GROK_HOME: ` ${root} ` },
  })
  const blank = await readGrok({ home, sinceMs: 0, env: { GROK_HOME: '   ' } })
  // Then
  expect(override.rows).toEqual([
    { ...row, model: 'grok-override', provider: 'xai' },
  ])
  expect(blank.rows).toEqual([row])
})
it('returns a supported empty result without a reason for a missing root', async () => {
  // Given / When
  const result = await read()
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('skips malformed lines, non-object usage and other session updates', async () => {
  // Given
  await session([
    '{"turn_completed":',
    turn({ usage: [] }),
    turn({ usage: null }),
    turn({ usage: 'bad' }),
    turn({ sessionUpdate: 'message' }),
    turn(),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([row])
})
it('projects only usage fields and never includes message text or paths', async () => {
  // Given
  await session([
    {
      params: {
        update: {
          sessionUpdate: 'message',
          text: 'SECRET-PROMPT /Users/x/secret-repo',
        },
      },
    },
    turn({ text: 'SECRET-PROMPT /Users/x/secret-repo' }),
  ])
  // When
  const result = await read()
  // Then
  expect(result.rows).toEqual([row])
  expect(JSON.stringify(result.rows)).not.toMatch(
    /SECRET-PROMPT|\/Users\/x\/secret-repo/,
  )
  expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(
    Object.keys(row).sort(),
  )
})
it('prefilters updates files with mtime before sinceMs', async () => {
  // Given
  const path = await session([turn()])
  await utimes(path, new Date(ms - 1000), new Date(ms - 1000))
  // When
  const result = await read(ms)
  // Then
  expect(result.rows).toEqual([])
})
it('infers xai only for grok-prefixed models', async () => {
  // Given
  await session([
    turn({ usage: { modelUsage: { 'grok-test': usage, other: usage } } }),
  ])
  // When
  const result = await read()
  // Then
  expect(
    result.rows.map(({ model, provider }) => ({ model, provider })),
  ).toEqual([
    { model: 'grok-test', provider: 'xai' },
    { model: 'other', provider: 'unknown' },
  ])
})
it('leaves Grok out when a day and model total passes the row limit', async () => {
  // Given
  await session([
    turn({ prompt_id: 'a', usage: { inputTokens: 60_000_000_000 } }),
    turn({ prompt_id: 'b', usage: { inputTokens: 60_000_000_000 } }),
  ])
  // When
  const result = await read()
  // Then
  expect(result).toEqual({
    supported: false,
    rows: [],
    reason: 'Grok Build 기록을 읽지 못해 이번에는 빼고 올려요.',
  })
})
it('discards partial rows with the fixed reason when an updates file is unreadable', async () => {
  // Given
  await session([turn()], { name: 'a-readable' })
  const path = await session([turn()], { name: 'z-unreadable' })
  await chmod(path, 0o000)
  try {
    // When
    const result = await read()
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: 'Grok Build 기록을 읽지 못해 이번에는 빼고 올려요.',
    })
  } finally {
    await chmod(path, 0o600)
  }
})
