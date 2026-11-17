import { setTimeout } from 'node:timers/promises'
import { MeterError, record, payload } from './aggregate'
import type { UsagePayload } from './aggregate'
import { ApiError, post } from './api-http'
import type { Api } from './api-http'
export { ApiError } from './api-http'
export type { Api } from './api-http'
import {
  accessDenied,
  apiFailure,
  expiredCode,
  invalidCode,
  machineIdUnavailable,
  upgradeRequired,
} from './copy'

export type Device = {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly expires_in: number
  readonly interval: number
}
export type UploadResult = {
  readonly accepted: number
  readonly ignored: number
  readonly backfill: 'applied' | 'closed' | null
  readonly bankVotes?: number
  readonly weekTokens: number
  readonly votesGranted: number
}

export class DisconnectedError extends MeterError {}
export async function requestDevice(
  api: Api,
  device: { readonly deviceName: string; readonly machineId: string },
): Promise<Device> {
  if (!/^[0-9a-f]{64}$/.test(device.machineId))
    throw new MeterError(machineIdUnavailable)
  const { status, data } = await post(api, {
    path: '/api/meter/device',
    body: { deviceName: device.deviceName, machineId: device.machineId },
  })
  if (
    status === 400 &&
    (data['error'] === 'upgrade_required' ||
      record(data['error'])['code'] === 'upgrade_required')
  )
    throw new MeterError(upgradeRequired)
  if (status !== 200) throw new ApiError(status)
  const code = data['device_code']
  const user = data['user_code']
  const uri = data['verification_uri']
  const expires = data['expires_in']
  const interval = data['interval']
  if (
    typeof code !== 'string' ||
    typeof user !== 'string' ||
    typeof uri !== 'string' ||
    typeof expires !== 'number' ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    typeof interval !== 'number' ||
    !Number.isFinite(interval) ||
    interval <= 0
  )
    throw new MeterError('기기 인증 응답이 올바르지 않아요.')
  let verification: URL
  try {
    verification = new URL(uri)
  } catch (error) {
    if (error instanceof TypeError)
      throw new MeterError('인증 주소가 올바르지 않아요.')
    throw error
  }
  if (verification.protocol !== 'https:' && verification.origin !== api.url)
    throw new MeterError('안전하지 않은 인증 주소예요.')
  return {
    device_code: code,
    user_code: user,
    verification_uri: uri,
    expires_in: expires,
    interval,
  }
}
export async function pollToken(api: Api, device: Device): Promise<string> {
  const deadline = Date.now() + device.expires_in * 1000
  const sleep =
    api.sleep ??
    (async (ms: number) => {
      await setTimeout(ms)
    })
  // Attempt budget also keeps injected clocks/sleep implementations finite.
  for (
    let attempt = 0;
    attempt < Math.ceil(device.expires_in / device.interval);
    attempt++
  ) {
    await sleep(device.interval * 1000)
    if (Date.now() >= deadline) break
    const { status, data } = await post(api, {
      path: '/api/meter/token',
      body: { device_code: device.device_code },
    })
    if (status === 200) {
      const token = data['token']
      if (typeof token !== 'string' || !/^mfd_[A-Za-z0-9_-]+$/.test(token))
        throw new MeterError('기기 토큰 응답이 올바르지 않아요.')
      return token
    }
    const code =
      typeof data['error'] === 'string'
        ? data['error']
        : record(data['error'])['code']
    if (status !== 400) throw new ApiError(status)
    switch (code) {
      case 'authorization_pending':
        continue
      case 'expired_token':
        throw new MeterError(expiredCode)
      case 'invalid_grant':
        throw new MeterError(invalidCode)
      case 'access_denied':
        throw new MeterError(accessDenied)
      default:
        throw new ApiError(status)
    }
  }
  throw new MeterError(expiredCode)
}
export async function revokeDevice(
  api: Api,
  token: string,
): Promise<'revoked' | 'already' | 'unreachable'> {
  try {
    const { status, data } = await post(api, {
      path: '/api/meter/revoke',
      body: {},
      token,
    })
    if (status === 200 && data['ok'] === true) return 'revoked'
    if (status === 401 && record(data['error'])['code'] === 'unauthorized')
      return 'already'
    return 'unreachable'
  } catch (error) {
    if (error instanceof MeterError) return 'unreachable'
    throw error
  }
}
function responseNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new MeterError('사용량 저장 응답이 올바르지 않아요.')
  return value
}
export async function uploadUsage(
  api: Api,
  token: string,
  body: UsagePayload & {
    readonly backfill?: true
    readonly machineId?: string
  },
): Promise<UploadResult> {
  let accepted = 0
  let weekTokens = 0
  let votesGranted = 0
  let ignored = 0
  let backfill: UploadResult['backfill'] = null
  let bankVotes: number | undefined
  const safe = payload(body.deviceName, body.rows)
  let offset = 0
  do {
    const { status, data } = await post(api, {
      path: '/api/meter/usage',
      token,
      body: {
        deviceName: safe.deviceName,
        rows: safe.rows.slice(offset, offset + 200),
        ...(body.backfill ? { backfill: true } : {}),
        ...(body.machineId ? { machineId: body.machineId } : {}),
      },
    })
    if (status === 401 && record(data['error'])['code'] === 'unauthorized')
      throw new DisconnectedError(apiFailure(status))
    if (status !== 200) throw new ApiError(status)
    accepted += responseNumber(data['accepted'])
    weekTokens = responseNumber(data['weekTokens'])
    votesGranted += responseNumber(data['votesGranted'])
    ignored += responseNumber(data['ignored'] ?? 0)
    bankVotes =
      data['bankVotes'] === undefined
        ? undefined
        : responseNumber(data['bankVotes'])
    switch (data['backfill']) {
      case 'applied':
        backfill = 'applied'
        break
      case 'closed':
        backfill ??= 'closed'
        break
      case undefined:
      case null:
        break
      default:
        throw new MeterError('사용량 저장 응답이 올바르지 않아요.')
    }
    offset += 200
  } while (offset < safe.rows.length)
  return {
    accepted,
    ignored,
    backfill,
    weekTokens,
    votesGranted,
    ...(bankVotes === undefined ? {} : { bankVotes }),
  }
}
