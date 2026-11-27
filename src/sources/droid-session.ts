import { parseJson, record, textLines, timestamp } from '../aggregate'

export type DroidSession = {
  readonly model?: string
  readonly firstMs?: number
}
function validTime(value: unknown): number | undefined {
  const ms = timestamp(value)
  return ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : undefined
}
export function droidSessionTime(
  settings: Record<string, unknown>,
  session: DroidSession,
  birthtimeMs: number,
): number | undefined {
  const times = [
    settings['providerLockTimestamp'],
    settings['createdAt'],
    settings['created_at'],
    settings['startedAt'],
    settings['firstTimestamp'],
    session.firstMs,
  ]
    .map(validTime)
    .filter((ms): ms is number => ms !== undefined)
  return times.length ? Math.min(...times) : validTime(birthtimeMs)
}
export async function readDroidSession(path: string): Promise<DroidSession> {
  let model: string | undefined
  let firstMs: number | undefined
  try {
    let index = 0
    for await (const line of textLines(
      path.replace(/\.settings\.json$/, '.jsonl'),
    )) {
      if (index++ >= 500) break
      const tail = line
        .split('Model:')[1]
        ?.split(/["\\[]/)[0]
        ?.trim()
      model ??= tail || undefined
      firstMs ??= validTime(record(parseJson(line))['timestamp'])
      if (model && firstMs !== undefined) break
    }
    return {
      ...(model ? { model } : {}),
      ...(firstMs !== undefined ? { firstMs } : {}),
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(
        String(error.code),
      )
    )
      return {}
    throw error
  }
}
