import { join, win32 } from 'node:path'

export type Exec = (
  file: string,
  args: readonly string[],
  options?: { readonly input?: string },
) => Promise<{ readonly stdout: string }>
export type ScheduleContext = {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly uid: number | undefined
  readonly node: string
  readonly agent: string
  readonly exec?: Exec
  readonly env: Readonly<Record<string, string | undefined>>
}
export const marker = '# madefeed-meter'
export const label = 'dev.madefeed.meter'
export const timer = 'madefeed-meter.timer'
export const environmentKeys = [
  'OPENCODE_DATA_DIR',
  'XDG_DATA_HOME',
  'GEMINI_DATA_DIR',
  'MADEFEED_URL',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'OMO_CODING_AGENT_DIR',
  'OMO_CODING_AGENT_SESSION_DIR',
  'ANTIGRAVITY_DATA_DIR',
  'HERMES_HOME',
] as const
export function jobEnvironment(
  context: ScheduleContext,
): readonly (readonly [string, string])[] {
  return environmentKeys.flatMap((key) => {
    const value = context.env[key]
    return value === undefined ? [] : [[key, value] as const]
  })
}
export function schedulePaths(context: ScheduleContext) {
  const path =
    context.platform === 'win32' && !context.home.startsWith('/')
      ? win32
      : { join }
  const config = path.join(context.home, '.config', 'madefeed')
  const units = join(context.home, '.config/systemd/user')
  return {
    log: path.join(config, 'auto.log'),
    plist: join(context.home, 'Library/LaunchAgents', `${label}.plist`),
    service: join(units, 'madefeed-meter.service'),
    timer: join(units, timer),
    wrapper: path.join(config, 'agent', 'run.cmd'),
  }
}
export function jobArguments(context: ScheduleContext): readonly string[] {
  return [context.node, context.agent, 'upload', '--days', '3', '--scheduled']
}
export function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
export function buildPlist(context: ScheduleContext): string {
  const string = (value: string) => `<string>${xml(value)}</string>`
  const paths = schedulePaths(context)
  const env = jobEnvironment(context)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${jobArguments(context).map(string).join('')}</array>
<key>StartInterval</key><integer>3600</integer>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key>${string(paths.log)}
<key>StandardErrorPath</key>${string(paths.log)}
${env.length ? `<key>EnvironmentVariables</key><dict>${env.map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('')}</dict>\n` : ''}</dict></plist>
`
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
function unitQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('%', '%%')}"`
}
export function buildService(context: ScheduleContext): string {
  const log = schedulePaths(context).log.replaceAll('%', '%%')
  const env = jobEnvironment(context)
    .map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}\n`)
    .join('')
  return `[Unit]\nDescription=MadeFeed Meter\n[Service]\nType=oneshot\n${env}ExecStart=${jobArguments(
    context,
  )
    .map((arg) => unitQuote(arg).replaceAll('$', '$$'))
    .join(' ')}\nStandardOutput=append:${log}\nStandardError=append:${log}\n`
}
export function buildTimer(): string {
  return '[Unit]\nDescription=MadeFeed Meter hourly upload\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n'
}
export function buildCron(context: ScheduleContext): string {
  const minute = Array.from(context.home).reduce(
    (hash, char) => (hash * 31 + (char.codePointAt(0) ?? 0)) % 60,
    0,
  )
  const env = jobEnvironment(context)
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join('')
  const command = `${env}${jobArguments(context).map(shellQuote).join(' ')} >> ${shellQuote(schedulePaths(context).log)} 2>&1`
  // Cron treats percent as a newline even inside shell quotes.
  return `${minute} * * * * ${command.replaceAll('%', '\\%')} ${marker}`
}
export function withoutMarker(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(marker))
    .join('\n')
}
function cmdQuote(value: string): string {
  // cmd expands percent even inside quotes; delayed expansion stays disabled.
  return `"${value.replaceAll('%', '%%').replaceAll('"', '"^""')}"`
}
export function buildWrapper(context: ScheduleContext): string {
  const env = jobEnvironment(context)
    .map(([key, value]) => `set ${cmdQuote(`${key}=${value}`)}\r\n`)
    .join('')
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${env}${jobArguments(context).map(cmdQuote).join(' ')} >> ${cmdQuote(schedulePaths(context).log)} 2>&1\r\n`
}
