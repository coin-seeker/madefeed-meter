import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aggregate } from '../src/aggregate'
import { readOpenCode } from '../src/sources/opencode'
import { database, fixture, legacy, sinceMs } from './opencode-fixtures'
// SIZE_OK: the reader contract covers both SQLite schemas, fork boundaries and legacy precedence with full wire assertions.

it('carries recorded providers and parts through message, v2 and legacy readers', async () => {
  // Given
  const options = await fixture()
  const db = database(options.root)
  const tokens = {
    input: 10,
    output: 2,
    reasoning: 3,
    cache: { read: 4, write: 5 },
  }
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
    'db',
    's',
    sinceMs,
    sinceMs,
    JSON.stringify({ modelID: 'model', providerID: 'OpenAI', tokens }),
  )
  db.exec(
    'CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT)',
  )
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run(
    'v2',
    's',
    'assistant',
    1,
    sinceMs,
    JSON.stringify({
      model: { id: 'model', providerID: 'OpenRouter' },
      providerID: 'wrong',
      tokens,
    }),
  )
  db.close()
  const directory = join(options.root, 'storage/message/s')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'legacy.json'),
    JSON.stringify({
      modelID: 'model',
      providerID: 'Anthropic',
      time: { created: sinceMs },
      tokens,
    }),
  )
  await writeFile(
    join(directory, 'total.json'),
    JSON.stringify({
      modelID: 'total',
      time: { created: sinceMs },
      tokens: { total: 7 },
    }),
  )
  // When
  const result = await readOpenCode(options)
  // Then
  expect(aggregate(result.rows)).toEqual([
    ...['anthropic', 'openai', 'openrouter'].map((provider) => ({
      date: '2026-11-15',
      tool: 'opencode',
      model: 'model',
      provider,
      tokens: 24,
      input: 10,
      output: 5,
      cacheRead: 4,
      cacheWrite: 5,
      reasoning: 3,
    })),
    {
      date: '2026-11-15',
      tool: 'opencode',
      model: 'total',
      provider: 'unknown',
      tokens: 7,
    },
  ])
})

it.each([undefined, '', 'custom'])(
  'uses Windows roots only when OPENCODE_DATA_DIR is unset (%s)',
  async (custom) => {
    // Given
    const options = await fixture()
    const local = join(options.home, 'local')
    const roaming = join(options.home, 'roaming')
    await legacy(join(local, 'opencode'), 'same', 7)
    await legacy(join(roaming, 'opencode'), 'same', 999)
    await legacy(join(roaming, 'opencode'), 'distinct', 11)
    await legacy(options.root, 'default', 13)
    // When
    const result = await readOpenCode({
      ...options,
      env: {
        LOCALAPPDATA: local,
        APPDATA: roaming,
        ...(custom === undefined
          ? {}
          : { OPENCODE_DATA_DIR: custom === '' ? '' : options.root }),
      },
    })
    // Then
    expect(result.supported).toBe(true)
    expect(aggregate(result.rows).map((row) => row.tokens)).toEqual(
      custom === undefined ? [31] : custom === '' ? [] : [13],
    )
  },
)

it('reads the real session index and applies max, payload time, zero and KST rules', async () => {
  // Given
  const options = await fixture()
  const db = database(options.root)
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
  const cases = [
    {
      tokens: {
        total: 2,
        input: 10,
        output: 2,
        reasoning: 3,
        cache: { read: 4, write: 5 },
      },
      ms: sinceMs,
    },
    { tokens: { total: 40, input: 1 }, ms: sinceMs },
    { tokens: { input: 7, output: -1, reasoning: 'bad' }, ms: sinceMs },
    { tokens: { total: false, input: true }, ms: sinceMs },
    { tokens: { total: 0 }, ms: sinceMs },
    { tokens: { total: 999 }, ms: sinceMs - 1 },
    { tokens: { total: 9 }, ms: sinceMs + 86_400_000 },
  ]
  cases.forEach((value, index) =>
    insert.run(
      String(index),
      's',
      sinceMs,
      sinceMs,
      JSON.stringify({
        modelID: 'model',
        time: { created: value.ms },
        tokens: value.tokens,
      }),
    ),
  )
  insert.run(
    'missing-tokens',
    's',
    sinceMs,
    sinceMs,
    JSON.stringify({ modelID: 'model' }),
  )
  insert.run(
    'missing-model',
    's',
    sinceMs,
    sinceMs,
    JSON.stringify({ tokens: { total: 999 } }),
  )
  insert.run(
    'pushdown-slack',
    's',
    sinceMs - 1000,
    sinceMs,
    JSON.stringify({
      modelID: 'model',
      time: { created: sinceMs },
      tokens: { total: 3 },
    }),
  )
  db.close()
  // When
  const result = await readOpenCode(options)
  // Then
  expect(result.supported).toBe(true)
  expect(aggregate(result.rows)).toEqual([
    {
      date: '2026-11-15',
      tool: 'opencode',
      model: 'model',
      provider: 'unknown',
      tokens: 74,
      input: 18,
      output: 5,
      cacheRead: 4,
      cacheWrite: 5,
      reasoning: 3,
    },
    {
      date: '2026-11-16',
      tool: 'opencode',
      model: 'model',
      provider: 'unknown',
      tokens: 9,
    },
  ])
})

