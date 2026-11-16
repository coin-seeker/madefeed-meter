import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { aggregate, MeterError, payload } from './aggregate'
import { requestDevice, pollToken, uploadUsage } from './api'
import { logout, readConfig, saveConfig, serviceUrl } from './config'
import { kstDateOf, windowStart } from './kst'
import { readClaude } from './sources/claude'
import { readCodex } from './sources/codex'
import { readOpenCode } from './sources/opencode'
import { readGemini } from './sources/gemini'

const VERSION = '0.2.0'
const help = `madefeed ${VERSION} — 토큰 미터예요.
사용법: madefeed [login|upload|logout|status] [옵션]
  --dry-run    전송 없이 합계와 정확한 요청 JSON을 출력해요.
  --days N     오늘을 포함한 KST 일수예요. 기본 14, 최대 35예요.
  --url URL    서버 주소예요. MADEFEED_URL 또는 https://madefeed.dev를 사용해요.
  --json       기계가 읽을 JSON만 표준 출력으로 내보내요.
  --help       도움말을 보여줘요.
  --version    버전을 보여줘요.
Claude Code, Codex, OpenCode, Gemini CLI를 읽어요.
기본 실행은 로그인 후 사용량을 전송해요. Cursor는 unsupported예요.`

type Runtime = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly now?: number
  readonly fetch?: typeof fetch
  readonly output?: (text: string) => void
  readonly diagnostic?: (text: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

export async function runCli(
  args: readonly string[],
  runtime: Runtime = {},
): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' },
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
  const { values, positionals } = parsed
  const output = runtime.output ?? console.log
  const diagnostic = runtime.diagnostic ?? console.error
  if (values['help']) {
    output(help)
    return
  }
  if (values['version']) {
    output(VERSION)
    return
  }
  const days = Number(values['days'] ?? 14)
  if (!Number.isInteger(days) || days < 1 || days > 35)
    throw new MeterError('--days는 1~35 사이의 정수여야 해요.')
  const command = positionals[0] ?? 'upload'
  if (
    positionals.length > 1 ||
    !['login', 'upload', 'logout', 'status'].includes(command)
  )
    throw new MeterError('알 수 없는 명령이에요. --help를 확인해 주세요.')
  if (values['dry-run'] && command !== 'upload')
    throw new MeterError(
      '--dry-run은 기본 실행 또는 upload에서만 사용할 수 있어요.',
    )
  const home = runtime.home ?? homedir()
  const env = runtime.env ?? process.env
  if (command === 'logout') {
    await logout(home)
    output(
      values['json']
        ? JSON.stringify({ loggedIn: false })
        : '로컬 기기 토큰을 지웠어요. 서버 기기 해제는 웹 설정에서 할 수 있어요.',
    )
    return
  }
  const config = await readConfig(home)
  const chosen =
    values['url'] ??
    env['MADEFEED_URL'] ??
    config?.url ??
    'https://madefeed.dev'
  if (typeof chosen !== 'string')
    throw new MeterError('서버 URL이 올바르지 않아요.')
  const url = serviceUrl(chosen)
  // Never send a token to an origin other than the origin that issued it.
  const configured = config?.url === url ? config : undefined
  const deviceName =
    configured?.deviceName ??
    hostname()
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80)
  if (command === 'status') {
    const status = { loggedIn: Boolean(configured), url, deviceName }
    output(
      values['json']
        ? JSON.stringify(status)
        : configured
          ? '기기에 로그인 정보가 있어요. 서버 연결은 전송할 때 확인해요.'
          : '아직 로그인하지 않았어요. login으로 연결해 주세요.',
    )
    return
  }
  const now = runtime.now ?? Date.now()
  const options = { home, sinceMs: windowStart(now, days), env }
  const api = {
    url,
    fetch: runtime.fetch ?? fetch,
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
  }
  // Gather before authentication: dry-run never requests or polls a device code.
  const sources =
    command === 'upload'
      ? await Promise.all([
          readClaude(options),
          readCodex(options),
          readOpenCode(options),
          readGemini(options),
        ])
      : []
  for (const source of sources) if (source.reason) diagnostic(source.reason)
  const rows = aggregate(
    sources
      .flatMap((source) => source.rows)
      .filter((row) => row.date <= kstDateOf(now)),
  )
  const body = payload(deviceName, rows)
  if (values['dry-run']) {
    if (!values['json']) {
      output('전송하지 않았어요. 아래 합계와 JSON만 전송 대상이에요.')
      output('date        tool         model                         tokens')
      for (const row of rows)
        output(
          `${row.date}  ${row.tool.padEnd(11)}  ${row.model.padEnd(28)}  ${row.tokens}`,
        )
    }
    output(JSON.stringify(body, null, values['json'] ? undefined : 2))
    return
  }
  let token = configured?.deviceToken
  if (command === 'login' || !token) {
    const device = await requestDevice(api, deviceName)
    // Authentication instructions go to stderr in machine mode; never emit device_code/token.
    const instructions = values['json'] ? diagnostic : output
    instructions(
      `브라우저에서 ${device.verification_uri} 주소를 열고 ${device.user_code} 코드를 입력해 주세요.`,
    )
    token = await pollToken(api, device)
    await saveConfig(home, { url, deviceName, deviceToken: token })
  }
  if (command === 'login') {
    output(
      values['json']
        ? JSON.stringify({ loggedIn: true })
        : '기기를 연결했어요.',
    )
    return
  }
  const result = await uploadUsage(api, token, body)
  output(
    values['json']
      ? JSON.stringify(result)
      : `${result.accepted}개 사용량 합계를 전송했어요.`,
  )
}

// npm runs the bin through a symlink (node_modules/.bin/madefeed), so compare
// real paths; a missing or unreadable argv[1] means this file was imported.
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    // Only controlled errors reach output: filesystem/network errors can contain private paths.
    const message =
      error instanceof MeterError
        ? error.message
        : '로컬 사용량 또는 설정을 처리할 수 없어요. 접근 권한과 Node.js 버전을 확인해 주세요.'
    if (process.argv.includes('--json'))
      console.error(JSON.stringify({ error: message }))
    else console.error(message)
    process.exitCode = 1
  })
}
