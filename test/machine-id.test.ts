import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { machineId } from '../src/machine-id'
import { MeterError } from '../src/aggregate'
import { machineIdUnavailable } from '../src/copy'

it.each([
  {
    platform: 'darwin',
    stdout: '  "IOPlatformUUID" = "fixture-mac-id"\n',
    raw: 'fixture-mac-id',
    command: ['ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']],
  },
  {
    platform: 'win32',
    stdout:
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    fixture-windows-id\r\n',
    raw: 'fixture-windows-id',
    command: [
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    ],
  },
] as const)(
  'hashes only the platform identifier for $platform',
  async ({ platform, stdout, raw, command }) => {
    // Given
    const calls: unknown[] = []
    // When
    const result = await machineId({
      platform,
      exec: async (file, args) => {
        calls.push([file, args])
        return { stdout }
      },
      read: async () => {
        throw new TypeError('unexpected filesystem read')
      },
    })
    // Then
    expect(result).toBe(
      createHash('sha256').update(`madefeed-meter:v1:${raw}`).digest('hex'),
    )
    expect(result).toMatch(/^[0-9a-f]{64}$/)
    expect(calls).toEqual([command])
  },
)

it.each(['present', 'empty', 'unreadable'] as const)(
  'reads trimmed Linux identifiers with primary file %s',
  async (primary) => {
    // Given
    const reads: string[] = []
    // When
    const result = await machineId({
      platform: 'linux',
      exec: async () => {
        throw new TypeError('unexpected OS command')
      },
      read: async (path) => {
        reads.push(path)
        if (path === '/etc/machine-id') {
          if (primary === 'unreadable') throw new TypeError('fixture denied')
          return primary === 'empty' ? ' \n' : ' primary-id\n'
        }
        return ' fallback-id\n'
      },
    })
    // Then
    const raw = primary === 'present' ? 'primary-id' : 'fallback-id'
    expect(result).toBe(
      createHash('sha256').update(`madefeed-meter:v1:${raw}`).digest('hex'),
    )
    expect(reads).toEqual(
      primary === 'present'
        ? ['/etc/machine-id']
        : ['/etc/machine-id', '/var/lib/dbus/machine-id'],
    )
  },
)

it.each(['darwin', 'win32', 'linux', 'freebsd'] as const)(
  'rejects unreadable identifiers without exposing raw output on %s',
  async (platform) => {
    // Given
    // When
    const result = machineId({
      platform,
      exec: async () => {
        throw new TypeError('PRIVATE-RAW')
      },
      read: async () => {
        throw new TypeError('PRIVATE-RAW')
      },
    })
    // Then
    await expect(result).rejects.toBeInstanceOf(MeterError)
    await expect(result).rejects.toThrow(machineIdUnavailable)
  },
)

it.each(['darwin', 'win32', 'linux'] as const)(
  'rejects empty or unparseable identifiers on %s',
  async (platform) => {
    // Given / When
    const result = machineId({
      platform,
      exec: async () => ({ stdout: 'unrelated output' }),
      read: async () => ' \n',
    })
    // Then
    await expect(result).rejects.toThrow(machineIdUnavailable)
  },
)