it('counts v2 assistants and completed compactions but excludes copied fork rows and duplicate ids', async () => {
  // Given
  const options = await fixture()
  const db = database(options.root)
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,fork_session_id TEXT,fork_boundary TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX session_message_time_created_idx ON session_message(time_created);`)
  const insert = db.prepare(
    'INSERT INTO session_message VALUES (?,?,?,?,?,?,?)',
  )
  const add = (
    id: string,
    session: string,
    seq: number,
    data: Record<string, unknown> = {},
  ) =>
    insert.run(
      id,
      session,
      typeof data['status'] === 'string' ? 'compaction' : 'assistant',
      seq,
      sinceMs,
      sinceMs,
      JSON.stringify({
        model: { id: 'model' },
        tokens: { total: 10 },
        ...data,
      }),
    )
  add('p1', 'parent', 10)
  add('p2', 'parent', 30, { model: { modelID: 'model' } })
  add('complete', 'parent', 40, {
    status: 'completed',
    model: undefined,
    modelID: 'model',
  })
  add('running', 'parent', 50, { status: 'running' })
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
    'p1',
    's',
    sinceMs,
    sinceMs,
    JSON.stringify({ modelID: 'model', tokens: { total: 3 } }),
  )
  const fork = db.prepare('INSERT INTO session_v2 VALUES (?,?,?)')
  fork.run(
    'through',
    'parent',
    JSON.stringify({ type: 'through', messageID: 'p2' }),
  )
  fork.run(
    'before',
    'parent',
    JSON.stringify({ type: 'before', messageID: 'p2' }),
  )
  fork.run(
    'unresolved',
    'parent',
    JSON.stringify({ type: 'through', messageID: 'absent' }),
  )
  add('t-copy1', 'through', 10)
  add('t-copy2', 'through', 30)
  add('t-new', 'through', 31)
  add('b-copy', 'before', 10)
  add('b-new', 'before', 11)
  add('u-new', 'unresolved', 1)
  db.close()
  await legacy(options.root, 'complete', 999)
  // When
  const result = await readOpenCode(options)
  // Then
  expect(result.supported).toBe(true)
  expect(aggregate(result.rows)).toEqual([
    {
      date: '2026-11-15',
      tool: 'opencode',
      model: 'model',
      provider: 'unknown',
      tokens: 53,
    },
  ])
})

it('lets database primary keys win over legacy JSON even outside the window', async () => {
  // Given
  const options = await fixture()
  const db = database(options.root)
  const insert = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
  insert.run(
    'same',
    's',
    sinceMs,
    sinceMs,
    JSON.stringify({ modelID: 'model', tokens: { total: 7 } }),
  )
  insert.run('old', 's', 0, 0, '{}')
  db.close()
  await legacy(options.root, 'same')
  await legacy(options.root, 'old')
  await legacy(options.root, 'only', 11)
  // When
  const result = await readOpenCode(options)
  // Then
  expect(aggregate(result.rows)[0]?.tokens).toBe(18)
})

it('reads JSON-only installs without requiring assistant role', async () => {
  // Given
  const options = await fixture()
  await legacy(options.root, 'only')
  // When
  const result = await readOpenCode(options)
  // Then
  expect(result.supported).toBe(true)
  expect(result.reason).toBeUndefined()
  expect(result.rows[0]?.tokens).toBe(50)
})

it('never returns partial JSON or earlier-root totals when a database is unreadable', async () => {
  // Given
  const options = await fixture()
  const bad = join(options.home, 'bad')
  await mkdir(bad)
  await legacy(options.root, 'valid')
  await legacy(bad, 'fallback')
  await writeFile(join(bad, 'opencode.db'), 'not sqlite')
  // When
  const result = await readOpenCode({
    ...options,
    env: { OPENCODE_DATA_DIR: `${options.root},${bad}` },
  })
  // Then
  expect(result).toEqual({
    supported: false,
    reason: expect.any(String),
    rows: [],
  })
})

it('honors comma roots, sorted database fallback and cross-root id dedupe', async () => {
  // Given
  const options = await fixture()
  const second = join(options.home, 'second')
  await mkdir(second)
  for (const root of [options.root, second]) {
    const db = database(root, 'opencode-a.db')
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
      'same',
      's',
      sinceMs,
      sinceMs,
      JSON.stringify({ modelID: 'model', tokens: { total: 7 } }),
    )
    db.close()
  }
  await writeFile(join(second, 'opencode-z.db'), 'must not open')
  // When
  const result = await readOpenCode({
    ...options,
    env: {
      OPENCODE_DATA_DIR: `${options.root},${second},${join(options.home, 'missing')}`,
    },
  })
  // Then
  expect(result.supported).toBe(true)
  expect(aggregate(result.rows)[0]?.tokens).toBe(7)
})

it('uses absolute XDG_DATA_HOME and ignores relative XDG paths', async () => {
  // Given
  const options = await fixture()
  const xdg = join(options.home, 'xdg')
  await legacy(join(xdg, 'opencode'), 'xdg', 17)
  await legacy(options.root, 'default', 19)
  // When
  const absolute = await readOpenCode({
    ...options,
    env: { XDG_DATA_HOME: xdg },
  })
  const relative = await readOpenCode({
    ...options,
    env: { XDG_DATA_HOME: 'relative' },
  })
  const empty = await readOpenCode({
    ...options,
    env: { OPENCODE_DATA_DIR: '', XDG_DATA_HOME: xdg },
  })
  // Then
  expect(absolute.rows[0]?.tokens).toBe(17)
  expect(relative.rows[0]?.tokens).toBe(19)
  expect(empty).toEqual({ supported: true, rows: [] })
})
