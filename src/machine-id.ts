import { createHash } from 'node:crypto'
import { MeterError } from './aggregate'
import { machineIdUnavailable } from './copy'

type MachineRuntime = {
  readonly platform: NodeJS.Platform
  readonly exec: (
    file: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string }>
  readonly read: (path: string) => Promise<string>
}

export async function machineId(runtime: MachineRuntime): Promise<string> {
  let raw: string | undefined
  try {
    switch (runtime.platform) {
      case 'darwin': {
        const { stdout } = await runtime.exec('ioreg', [
          '-rd1',
          '-c',
          'IOPlatformExpertDevice',
        ])
        raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1]?.trim()
        break
      }
      case 'linux':
        for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
          try {
            raw = (await runtime.read(path)).trim()
          } catch (error) {
            if (!(error instanceof Error)) throw error
          }
          if (raw) break
        }
        break
      case 'win32': {
        const { stdout } = await runtime.exec('reg', [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
          '/v',
          'MachineGuid',
        ])
        raw = /^\s*MachineGuid\s+REG_SZ\s+(.+?)\s*$/im.exec(stdout)?.[1]?.trim()
        break
      }
      default:
        throw new MeterError(machineIdUnavailable)
    }
  } catch (error) {
    if (error instanceof Error) throw new MeterError(machineIdUnavailable)
    throw error
  }
  if (!raw) throw new MeterError(machineIdUnavailable)
  return createHash('sha256').update(`madefeed-meter:v1:${raw}`).digest('hex')
}

export async function optionalMachineId(
  read?: () => Promise<string>,
): Promise<string | undefined> {
  try {
    const value = await read?.()
    return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined
  } catch (error) {
    if (error instanceof Error) return undefined
    throw error
  }
}
