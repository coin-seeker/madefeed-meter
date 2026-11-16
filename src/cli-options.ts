import { parseArgs } from 'node:util'
import { MeterError } from './aggregate'
import type { AutoRuntime } from './auto'

export type Runtime = AutoRuntime & {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly now?: number
  readonly fetch?: typeof fetch
  readonly output?: (text: string) => void
  readonly diagnostic?: (text: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

export const VERSION = '0.2.0'
export const help = `madefeed ${VERSION} — 토큰 미터예요.
사용법: madefeed [login|upload|logout|status|auto [on|off|status]] [옵션]
  --dry-run    전송 없이 합계와 정확한 요청 JSON을 출력해요.
  --days N     오늘을 포함한 KST 일수예요. 기본 14, 최대 35예요.
  --url URL    서버 주소예요. MADEFEED_URL 또는 https://madefeed.dev를 사용해요.
  --json       기계가 읽을 JSON만 표준 출력으로 내보내요.
  --no-auto    이번 실행에서는 자동 전송을 등록하거나 갱신하지 않아요.
  --scheduled  스케줄러에서 로그인 없이 실행해요.
  --help       도움말을 보여줘요.
  --version    버전을 보여줘요.
Claude Code, Codex, OpenCode, Gemini CLI를 읽어요.
기본 실행은 로그인 후 사용량을 전송해요. Cursor는 unsupported예요.`

export function cliOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' },
        'no-auto': { type: 'boolean' },
        scheduled: { type: 'boolean' },
        days: { type: 'string' },
        url: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    })
  } catch (error) {
    if (error instanceof Error)
      throw new MeterError(
        '명령 옵션이 올바르지 않아요. --help를 확인해 주세요.',
      )
    throw error
  }
}
