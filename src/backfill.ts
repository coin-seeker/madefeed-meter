import type { Config } from './config'
import type { readSources } from './sources'

// Revision 5 also requires every reader added in 0.10.0 to succeed.
export const BACKFILL_REVISION = 5
export const AGY_HERMES_REVISION = 4
// A history sum that read Codex but not both Antigravity and Hermes.
export const CODEX_REVISION = 3

export function sourceRevision(
  sources: Awaited<ReturnType<typeof readSources>>,
) {
  // Failed readers preserve the higher revision's one-time re-sum.
  return !sources.codex
    ? 1
    : sources.agy && sources.hermes
      ? sources.newSourcesOk
        ? BACKFILL_REVISION
        : AGY_HERMES_REVISION
      : CODEX_REVISION
}

export function backfillLevel(config: Config | undefined): number {
  return config?.backfillRevision ?? (config?.backfill === 'done' ? 1 : 0)
}
