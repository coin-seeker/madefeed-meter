import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { aggregate, MeterError, payload } from './aggregate'
import {
  DisconnectedError,
  requestDevice,
  pollToken,
  revokeDevice,
  uploadUsage,
} from './api'
import { markBackfillDone, readConfig, saveConfig, serviceUrl } from './config'
import { kstDateOf, windowStart } from './kst'
import { sourceReaders } from './sources'
import { automatic, autoCommand } from './auto'
import type { Runtime } from './cli-options'
import { cliOptions, help, VERSION } from './cli-options'
import * as copy from './copy'
import { cleanDisconnected, runLogout } from './disconnect'
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
    throw new MeterError(copy.invalidDays)
  const command = positionals[0] ?? 'upload'
  if (
    positionals.length > (command === 'auto' ? 2 : 1) ||
    !['login', 'upload', 'logout', 'status', 'auto'].includes(command)
  )
    throw new MeterError(copy.unknownCommand)
  if (values['dry-run'] && command !== 'upload')
    throw new MeterError(copy.invalidDryRun)
  if (values['scheduled'] && command !== 'upload')
    throw new MeterError(copy.invalidScheduled)
  const home = runtime.home ?? homedir()
  const env = runtime.env ?? process.env
  const autoOptions = { runtime, home, env, diagnostic }
  const auto = automatic(autoOptions)
  const session = {
    home,
    auto,
    output,
    json: values['json'] ?? false,
    fetch: runtime.fetch ?? fetch,
  }
  if (values['scheduled']) await auto.trim()
  if (command === 'logout') {
    await runLogout(session)
    return
  }
  let config
  try {
    config = await readConfig(home)
  } catch (error) {
    if (command === 'login' && error instanceof Error) config = undefined
    else {
      if (values['scheduled'] && error instanceof MeterError) {
        output(copy.scheduledSkip)
        return
      }
      throw error
    }
  }
  if (command === 'auto') {
    const state = await autoCommand(
      positionals[1] ?? 'status',
      config,
      autoOptions,
    )
    output(values['json'] ? JSON.stringify(state) : copy.autoLine(state))
    return
  }
  const chosen =
    values['url'] ??
    env['MADEFEED_URL'] ??
    config?.url ??
    'https://madefeed.dev'
  const url = serviceUrl(chosen)
  // Never send a token to an origin other than the origin that issued it.
  const configured = config?.url === url ? config : undefined
  if (values['scheduled'] && !configured) {
    output(copy.scheduledSkip)
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
      values['json'] ? JSON.stringify(status) : copy.connectionLine(configured),
    )
    if (!values['json']) output(copy.autoLine(state))
    return
  }
  const now = runtime.now ?? Date.now()
  const api = {
    url,
    fetch: runtime.fetch ?? fetch,
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
  }
  let token = configured?.deviceToken
  let saved = configured
  const backfill =
    !values['dry-run'] &&
    (command === 'login' || configured?.backfill !== 'done')
  if (
    !values['dry-run'] &&
    !values['scheduled'] &&
    (command === 'login' || !token)
  ) {
    const device = await requestDevice(api, deviceName)
    // Machine output contains one result only; approval instructions belong on stderr.
    const instructions = values['json'] ? diagnostic : output
    for (const line of copy.approval(device)) instructions(line)
    token = await pollToken(api, device)
    if (
      configured &&
      (await revokeDevice(api, configured.deviceToken)) === 'unreachable'
    )
      diagnostic(copy.reloginUnreachable(url))
    saved = {
      url,
      deviceName,
      deviceToken: token,
      ...(config?.auto ? { auto: config.auto } : {}),
      ...(configured?.backfill ? { backfill: configured.backfill } : {}),
    }
    await saveConfig(home, saved)
    instructions(copy.connected(deviceName))
  }
  if (
    !values['dry-run'] &&
    !values['scheduled'] &&
    !values['no-auto'] &&
    env['MADEFEED_NO_AUTO'] !== '1' &&
    saved &&
    saved.auto !== 'off'
  )
    await auto.install(saved)
  const options = { home, sinceMs: windowStart(now, backfill ? 30 : days), env }
  // Dry-run gathers without authentication or any network requests.
  const sources = await Promise.all(sourceReaders.map((read) => read(options)))
  for (const source of sources) if (source.reason) diagnostic(source.reason)
  const rows = aggregate(
    sources
      .flatMap((source) => source.rows)
      .filter((row) => row.date <= kstDateOf(now)),
  )
  const body = payload(deviceName, rows)
  if (values['dry-run']) {
    if (!values['json']) {
      output(copy.dryRunHeader)
      output(copy.dryRunColumns)
      for (const row of rows)
        output(
          `${row.date}  ${row.tool.padEnd(11)}  ${row.model.padEnd(28)}  ${row.tokens}`,
        )
    }
    output(JSON.stringify(body, null, values['json'] ? undefined : 2))
    return
  }
  if (!token) return
  let result
  try {
    result = await uploadUsage(api, token, {
      ...body,
      ...(backfill ? { backfill: true as const } : {}),
    })
  } catch (error) {
    if (!(error instanceof DisconnectedError)) throw error
    await cleanDisconnected(session, {
      scheduled: values['scheduled'] ?? false,
      now,
    })
    return
  }
  if (saved?.backfill !== 'done') await markBackfillDone(home, token)
  output(
    values['scheduled']
      ? copy.scheduledUpload(now, result)
      : values['json']
        ? JSON.stringify({
            ...(command === 'login' ? { loggedIn: true } : {}),
            ...result,
          })
        : copy.uploadResult(result),
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
      error instanceof MeterError ? error.message : copy.localFailure
    if (process.argv.includes('--json'))
      console.error(JSON.stringify({ error: message }))
    else console.error(message)
    process.exitCode = 1
  })
}
