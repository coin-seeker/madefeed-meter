import { expect, it } from 'vitest'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readPi } from '../src/sources/pi'
import { readOmp } from '../src/sources/omp'
import { readOmo } from '../src/sources/omo'
import { event, fixture, session, textFile } from './pi-fixtures'

it('expands Pi agent and env custom dirs but scans custom dirs flat and main sessions at depth one', async () => {
  // Given
  const options = await fixture()
  for (const path of [
    'agent/sessions/p/main.jsonl',
    'flat/custom.jsonl',
    'flat/deep/skip.jsonl',
    'agent/sessions/p/deeper/skip.jsonl',
  ])
    await session(join(options.home, path), [event({ id: path })])
  await textFile(
    join(options.home, 'agent/settings.json'),
    '{"sessionDir":"~/ignored"}',
  )
  await session(join(options.home, 'ignored/a.jsonl'), [
    event({ id: 'ignored' }),
  ])
  // When
  const result = await readPi({
    ...options,
    env: {
      PI_CODING_AGENT_DIR: '~/agent',
      PI_CODING_AGENT_SESSION_DIR: '~/flat',
    },
  })
  // Then
  expect(result.rows).toHaveLength(2)
})

it.each(['~/flat', '~', 'relative'])(
  'uses BOM plain Pi settings and accepts only absolute expanded values (%s)',
  async (sessionDir) => {
    // Given
    const options = await fixture()
    await textFile(
      join(options.home, '.pi/agent/settings.json'),
      `\uFEFF${JSON.stringify({ sessionDir })}`,
    )
    await session(
      join(options.home, sessionDir === '~' ? 'a.jsonl' : 'flat/a.jsonl'),
      [event()],
    )
    // When
    const result = await readPi(options)
    // Then
    expect(result.rows).toHaveLength(sessionDir === 'relative' ? 0 : 1)
  },
)

