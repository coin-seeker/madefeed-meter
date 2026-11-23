import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseJson, record } from '../aggregate'

export function expandTilde(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function jsonc(text: string): string | undefined {
  let invalid = false
  // Strings are matched first so comment markers inside strings stay literal.
  const stripped = text.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (token) => {
      if (token.startsWith('"')) return token
      if (token.startsWith('/*') && (token.length < 4 || !token.endsWith('*/')))
        invalid = true
      return token.replace(/[^\r\n]/g, ' ')
    },
  )
  if (invalid) return undefined
  return stripped.replace(
    /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
    (token, closing: string | undefined) => closing ?? token,
  )
}

async function settingsValue(
  agent: string,
  commented: boolean,
): Promise<string | undefined> {
  for (const name of commented
    ? ['settings.jsonc', 'settings.json']
    : ['settings.json']) {
    try {
      const content = (await readFile(join(agent, name), 'utf8')).replace(
        /^\uFEFF/,
        '',
      )
      const text = commented ? jsonc(content) : content
      const value =
        text === undefined ? undefined : record(parseJson(text))['sessionDir']
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue
      if (error instanceof Error) return undefined
      throw error
    }
  }
  return undefined
}

type CustomOptions = {
  readonly agent: string
  readonly home: string
  readonly env: string | undefined
  readonly commented: boolean
}

export async function customSessionDir(
  options: CustomOptions,
): Promise<string | undefined> {
  const value =
    options.env || (await settingsValue(options.agent, options.commented))
  if (!value) return undefined
  const path = expandTilde(value, options.home)
  return isAbsolute(path) ? path : undefined
}
