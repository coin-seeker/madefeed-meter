import { MeterError } from './aggregate'
import { revokeDevice } from './api'
import { readConfig } from './config'
import type { automatic } from './auto'
import * as copy from './copy'

type Session = {
  readonly home: string
  readonly fetch: typeof fetch
  readonly auto: ReturnType<typeof automatic>
  readonly output: (text: string) => void
  readonly json: boolean
}

export async function runLogout(session: Session): Promise<void> {
  let config
  try {
    config = await readConfig(session.home)
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  const server = config
    ? await revokeDevice(
        { url: config.url, fetch: session.fetch },
        config.deviceToken,
      )
    : 'none'
  await session.auto.remove('device')
  let message: string
  switch (server) {
    case 'revoked':
      message = copy.logoutRevoked
      break
    case 'already':
    case 'none':
      message = copy.logoutLocal
      break
    case 'unreachable':
      message = copy.logoutUnreachable(config?.url ?? '')
      break
    default: {
      const exhaustive: never = server
      throw exhaustive
    }
  }
  session.output(
    session.json ? JSON.stringify({ loggedIn: false, server }) : message,
  )
}

export async function cleanDisconnected(
  session: Session,
  options: { readonly scheduled: boolean; readonly now: number },
): Promise<void> {
  if (options.scheduled) session.output(copy.scheduledDisconnected(options.now))
  await session.auto.remove('device')
  if (!options.scheduled) throw new MeterError(copy.disconnected)
}