it.each(['{broken', '{/*comment*/"sessionDir":"~/flat"}'])(
  'ignores unparsable plain Pi settings (%s)',
  async (settings) => {
    // Given
    const options = await fixture()
    await textFile(join(options.home, '.pi/agent/settings.json'), settings)
    await session(join(options.home, 'flat/a.jsonl'), [event()])
    // When
    const result = await readPi(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  },
)

it('discovers omp home/profiles/XDG roots, and only attached children at depths one and two', async () => {
  // Given
  const options = await fixture()
  const paths = [
    '.omp/agent/sessions/p/ts_id.jsonl',
    '.omp/agent/sessions/p/ts_id/child.jsonl',
    '.omp/agent/sessions/p/ts_id/sub/child.jsonl',
    '.omp/profiles/work/agent/sessions/p/profile.jsonl',
    'xdg/omp/sessions/p/xdg.jsonl',
    'xdg/omp/profiles/work/sessions/p/xdg-profile.jsonl',
  ]
  for (const path of [
    ...paths,
    '.omp/agent/sessions/p/orphan/skip.jsonl',
    '.omp/agent/sessions/p/ts_id/sub/deep/skip.jsonl',
    'pi/sessions/p/skip.jsonl',
    'flat/skip.jsonl',
  ])
    await session(join(options.home, path), [event({ id: path })])
  // When
  const result = await readOmp({
    ...options,
    env: {
      XDG_DATA_HOME: join(options.home, 'xdg'),
      PI_CODING_AGENT_DIR: join(options.home, 'pi'),
      PI_CODING_AGENT_SESSION_DIR: join(options.home, 'flat'),
    },
  })
  // Then
  expect(result.supported).toBe(true)
  expect(result.rows).toHaveLength(paths.length)
})

it('reads OmO JSONC, desktop and senpi children using absolute main header cwd only', async () => {
  // Given
  const options = await fixture()
  const cwd = join(options.home, 'project')
  await textFile(
    join(options.home, '.omo/agent/settings.jsonc'),
    '\uFEFF{ // line\n "url":"https://example.com/*keep*/", "quote":"\\\"//keep", /* block */ "sessionDir":"~/flat", "list":[1,], }',
  )
  await session(join(options.home, 'flat/a.jsonl'), [
    { type: 'session', cwd, id: 'main' },
    event({ id: 'custom' }),
  ])
  await session(
    join(options.home, '.omo/desktop/userdata/omo-sessions/desktop/a.jsonl'),
    [event({ id: 'desktop' })],
  )
  await session(
    join(
      cwd,
      '.omo/senpi-task/children/st_task/sessions/st_session/child.jsonl',
    ),
    [event({ id: 'child' })],
  )
  await session(
    join(cwd, '.omo/senpi-task/children/other/sessions/st_session/skip.jsonl'),
    [event({ id: 'skip' })],
  )
  // When
  const result = await readOmo(options)
  // Then
  expect(result.supported).toBe(true)
  expect(result.rows).toHaveLength(3)
})

it.each([
  '{"sessionDir":"~/flat",/* unterminated',
  '{invalid',
  '{"sessionDir":"~/flat"}/*/',
])(
  'does not fall back to settings.json when existing JSONC is invalid (%s)',
  async (settings) => {
    // Given
    const options = await fixture()
    await textFile(join(options.home, '.omo/agent/settings.jsonc'), settings)
    await textFile(
      join(options.home, '.omo/agent/settings.json'),
      '{"sessionDir":"~/flat"}',
    )
    await session(join(options.home, 'flat/a.jsonl'), [event()])
    // When
    const result = await readOmo(options)
    // Then
    expect(result).toEqual({ supported: true, rows: [] })
  },
)

it('parses OmO settings.json as JSONC when settings.jsonc is absent', async () => {
  // Given
  const options = await fixture()
  await textFile(
    join(options.home, '.omo/agent/settings.json'),
    '{/*ok*/"sessionDir":"~/flat",}',
  )
  await session(join(options.home, 'flat/a.jsonl'), [event()])
  // When
  const result = await readOmo(options)
  // Then
  expect(result.rows).toHaveLength(1)
})

it('trims OmO agent dir without expanding tilde and still follows desktop', async () => {
  // Given
  const options = await fixture()
  await session(join(options.home, 'agent/sessions/p/a.jsonl'), [
    event({ id: 'skip' }),
  ])
  await session(
    join(options.home, '.omo/desktop/userdata/omo-sessions/p/a.jsonl'),
    [event({ id: 'desktop' })],
  )
  // When
  const result = await readOmo({
    ...options,
    env: { OMO_CODING_AGENT_DIR: '  ~/agent  ' },
  })
  // Then
  expect(result.rows).toHaveLength(1)
})

it('uses trimmed absolute OmO agent env and expanded flat env over settings', async () => {
  // Given
  const options = await fixture()
  await session(join(options.home, 'agent/sessions/p/a.jsonl'), [
    event({ id: 'main' }),
  ])
  await textFile(
    join(options.home, 'agent/settings.jsonc'),
    '{"sessionDir":"~/ignored"}',
  )
  await session(join(options.home, 'flat/a.jsonl'), [event({ id: 'flat' })])
  // When
  const result = await readOmo({
    ...options,
    env: {
      OMO_CODING_AGENT_DIR: `  ${join(options.home, 'agent')}  `,
      OMO_CODING_AGENT_SESSION_DIR: '~/flat',
    },
  })
  // Then
  expect(result.rows).toHaveLength(2)
})

it.each([
  ['pi', readPi, 'Pi'],
  ['omp', readOmp, 'oh-my-pi'],
  ['omo', readOmo, 'OmO'],
] as const)(
  'discards the tool on an unexpected filesystem error (%s)',
  async (tool, read, label) => {
    // Given
    const options = await fixture()
    const agent = join(options.home, `.${tool}/agent`)
    await mkdir(agent, { recursive: true })
    await session(join(agent, 'sessions/a/valid.jsonl'), [event()])
    // An explicit root loop produces ELOOP even when directory entries skip symlinks.
    const root = join(options.home, `.${tool}/profiles`)
    if (tool === 'omp') await symlink(root, root)
    else {
      const custom = join(options.home, 'loop')
      await symlink(custom, custom)
      await textFile(
        join(agent, 'settings.json'),
        JSON.stringify({ sessionDir: custom }),
      )
    }
    // When
    const result = await read(options)
    // Then
    expect(result).toEqual({
      supported: false,
      rows: [],
      reason: `${label} 기록을 읽지 못해 이번에는 빼고 올려요.`,
    })
  },
)
