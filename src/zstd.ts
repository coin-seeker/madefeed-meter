import type { Transform } from 'node:stream'
// Default import on purpose: `createZstdDecompress` exists only on Node 22.15
// and later, and a named import of a missing export fails module linking.
import zlib from 'node:zlib'

export type Decompressor = () => Transform

export function zstdDecompressor(): Decompressor | undefined {
  // The installed type declares the function unconditionally; older runtimes lack it.
  const create: unknown = Reflect.get(zlib, 'createZstdDecompress')
  return typeof create === 'function'
    ? () => zlib.createZstdDecompress()
    : undefined
}
