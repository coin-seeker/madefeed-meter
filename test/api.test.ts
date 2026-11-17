import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requestDevice, pollToken, uploadUsage } from '../src/api'
import { payload } from '../src/aggregate'

const cleanup: (() => Promise<void>)[] = []
it('sends exactly one heartbeat request when rows are empty', async () => {
  // Given
  const bodies: unknown[] = []
  const api = {
    url: 'https://example.com',
    fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ accepted: 0, weekTokens: 12, votesGranted: 0 })
    },
  }
  // When
  const result = await uploadUsage(api, 'mfd_test', payload('test-device', []))
  // Then
  expect(bodies).toEqual([{ deviceName: 'test-device', rows: [] }])
  expect(result).toEqual({
    accepted: 0,
    ignored: 0,
    backfill: null,
    weekTokens: 12,
    votesGranted: 0,
  })
})
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function stub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new TypeError('stub address')
  return `http://127.0.0.1:${address.port}`
}
it('polls the device flow pending → approved at the supplied interval', async () => {
  // Given
  let polls = 0
  const waits: number[] = []
  const url = await stub((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/meter/device')
      res.end(
        JSON.stringify({
          device_code: 'test-code',
          user_code: 'ABCD',
          verification_uri: 'https://example.com/verify',
          expires_in: 600,
          interval: 3,
        }),
      )
    else {
      polls++
      res.statusCode = polls === 1 ? 400 : 200
      res.end(
        JSON.stringify(
          polls === 1
            ? { error: { code: 'authorization_pending' } }
            : { token: 'mfd_test' },
        ),
      )
    }
  })
  const api = {
    url,
    fetch,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
  }
  const device = await requestDevice(api, {
    deviceName: 'test-device',
    machineId: 'a'.repeat(64),
  })
  // When
  const token = await pollToken(api, device)
  // Then
  expect(token).toBe('mfd_test')
  expect(waits).toEqual([3000, 3000])
})
it('stops login polling on expired_token', async () => {
  // Given
  let calls = 0
  const url = await stub((_req, res) => {
    calls++
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'expired_token' }))
  })
  // When / Then
  await expect(
    pollToken(
      { url, fetch, sleep: async () => {} },
      {
        device_code: 'x',
        user_code: 'x',
        verification_uri: 'https://example.com',
        expires_in: 600,
        interval: 1,
      },
    ),
  ).rejects.toThrow('만료')
  expect(calls).toBe(1)
})
it('chunks uploads to 200 rows and projects only private-safe fields', async () => {
  // Given
  const bodies: unknown[] = []
  const url = await stub((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      bodies.push(JSON.parse(body))
      res.end(
        JSON.stringify({
          accepted: JSON.parse(body).rows.length,
          weekTokens: 1,
          votesGranted: 0,
        }),
      )
    })
  })
  const rows = Array.from({ length: 401 }, (_, i) => ({
    date: '2026-11-16',
    tool: 'codex' as const,
    model: `model-${i}`,
    tokens: 1,
    prompt: 'SECRET-PROMPT',
    path: '/Users/x/secret-repo',
  }))
  // When
  await uploadUsage({ url, fetch }, 'mfd_test', {
    ...payload('test-device', rows),
    machineId: 'b'.repeat(64),
  })
  // Then
  expect(
    bodies.map((body) => JSON.stringify(body).match(/"date"/g)?.length),
  ).toEqual([200, 200, 1])
  expect(JSON.stringify(bodies)).not.toMatch(
    /SECRET-PROMPT|secret-repo|prompt|path/,
  )
  expect(bodies).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({ machineId: 'b'.repeat(64) }),
    ),
  )
})
it.each([401, 422])('reports HTTP %i without retrying', async (status) => {
  // Given
  let calls = 0
  const url = await stub((_req, res) => {
    calls++
    res.statusCode = status
    res.end('{}')
  })
  // When / Then
  await expect(
    uploadUsage(
      { url, fetch },
      'mfd_test',
      payload('test-device', [
        { date: '2026-11-16', tool: 'codex', model: 'gpt', tokens: 1 },
      ]),
    ),
  ).rejects.toThrow(String(status))
  expect(calls).toBe(1)
})

it.each([
  { statuses: ['closed', 'applied', null], expected: 'applied' },
  { statuses: ['applied', 'closed', null], expected: 'applied' },
  { statuses: [null, 'closed', null], expected: 'closed' },
  { statuses: [null, null, null], expected: null },
])(
  'aggregates all backfill chunks with $statuses',
  async ({ statuses, expected }) => {
    // Given
    const bodies: unknown[] = []
    const api = {
      url: 'https://example.com',
      fetch: async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const index = bodies.length
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({
          accepted: index + 1,
          ignored: index + 2,
          backfill: statuses[index],
          weekTokens: index * 10,
          votesGranted: index,
          bankVotes: index + 5,
        })
      },
    }
    const rows = Array.from({ length: 401 }, (_, index) => ({
      date: '2026-11-16',
      tool: 'codex' as const,
      model: `model-${index}`,
      tokens: 1,
    }))
    // When
    const result = await uploadUsage(api, 'mfd_test', {
      ...payload('device', rows),
      backfill: true,
    })
    // Then
    expect(bodies).toEqual(
      [0, 200, 400].map(() => ({
        deviceName: 'device',
        rows: expect.any(Array),
        backfill: true,
      })),
    )
    expect(
      bodies.map((body) => JSON.stringify(body).match(/"date"/g)?.length),
    ).toEqual([200, 200, 1])
    expect(result).toEqual({
      accepted: 6,
      ignored: 9,
      backfill: expected,
      votesGranted: 3,
      weekTokens: 20,
      bankVotes: 7,
    })
  },
)
