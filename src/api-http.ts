import { MeterError, record } from './aggregate'
import { apiFailure } from './copy'

export type Api = {
  readonly url: string
  readonly fetch: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export class ApiError extends MeterError {
  constructor(readonly status: number) {
    super(apiFailure(status))
  }
}

type Post = {
  readonly path: string
  readonly body: unknown
  readonly token?: string
}

export async function post(
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
