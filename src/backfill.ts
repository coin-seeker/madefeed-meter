import type { Config } from './config'

export const BACKFILL_REVISION = 4
// A history sum that read Codex but not both Antigravity and Hermes.
export const CODEX_REVISION = 3

export function backfillLevel(config: Config | undefined): number {
  return config?.backfillRevision ?? (config?.backfill === 'done' ? 1 : 0)
}
