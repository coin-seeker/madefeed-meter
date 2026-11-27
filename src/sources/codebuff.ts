import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { files, modelName, parseJson, record, unsupported } from '../aggregate'
import type { SourceOptions, SourceResult, UsageRow } from '../aggregate'
import { kstDateOf } from '../kst'
import { listRoots } from './roots'
import { capped } from './row-cap'
import { inferProvider } from './vendor'
import { codebuffText, codebuffTime, codebuffUsage } from './codebuff-usage'

const failure = 'Codebuff 기록을 읽지 못해 이번에는 빼고 올려요.'
type Event = {
  readonly key: string
  readonly ms: number
  readonly row: UsageRow
}
function parseChat(value: unknown, path: string): Event[] {
  if (!Array.isArray(value)) return []
  const chat = basename(dirname(path))
  const projectDir = dirname(dirname(dirname(path)))
  const session = `${basename(dirname(dirname(projectDir)))}/${basename(projectDir)}/${chat}`
  const chatTime = codebuffTime(chat.replace(/T(\d{2})-(\d{2})-/, 'T$1:$2:'))
  return value.flatMap((raw, ordinal) => {
    const message = record(raw)
    const role =
      codebuffText(message['variant']) ?? codebuffText(message['role'])
    if (!role || !['ai', 'agent', 'assistant'].includes(role)) return []
    const usage = codebuffUsage(message)
    const { input, cacheRead, cacheWrite } = usage
    const output = usage.output ?? 0
    const sum = input + output + cacheRead + cacheWrite
    const tokens = Math.max(sum, usage.total)
    if (!tokens) return []
    const ms =
      [
        message['timestamp'],
        message['createdAt'],
        record(message['metadata'])['timestamp'],
      ]
        .map(codebuffTime)
        .find(Number.isFinite) ?? chatTime
    if (!Number.isFinite(ms)) return []
    const model = modelName(usage.model ?? 'codebuff-unknown')
    const id =
      codebuffText(message['id']) ??
      JSON.stringify([
        ms,
        model,
        ordinal,
        input,
        output,
        cacheRead,
        cacheWrite,
        tokens - sum,
      ])
    const parts: Partial<
      Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>
    > = {}
    if (sum > 0) {
      if (input > 0) parts.input = input
      if (usage.output !== undefined) parts.output = output
      if (cacheRead > 0) parts.cacheRead = cacheRead
      if (cacheWrite > 0) parts.cacheWrite = cacheWrite
    }
    return [
      {
        key: `codebuff:${session}:${id}`,
        ms,
        row: {
          date: kstDateOf(ms),
          tool: 'codebuff',
          model,
          provider: inferProvider(model),
          tokens,
          ...parts,
        },
      },
    ]
  })
}

export async function readCodebuff(
  options: SourceOptions,
): Promise<SourceResult> {
  try {
    const candidates = await listRoots(
      options.env?.['CODEBUFF_DATA_DIR'],
      ['manicode', 'manicode-dev', 'manicode-staging'].map((channel) =>
        join(options.home, '.config', channel, 'projects'),
      ),
      options.home,
    )
    const roots = await listRoots(
      undefined,
      candidates.map((root) =>
        basename(root) === 'projects' ? root : join(root, 'projects'),
      ),
      options.home,
    )
    const paths: string[] = []
    for (const root of roots)
      for await (const path of files(root))
        if (basename(path) === 'chat-messages.json') paths.push(path)
    const events = new Map<string, Event>()
    for (const path of paths.toSorted()) {
      try {
        for (const event of parseChat(
          parseJson(await readFile(path, 'utf8')),
          path,
        ))
          events.set(event.key, event)
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(
            String(error.code),
          )
        )
          continue
        throw error
      }
    }
    return capped(
      [...events.values()]
        .filter((event) => event.ms >= options.sinceMs)
        .map((event) => event.row),
      failure,
    )
  } catch (error) {
    return unsupported(error, failure)
  }
}
