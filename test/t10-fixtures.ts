import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ms = Date.parse('2026-11-16T00:00:00Z')
export async function jsonl(path: string, events: readonly unknown[]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    events
      .map((event) =>
        typeof event === 'string' ? event : JSON.stringify(event),
      )
      .join('\n') + '\n',
  )
}
export const dshHeader = { type: 'session', id: 'sid', createdAt: ms }
export const dshRoute = {
  type: 'request/header',
  data: {
    header: {
      config: { model: 'deepseek-v4-pro', provider: 'deepseek-official' },
    },
  },
}
export function dshUsage(
  seq = 5,
  usage: unknown = {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 8000,
    totalTokens: 9500,
  },
) {
  return { type: 'assistant/message', seq, time: ms, data: { usage } }
}
export function clawMessage(
  usage: unknown = { input: 1660, output: 55, cacheRead: 108928 },
) {
  return {
    type: 'message',
    id: 'event',
    message: { role: 'assistant', timestamp: ms, usage },
  }
}
export function receipt(
  options: { id?: string; time?: number; usage?: Record<string, unknown> } = {},
) {
  return {
    type: 'session.usage_record',
    id: options.id ?? 'receipt',
    timestamp: new Date(options.time ?? ms).toISOString(),
    data: {
      usage: {
        model: 'gpt-5-1m',
        inputTokens: 100,
        outputTokens: 10,
        ...options.usage,
      },
    },
  }
}
export function shutdown(
  options: {
    id?: string
    time?: number
    usage?: Record<string, unknown>
    watermarks?: unknown
  } = {},
) {
  return {
    type: 'session.shutdown',
    id: options.id ?? 'shutdown',
    timestamp: new Date(options.time ?? ms).toISOString(),
    data: {
      usageAccountingWatermarks: options.watermarks,
      modelMetrics: {
        'gpt-5-1m-internal': {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 20,
            reasoningTokens: 5,
            ...options.usage,
          },
        },
      },
    },
  }
}
