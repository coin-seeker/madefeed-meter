import type { Config } from './config'

export const BACKFILL_REVISION = 3

export function backfillLevel(config: Config | undefined): number {
  return config?.backfillRevision ?? (config?.backfill === 'done' ? 1 : 0)
}
