// SIZE_OK: H1–H21 source contracts share real SQLite fixtures and are kept together for the approved T2 acceptance command.
import { afterEach, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ROW_TOKENS } from '../src/aggregate'
import { readHermes } from '../src/sources/hermes'
import {
  call,
  database,
  day,
  logs,
  sinceMs,
  timestamp,
} from './hermes-fixtures'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'madefeed-hermes-'))
  homes.push(home)
  return { home, root: join(home, '.hermes'), sinceMs, env: {} }
}
const expected = (date = '2026-11-02') => ({
  date,
  tool: 'hermes',
  model: 'gpt-6',
  provider: 'openai',
  tokens: 1160,
  input: 100,
  output: 50,
  cacheRead: 1000,
  cacheWrite: 10,
  reasoning: 20,
})
const failure = {
  supported: false,
  rows: [],
  reason: 'Hermes 기록을 읽지 못해 이번에는 빼고 올려요.',
}
async function multi(root: string) {
  await database(root, {
    usage: [{ first: day(2), last: day(4), counts: [500, 200, 3000, 0, 20] }],
  })
}
const calls = () => [
  call(day(3)),
  call(day(4), { input: 2100, output: 70, cache: 2000, number: 2 }),
]
const older = () => `${timestamp(day(1))} INFO startup: private prompt`

