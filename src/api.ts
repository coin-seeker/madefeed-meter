import { setTimeout } from 'node:timers/promises'
import { MeterError, record, payload } from './aggregate'
import type { UsagePayload } from './aggregate'

export type Api = {
  readonly url: string
  readonly fetch: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}
export type Device = {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly expires_in: number
  readonly interval: number
}
export type UploadResult = {
  readonly accepted: number
  readonly weekTokens: number
  readonly votesGranted: number
}

export class ApiError extends MeterError {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'HTTP 401: 기기 인증이 유효하지 않아요. login으로 다시 연결해 주세요.'
        : status === 422
          ? 'HTTP 422: 사용량 형식이 서버 규칙과 맞지 않아요.'
          : `HTTP ${status}: 서버 요청에 실패했어요.`,
    )
  }
}
type Post = {
  readonly path: string
  readonly body: unknown
  readonly token?: string
}
async function post(
  api: Api,
  request: Post,
): Promise<{
  readonly status: number
  readonly data: Record<string, unknown>
}> {
  try {
    const response = await api.fetch(`${api.url}${request.path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json',
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
      },
      body: JSON.stringify(request.body),
    })
    const data: unknown = await response.json()
    return { status: response.status, data: record(data) }
  } catch (error) {
    if (error instanceof Error)
      throw new MeterError(
        '네트워크 연결 또는 서버 응답을 확인해 주세요. 자동 재전송하지 않아요.',
      )
    throw error
  }
}
export async function requestDevice(
  api: Api,
  deviceName: string,
): Promise<Device> {
  const { status, data } = await post(api, {
    path: '/api/meter/device',
    body: { deviceName },
  })
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
        throw new MeterError(
          '기기 인증 코드가 만료됐어요. login을 다시 실행해 주세요.',
        )
      case 'invalid_grant':
        throw new MeterError(
          '유효하지 않은 인증 코드예요. login을 다시 실행해 주세요.',
        )
      default:
        throw new ApiError(status)
    }
  }
  throw new MeterError(
    '기기 인증 코드가 만료됐어요. login을 다시 실행해 주세요.',
  )
}
export async function uploadUsage(
  api: Api,
  token: string,
  body: UsagePayload,
): Promise<UploadResult> {
  let accepted = 0
  let weekTokens = 0
  let votesGranted = 0
  const safe = payload(body.deviceName, body.rows)
  for (let offset = 0; offset < safe.rows.length; offset += 200) {
    const { status, data } = await post(api, {
      path: '/api/meter/usage',
      token,
      body: {
        deviceName: safe.deviceName,
        rows: safe.rows.slice(offset, offset + 200),
      },
    })
    if (status !== 200) throw new ApiError(status)
    const values = [data['accepted'], data['weekTokens'], data['votesGranted']]
    if (
      !values.every(
        (value) =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0,
      )
    )
      throw new MeterError('사용량 저장 응답이 올바르지 않아요.')
    const a = data['accepted']
    const w = data['weekTokens']
    const v = data['votesGranted']
    if (
      typeof a === 'number' &&
      typeof w === 'number' &&
      typeof v === 'number'
    ) {
      accepted += a
      weekTokens = w
      votesGranted += v
    }
  }
  return { accepted, weekTokens, votesGranted }
}
