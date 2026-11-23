import { homedir, hostname } from 'node:os'
import { optionalMachineId } from './machine-id'
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
import { readSources } from './sources'
import { automatic, autoCommand } from './auto'
import type { Runtime } from './cli-options'
import { cliOptions, help, VERSION } from './cli-options'
import * as copy from './copy'
import { cleanDisconnected, runLogout } from './disconnect'
import { BACKFILL_REVISION, backfillLevel } from './backfill'
import { zstdDecompressor } from './zstd'
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
  const machine = values['dry-run']
    ? undefined
    : await optionalMachineId(runtime.machineId)
  let saved = configured
  const zstd =
    runtime.zstd === undefined ? (zstdDecompressor() ?? null) : runtime.zstd
  const done = backfillLevel(configured)
  const first = command === 'login' || done === 0
  // Read thirty days for a first sum, or to repeat one this runtime can improve.
  const history =
    !values['dry-run'] && (first || (done < BACKFILL_REVISION && zstd !== null))
  if (!values['dry-run'] && !first && done < BACKFILL_REVISION && zstd === null)
    diagnostic(copy.backfillDeferred)
  if (
    !values['dry-run'] &&
    !values['scheduled'] &&
    (command === 'login' || !token)
  ) {
    if (!machine) throw new MeterError(copy.machineIdUnavailable)
    const device = await requestDevice(api, { deviceName, machineId: machine })
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
      ...(configured?.backfillRevision
        ? { backfillRevision: configured.backfillRevision }
        : {}),
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
  const options = {
    home,
    sinceMs: windowStart(now, history ? 30 : days),
    env,
    zstd,
  }
  // Dry-run gathers without authentication or any network requests.
  const { results: sources, codex } = await readSources(options)
  // Revision 2 claims the Codex history: a run that could not read it counts as
  // revision 1 at most, so the one-time re-sum stays available for a later run.
  const revision = codex ? BACKFILL_REVISION : 1
  const backfill = history && (first || done < revision)
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
      ...(backfill
        ? { backfill: true as const, backfillRevision: revision }
        : {}),
      ...(machine ? { machineId: machine } : {}),
    })
  } catch (error) {
    if (!(error instanceof DisconnectedError)) throw error
    await cleanDisconnected(session, {
      scheduled: values['scheduled'] ?? false,
      now,
    })
    return
  }
  if (backfill) await markBackfillDone(home, { deviceToken: token, revision })
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