it('H1 returns a supported empty source when Hermes is absent', async () => {
  // Given
  const f = await fixture()
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('H2 counts four buckets without adding reasoning when the key is single-day', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { usage: [{}] })
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual({ supported: true, rows: [expected()] })
})
it('H3 sums tasks and uses minimum first and maximum last when keys coincide', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [
      {
        task: 'a',
        first: day(2),
        last: day(2),
        counts: [200, 80, 1000, 0, 10],
      },
      {
        task: 'b',
        first: day(3),
        last: day(4),
        counts: [300, 120, 2000, 0, 10],
      },
    ],
  })
  await logs(f.root, [older(), ...calls()])
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows.map((r) => [r.date, r.tokens])).toEqual([
    ['2026-11-02', 250],
    ['2026-11-03', 1280],
    ['2026-11-04', 2170],
  ])
})
it('H4 falls back to session start when usage timestamps are NULL', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    sessions: [{}],
    usage: [{ first: null, last: null }],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([expected()])
})
it('H5 dates logged calls and covered remainder without reasoning when spanning days', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, [older(), ...calls()])
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([
    {
      date: '2026-11-02',
      tool: 'hermes',
      model: 'gpt-6',
      provider: 'openai',
      tokens: 250,
      input: 200,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    },
    {
      date: '2026-11-03',
      tool: 'hermes',
      model: 'gpt-6',
      provider: 'openai',
      tokens: 1280,
      input: 200,
      output: 80,
      cacheRead: 1000,
      cacheWrite: 0,
    },
    {
      date: '2026-11-04',
      tool: 'hermes',
      model: 'gpt-6',
      provider: 'openai',
      tokens: 2170,
      input: 100,
      output: 70,
      cacheRead: 2000,
      cacheWrite: 0,
    },
  ])
})
it('H6 drops unknown-day remainder when rotation no longer covers first', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, calls())
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows.map((r) => [r.date, r.tokens])).toEqual([
    ['2026-11-03', 1280],
    ['2026-11-04', 2170],
  ])
})
it('H7 retains the full key at first when no call-log file exists', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([
    {
      ...expected(),
      tokens: 3700,
      input: 500,
      output: 200,
      cacheRead: 3000,
      cacheWrite: 0,
    },
  ])
})
it.each([true, false])(
  'H8 abandons excessive logged buckets with coverage=%s',
  async (coverage) => {
    // Given
    const f = await fixture()
    await multi(f.root)
    await logs(f.root, [
      ...(coverage ? [older()] : []),
      call(day(3), { input: 5000, cache: 4000 }),
    ])
    // When
    const result = await readHermes(f)
    // Then
    expect(result.rows).toEqual(
      coverage
        ? [
            {
              ...expected(),
              tokens: 3700,
              input: 500,
              output: 200,
              cacheRead: 3000,
              cacheWrite: 0,
            },
          ]
        : [],
    )
  },
)
it('H9 deduplicates calls when the same line occurs in rotated files', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, calls())
  await logs(f.root, calls(), 'agent.log.1')
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows.map((r) => r.tokens)).toEqual([1280, 2170])
})
it('H10 ignores unavailable calls when a multi-day key is read', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, [
    call(day(3)).replace(/in=\d+ out=\d+ total=\d+/, 'in=? out=? total=?') +
      ' usage=unavailable',
  ])
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('H11 subtracts every usage bucket when reconciling session residuals', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    sessions: [{ start: day(3), counts: [110, 70, 1030, 50, 25] }],
    usage: [{}],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([
    expected(),
    {
      ...expected('2026-11-03'),
      tokens: 100,
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      reasoning: 5,
    },
  ])
})
it('H12 uses session totals when the usage table is absent', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { sessions: [{}], legacy: true })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([expected()])
})
it('H13 skips blank models and zero counts when scanning keys', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    sessions: [
      { id: 'null', model: null },
      { id: 'blank', model: '  ' },
      { id: 'zero', counts: [0, 0, 0, 0, 20] },
    ],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([])
})
it('H14 keeps first sorted database when session IDs repeat across profiles', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { usage: [{}] })
  await database(join(f.root, 'profiles/p'), {
    usage: [{ counts: [1, 2, 3, 4, 1] }],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([
    {
      ...expected(),
      tokens: 10,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 1,
    },
  ])
})
it('H15 reads explicit homes only when HERMES_HOME is defined', async () => {
  // Given
  const f = await fixture()
  const a = join(f.home, 'a'),
    b = join(f.home, 'b')
  await database(f.root, { sessions: [{ id: 'ignored' }] })
  await database(a, { usage: [{ id: 'a' }] })
  await database(b, { usage: [{ id: 'b' }] })
  // When
  const result = await readHermes({ ...f, env: { HERMES_HOME: `${a},,${b}` } })
  // Then
  expect(result.rows).toEqual([
    {
      ...expected(),
      tokens: 2320,
      input: 200,
      output: 100,
      cacheRead: 2000,
      cacheWrite: 20,
      reasoning: 40,
    },
  ])
})
it('H15 returns empty when HERMES_HOME is explicitly empty', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { sessions: [{}] })
  // When
  const result = await readHermes({ ...f, env: { HERMES_HOME: '' } })
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('H15 reads LOCALAPPDATA/hermes when explicit homes are absent', async () => {
  // Given
  const f = await fixture()
  await database(join(f.home, 'local/hermes'), { usage: [{}] })
  // When
  const result = await readHermes({
    ...f,
    env: { LOCALAPPDATA: join(f.home, 'local') },
  })
  // Then
  expect(result.rows).toEqual([expected()])
})
it('H16 skips stale invalid databases when both database and WAL are old', async () => {
  // Given
  const f = await fixture()
  await mkdir(f.root, { recursive: true })
  const path = join(f.root, 'state.db')
  await writeFile(path, 'garbage')
  await writeFile(`${path}-wal`, 'garbage')
  await utimes(path, 0, 0)
  await utimes(`${path}-wal`, 0, 0)
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it.each(['garbage', 'missing sessions'])(
  'H17 fails atomically when a kept DB is %s',
  async (kind) => {
    // Given
    const f = await fixture()
    await database(join(f.root, 'profiles/p'), { usage: [{}] })
    if (kind === 'garbage')
      await writeFile(join(f.root, 'state.db'), 'garbage private-session')
    else await database(f.root, { missingSessions: true })
    // When
    const result = await readHermes(f)
    // Then
    expect(result).toEqual(failure)
    expect(JSON.stringify(result)).not.toContain(f.home)
  },
)
it('H18 fails when a grouped row exceeds MAX_ROW_TOKENS', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [
      { id: 'a', counts: [MAX_ROW_TOKENS, 0, 0, 0, 0] },
      { id: 'b', counts: [1, 0, 0, 0, 0] },
    ],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual(failure)
})
it('H19 normalizes recorded providers when returning rows', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [
      { id: 'a', provider: 'OpenAI-Codex' },
      { id: 'b', provider: '' },
    ],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows.map((r) => r.provider)).toEqual([
    'openai-codex',
    'unknown',
  ])
})
it('H20 omits session ids, private log content and home paths from the result', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, [older(), ...calls()])
  // When
  const result = await readHermes(f)
  // Then
  const json = JSON.stringify(result)
  expect(json).not.toContain('private-session')
  expect(json).not.toContain('private prompt')
  expect(json).not.toContain(f.home)
})
it('H21 subtracts pre-window calls before dropping their allocations', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, [older(), ...calls()])
  // When
  const result = await readHermes({ ...f, sinceMs: day(4) })
  // Then
  expect(result.rows.map((r) => [r.date, r.tokens])).toEqual([
    ['2026-11-04', 2170],
  ])
})
it('omits zero residuals when session totals equal usage totals', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { sessions: [{}], usage: [{}] })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([expected()])
})
it('preserves unsplit reasoning when split and unsplit allocations share a group', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [
      { first: day(2), last: day(4), counts: [500, 200, 3000, 0, 20] },
      { id: 'single', first: day(3), last: day(3) },
    ],
  })
  await logs(f.root, [older(), ...calls()])
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows.find((r) => r.date === '2026-11-03')).toEqual({
    ...expected('2026-11-03'),
    tokens: 2440,
    input: 300,
    output: 130,
    cacheRead: 2000,
  })
})
it('drops remainder when log files contain no parseable timestamp', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, ['unparseable'])
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([])
})
it('fails atomically on log IO errors rather than treating them as absent logs', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await writeFile(join(f.root, 'logs'), 'not a directory')
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual(failure)
})
it('does not read logs for single-day keys even when logs are unreadable', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { usage: [{}] })
  await writeFile(join(f.root, 'logs'), 'not a directory')
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([expected()])
})
it('deduplicates realpaths and never scans state-snapshots', async () => {
  // Given
  const f = await fixture()
  await database(f.root, { usage: [{}] })
  await mkdir(join(f.root, 'profiles/p'), { recursive: true })
  await symlink(join(f.root, 'state.db'), join(f.root, 'profiles/p/state.db'))
  await database(join(f.root, 'state-snapshots'), {
    sessions: [{ id: 'snapshot' }],
  })
  // When
  const result = await readHermes({
    ...f,
    env: { HERMES_HOME: `${f.root},${f.root}` },
  })
  // Then
  expect(result.rows).toEqual([expected()])
})
it('suppresses later usage-only session IDs even when earlier keys are skipped', async () => {
  // Given
  const f = await fixture()
  await database(join(f.root, 'profiles/p'), {
    usage: [{ counts: [0, 0, 0, 0, 0] }],
    sessions: [{ id: 'session-only', counts: [0, 0, 0, 0, 0] }],
  })
  await database(f.root, { usage: [{}, { id: 'session-only' }] })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([])
})
it('uses exact raw model/provider matching rather than normalized names for logs', async () => {
  // Given
  const f = await fixture()
  await multi(f.root)
  await logs(f.root, [
    call(day(3), { provider: 'OpenAI' }),
    call(day(4), { model: 'other' }),
  ])
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([])
})
it('normalizes negative, fractional and nonfinite buckets before allocation', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [{ counts: [-20, 5.9, Infinity, 2.3, 1.8] }],
  })
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([
    {
      ...expected(),
      tokens: 7,
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheWrite: 2,
      reasoning: 1,
    },
  ])
})
it('H21 reduces an in-window remainder even when a matching call predates the window', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [{ first: day(3), last: day(4), counts: [500, 200, 3000, 0, 20] }],
  })
  await logs(f.root, [
    older(),
    call(day(2)),
    call(day(4), { input: 2100, output: 70, cache: 2000, number: 2 }),
  ])
  // When
  const result = await readHermes({ ...f, sinceMs: day(3) })
  // Then
  expect(result.rows.map((r) => [r.date, r.tokens])).toEqual([
    ['2026-11-03', 250],
    ['2026-11-04', 2170],
  ])
})
it('keeps KST-day totals together when UTC dates differ', async () => {
  // Given
  const f = await fixture()
  await database(f.root, {
    usage: [
      {
        first: Date.parse('2026-11-02T00:00:00+09:00'),
        last: Date.parse('2026-11-02T23:59:59+09:00'),
      },
    ],
  })
  await writeFile(join(f.root, 'logs'), 'must not read this')
  // When
  const result = await readHermes(f)
  // Then
  expect(result.rows).toEqual([expected()])
})
it('does not prefilter a stale database when its WAL is recent', async () => {
  // Given
  const f = await fixture()
  await mkdir(f.root, { recursive: true })
  const path = join(f.root, 'state.db')
  await writeFile(path, 'garbage')
  await utimes(path, 0, 0)
  await writeFile(`${path}-wal`, 'recent')
  // When
  const result = await readHermes(f)
  // Then
  expect(result).toEqual(failure)
})
