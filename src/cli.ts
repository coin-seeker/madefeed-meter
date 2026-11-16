import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { aggregate, MeterError, payload } from './aggregate'
import { requestDevice, pollToken, uploadUsage } from './api'
import { logout, readConfig, saveConfig, serviceUrl } from './config'
import { kstDateOf, windowStart } from './kst'
import { readClaude } from './sources/claude'
import { readCodex } from './sources/codex'
import { readOpenCode } from './sources/opencode'
import { readGemini } from './sources/gemini'
import { automatic, autoCommand } from './auto'
import type { Runtime } from './cli-options'
import { cliOptions, help, VERSION } from './cli-options'
export type { Runtime } from './cli-options'

export async function runCli(
  args: readonly string[],
  runtime: Runtime = {},
): Promise<void> {
  const parsed = cliOptions(args)
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
    positionals.length > (command === 'auto' ? 2 : 1) ||
    !['login', 'upload', 'logout', 'status', 'auto'].includes(command)
  )
    throw new MeterError('알 수 없는 명령이에요. --help를 확인해 주세요.')
  if (values['dry-run'] && command !== 'upload')
    throw new MeterError(
      '--dry-run은 기본 실행 또는 upload에서만 사용할 수 있어요.',
    )
  if (values['scheduled'] && command !== 'upload')
    throw new MeterError('--scheduled는 upload에서만 사용할 수 있어요.')
  const home = runtime.home ?? homedir()
  const env = runtime.env ?? process.env
  const autoOptions = { runtime, home, env, diagnostic }
  const auto = automatic(autoOptions)
  if (values['scheduled']) await auto.trim()
  if (command === 'logout') {
    await auto.remove()
    await logout(home)
    output(
      values['json']
        ? JSON.stringify({ loggedIn: false })
        : '로컬 기기 토큰을 지웠어요. 서버 기기 해제는 웹 설정에서 할 수 있어요.',
    )
    return
  }
  let config
  try {
    config = await readConfig(home)
  } catch (error) {
    if (values['scheduled'] && error instanceof MeterError) {
      output('연결된 기기 토큰이 없어 자동 전송을 건너뛰었어요.')
      return
    }
    throw error
  }
  if (command === 'auto') {
    const state = await autoCommand(
      positionals[1] ?? 'status',
      config,
      autoOptions,
    )
    output(
      values['json']
        ? JSON.stringify(state)
        : `자동 전송: ${state.enabled ? `켜져 있어요 (${state.kind}).` : '꺼져 있어요.'}`,
    )
    return
  }
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
  if (values['scheduled'] && !configured) {
    output('연결된 기기 토큰이 없어 자동 전송을 건너뛰었어요.')
    return
  }
  const deviceName =
    configured?.deviceName ??
    hostname()
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80)
  if (command === 'status') {
    const state = await auto.status()
    const status = {
      loggedIn: Boolean(configured),
      url,
      deviceName,
      auto: state,
    }
    output(
      values['json']
        ? JSON.stringify(status)
        : configured
          ? '기기에 로그인 정보가 있어요. 서버 연결은 전송할 때 확인해요.'
          : '아직 로그인하지 않았어요. login으로 연결해 주세요.',
    )
    if (!values['json'])
      output(
        `자동 전송: ${state.enabled ? `켜져 있어요 (${state.kind}).` : '꺼져 있어요.'}`,
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
  let saved = configured
  if (!values['scheduled'] && (command === 'login' || !token)) {
    const device = await requestDevice(api, deviceName)
    // Authentication instructions go to stderr in machine mode; never emit device_code/token.
    const instructions = values['json'] ? diagnostic : output
    instructions(
      `브라우저에서 ${device.verification_uri} 주소를 열고 ${device.user_code} 코드를 입력해 주세요.`,
    )
    token = await pollToken(api, device)
    saved = {
      url,
      deviceName,
      deviceToken: token,
      ...(config?.auto ? { auto: config.auto } : {}),
    }
    await saveConfig(home, saved)
  }
  if (
    !values['scheduled'] &&
    !values['no-auto'] &&
    env['MADEFEED_NO_AUTO'] !== '1' &&
    saved &&
    saved.auto !== 'off'
  )
    await auto.install(saved)
  if (command === 'login') {
    output(
      values['json']
        ? JSON.stringify({ loggedIn: true })
        : '기기를 연결했어요.',
    )
    return
  }
  if (!token) return
  const result = await uploadUsage(api, token, body)
  output(
    values['scheduled']
      ? `${new Date(now).toISOString()} ${result.accepted}개 사용량 합계를 전송했어요.`
      : values['json']
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
  const entry = process.argv[1]
  const exec: NonNullable<Runtime['exec']> = (file, args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
        { encoding: 'utf8' },
        (error, stdout) => {
          if (error) reject(error)
          else resolve({ stdout })
        },
      )
      child.stdin?.on('error', (error: Error) => reject(error))
      child.stdin?.end(options?.input)
    })
  runCli(process.argv.slice(2), {
    exec,
    ...(entry ? { self: realpathSync(entry) } : {}),
    platform: process.platform,
    ...(process.getuid ? { uid: process.getuid() } : {}),
  }).catch((error: unknown) => {
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
