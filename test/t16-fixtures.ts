import { join } from 'node:path'
import { ampMessage, writeAmp } from './ccusage-fixtures/amp'
import { droidSettings, writeDroid } from './ccusage-fixtures/droid'
import { codebuffMessage, writeCodebuff } from './ccusage-fixtures/codebuff'
import { fixture } from './t8-fixture'
import {
  database,
  gooseSchema,
  kiloSchema,
  kiloMessage,
  zcodeSchema,
} from './t9-sqlite-fixtures'
import {
  clawMessage,
  dshHeader,
  dshRoute,
  dshUsage,
  receipt,
} from './t10-fixtures'

export async function allToolsFixture() {
  const f = await fixture()
  try {
    const now = Date.now()
    const timestamp = new Date(now).toISOString()
    await writeAmp(f.home, {
      id: 'amp',
      messages: [{ ...ampMessage, timestamp }],
    })
    await writeDroid(f.home, {
      ...droidSettings,
      providerLockTimestamp: timestamp,
    })
    await writeCodebuff(f.home, [{ ...codebuffMessage, timestamp }])
    await f.put('.cline/tasks/session/ui_messages.json', [
      {
        ts: now,
        type: 'say',
        say: 'api_req_started',
        modelInfo: { modelId: 'claude-sonnet-4', providerId: 'anthropic' },
        text: JSON.stringify({
          tokensIn: 100,
          tokensOut: 20,
          cacheReads: 5,
          cacheWrites: 10,
        }),
      },
    ])
    await f.lines('.kimi/sessions/project/session/wire.jsonl', [
      {
        type: 'usage.record',
        time: now,
        usageScope: 'turn',
        model: 'kimi-code/kimi-for-coding',
        usage: {
          inputOther: 100,
          output: 50,
          inputCacheRead: 10,
          inputCacheCreation: 20,
        },
      },
    ])
    await f.lines('.qwen/projects/project/chats/session.jsonl', [
      {
        type: 'assistant',
        timestamp,
        sessionId: 'qwen',
        model: 'qwen3-coder-plus',
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 50,
          cachedContentTokenCount: 400,
          totalTokenCount: 1250,
        },
      },
    ])
    const goose = database(
      join(f.home, '.local/share/goose/sessions/sessions.db'),
      gooseSchema,
    )
    try {
      goose
        .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          'goose',
          JSON.stringify({ model_name: 'glm-5' }),
          'zai',
          timestamp,
          180,
          100,
          80,
          0,
          0,
          0,
        )
    } finally {
      goose.close()
    }
    const kilo = database(join(f.home, '.local/share/kilo/kilo.db'), kiloSchema)
    try {
      kilo
        .prepare('INSERT INTO message VALUES (?, ?, ?)')
        .run(
          'kilo',
          'session',
          JSON.stringify({ ...kiloMessage, time: { created: now } }),
        )
    } finally {
      kilo.close()
    }
    const zcode = database(join(f.home, '.zcode/cli/db/db.sqlite'), zcodeSchema)
    try {
      zcode.exec("INSERT INTO session VALUES ('session', '/fixture', '1')")
      zcode
        .prepare(
          'INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'zcode',
          'session',
          now,
          'glm-5',
          'builtin:zai',
          'completed',
          100,
          50,
          20,
          10,
          150,
        )
    } finally {
      zcode.close()
    }
    const claw = clawMessage()
    await f.lines('.openclaw/agents/main/sessions/session.jsonl', [
      {
        ...claw,
        message: {
          ...claw.message,
          timestamp: now,
          model: 'muse-1',
          provider: 'meta',
        },
      },
    ])
    await f.lines('.copilot/session-state/session/events.jsonl', [
      receipt({ time: now }),
    ])
    await f.lines('.dsh/sessions/session/session.jsonl', [
      { ...dshHeader, createdAt: now },
      dshRoute,
      { ...dshUsage(), time: now },
    ])
    return f
  } catch (error) {
    await f.remove()
    throw error
  }
}

export const expectedTokens = {
  amp: 12546,
  droid: 185,
  codebuff: 180,
  cline: 135,
  kimi: 180,
  qwen: 1250,
  goose: 180,
  kilo: 185,
  zcode: 150,
  openclaw: 110643,
  copilot: 110,
  dsh: 9500,
} as const
