// SIZE_OK: ccusage adapter parity cases exercise real SQLite and protobuf through readAgy.
import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { readAgy } from '../src/sources/agy'
import {
  bfield,
  vfield,
  chatGeneration,
  database,
  fixture,
  generation,
  seconds,
  step,
  trajectory,
} from './agy-fixtures'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true })
})
async function setup() {
  const options = await fixture()
  homes.push(options.home)
  return options
}
it('C1 reads gen-only inclusive output and cache buckets', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    tables: ['gen_metadata'],
    generations: [
      chatGeneration({
        secs: seconds,
        call: {
          model: 312,
          input: 1000,
          output: 300,
          cacheWrite: 200,
          cacheRead: 5000,
          reasoning: 100,
          visible: 200,
          responseId: 'r',
        },
      }),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({
    supported: true,
    rows: [
      {
        date: '2026-11-15',
        tool: 'agy',
        model: 'gemini-2.5-flash',
        provider: 'google',
        tokens: 6500,
        input: 1000,
        output: 300,
        cacheRead: 5000,
        cacheWrite: 200,
        reasoning: 100,
      },
    ],
  })
})
it('C2 derives total output from visible plus reasoning when larger', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    steps: [
      step({
        secs: seconds,
        call: { input: 10, output: 0, reasoning: 30, visible: 7 },
      }),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]).toMatchObject({
    tokens: 47,
    output: 37,
    reasoning: 30,
  })
})
it('C3 merges a generation and step from different databases by response', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    generations: [
      chatGeneration({ secs: seconds, call: { input: 1000, responseId: 'r' } }),
    ],
  })
  database(options.root, 'b.db', {
    steps: [step({ secs: seconds, call: { input: 1500, responseId: 'r' } })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows.map((row) => row.input)).toEqual([1500])
})
it.each([false, true])(
  'C4 merges unkeyed generation linked to step 0 (packed=%s)',
  async (packed) => {
    // Given
    const options = await setup()
    const call = { input: 100, output: 50 }
    database(options.root, 'a.db', {
      generations: [
        chatGeneration({ secs: seconds, call, indices: [0], packed }),
      ],
      steps: [step({ secs: seconds, call })],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows.map((row) => row.tokens)).toEqual([150])
  },
)
it.each([false, true])(
  'C5 drops only one primary mirror and preserves distinct retries (%s)',
  async (distinct) => {
    // Given
    const options = await setup()
    const call = { input: 100, output: 50, visible: 50 }
    database(options.root, 'a.db', {
      generations: [
        chatGeneration({
          secs: seconds,
          call,
          retries: distinct ? [call, { ...call, responseId: 'other' }] : [call],
        }),
      ],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows.map((row) => row.tokens)).toEqual([distinct ? 300 : 150])
  },
)
it('C5 keeps an unkeyed failed attempt when retries mirror the linked primary', async () => {
  // Given
  const options = await setup()
  const call = { input: 100, output: 50, visible: 50 }
  database(options.root, 'a.db', {
    generations: [
      chatGeneration({
        secs: seconds + 1,
        text: 'gemini-3-pro',
        call,
        retries: [{ input: 100, output: 10, visible: 10 }, call],
        indices: [0],
      }),
    ],
    steps: [step({ secs: seconds, text: 'gemini-3-pro', call })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([260])
})
it('C6 dates untimed step usage by its linked timed generation', async () => {
  // Given
  const options = await setup()
  const call = { input: 10, cacheRead: 20, responseId: 'response' }
  database(options.root, 'a.db', {
    generations: [
      chatGeneration({
        secs: seconds,
        call: { ...call, input: 1, cacheRead: 0 },
        indices: [0],
      }),
    ],
    steps: [step({ call })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({
    date: '2026-11-15',
    tokens: 30,
    input: 10,
    cacheRead: 20,
  })
})
it.each([false, true])(
  'C7 uses trajectory timestamps but never file mtime (%s)',
  async (timed) => {
    // Given
    const options = await setup()
    database(options.root, 'a.db', {
      steps: [step({ call: { input: 1 } })],
      trajectories: timed ? [trajectory()] : [],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows.map((row) => [row.date, row.tokens])).toEqual(
      timed ? [['2026-11-15', 1]] : [],
    )
  },
)
it('C8 maps model id 1402 without inferring an anthropic provider', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    steps: [step({ secs: seconds, call: { model: 1402, input: 1 } })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]).toMatchObject({
    model: 'claude-opus-5-5',
    provider: 'unknown',
  })
})
it('C9 normalizes a display model and strips effort', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    generations: [
      chatGeneration({
        secs: seconds,
        text: 'Gemini 3.6 Flash (High)',
        call: { input: 1 },
      }),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]?.model).toBe('gemini-3.6-flash')
})
it.each([false, true])(
  'C10 resolves unknown ids with a db name-map fallback (%s)',
  async (named) => {
    // Given
    const options = await setup()
    database(options.root, 'a.db', {
      generations: named ? [generation(99, 'gemini-3.5-flash-high')] : [],
      steps: [step({ secs: seconds, call: { model: 1999, input: 1 } })],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows[0]?.model).toBe(named ? 'gemini-3.5-flash' : 'agy')
  },
)
it('C11 reads both gen-only and steps-only databases', async () => {
  // Given
  const options = await setup()
  const call = { input: 10 }
  database(options.root, 'a.db', {
    tables: ['steps'],
    steps: [step({ secs: seconds, call })],
  })
  database(options.root, 'b.db', {
    tables: ['gen_metadata'],
    generations: [chatGeneration({ secs: seconds, call })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.supported).toBe(true)
  expect(result.rows.map((row) => row.tokens)).toEqual([20])
})
it.each([Buffer.from([8, 128]), bfield(1, bfield(4, Buffer.from([0])))])(
  'C12 skips malformed roots and submessages, not valid siblings (%j)',
  async (bad) => {
    // Given
    const options = await setup()
    database(options.root, 'a.db', {
      generations: [bad, chatGeneration({ secs: seconds, call: { input: 5 } })],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.supported).toBe(true)
    expect(result.rows.map((row) => row.tokens)).toEqual([5])
  },
)
it.each([
  [1401, 'claude-opus-5-5-medium', 'claude-opus-5-5'],
  [1404, 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5'],
  [1427, 'gemini-4-carbon', 'gemini-4-carbon'],
  [1437, 'gemini-4-carbon', 'gemini-4-carbon'],
] as const)(
  'C13 prefers explicit names for unresolved matching id %s',
  async (model, text, expected) => {
    // Given
    const options = await setup()
    database(options.root, 'a.db', {
      generations: [
        chatGeneration({
          secs: seconds,
          model,
          text,
          call: { model, input: 60, output: 10, cacheRead: 40, visible: 10 },
        }),
      ],
    })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows[0]).toMatchObject({ model: expected, tokens: 110 })
  },
)
it('C13 preserves alias-mapped ids over explicit model names', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    generations: [
      chatGeneration({
        secs: seconds,
        text: 'gemini-3-flash-agent',
        call: { model: 1187, input: 60, output: 10, visible: 10 },
      }),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]).toMatchObject({
    model: 'gemini-3.5-flash',
    tokens: 70,
  })
})
it.each([
  [undefined, 'model_placeholder_m401', 'agy'],
  ['model_placeholder_m401', undefined, 'agy'],
  ['model_placeholder_m401', 'claude-opus-5-5-medium', 'claude-opus-5-5'],
  ['claude-opus-5-5-medium', 'model_placeholder_m401', 'claude-opus-5-5'],
  [undefined, undefined, 'agy'],
] as const)(
  'C13 merges resolved then placeholder then default (%s, %s)',
  async (first, second, expected) => {
    // Given
    const options = await setup()
    for (const [i, text] of [first, second].entries())
      database(options.root, `${i}.db`, {
        generations: [
          chatGeneration({
            secs: seconds,
            ...(text === undefined ? {} : { text }),
            call: { input: 1, responseId: 'same' },
          }),
        ],
      })
    // When
    const result = await readAgy(options)
    // Then
    expect(result.rows.map((row) => [row.model, row.tokens])).toEqual([
      [expected, 1],
    ])
  },
)
it('uses the db id map before static aliases', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    generations: [generation(1187, 'custom-high')],
    steps: [step({ secs: seconds, call: { model: 1187, input: 1 } })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]?.model).toBe('custom')
})
it('unions bridging identities and takes maxima before filtering dates', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    steps: [
      step({ secs: seconds, call: { input: 10, responseId: 'r' } }),
      step({ secs: seconds, call: { output: 20, messageId: 'm' } }),
      step({
        secs: seconds - 1,
        call: { input: 5, responseId: 'r', messageId: 'm' },
      }),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result).toEqual({ supported: true, rows: [] })
})
it('stops packed indices at the first malformed varint without dropping the row', async () => {
  // Given
  const options = await setup()
  const call = { input: 10 }
  database(options.root, 'a.db', {
    generations: [
      Buffer.concat([
        chatGeneration({ secs: seconds, call }),
        bfield(2, Buffer.from([0, 128])),
      ]),
    ],
    steps: [step({ secs: seconds, call })],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows.map((row) => row.tokens)).toEqual([10])
})
it('treats oversized varints as absent and clamps timestamp nanos', async () => {
  // Given
  const options = await setup()
  database(options.root, 'a.db', {
    generations: [
      bfield(
        1,
        Buffer.concat([
          bfield(4, Buffer.concat([vfield(2, 1n << 63n), vfield(3, 5)])),
          bfield(
            9,
            bfield(
              4,
              Buffer.concat([vfield(1, seconds), vfield(2, 2_000_000_000)]),
            ),
          ),
        ]),
      ),
    ],
  })
  // When
  const result = await readAgy(options)
  // Then
  expect(result.rows[0]).toMatchObject({
    date: '2026-11-15',
    tokens: 5,
    input: 0,
  })
})
