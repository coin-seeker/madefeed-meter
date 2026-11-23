import { kstDateOf } from '../kst'
import type { HermesKey } from './hermes-db'
import type { Buckets, LogInfo, LoggedCall } from './hermes-log'

export type Allocation = LoggedCall & { readonly split: boolean }
export function splitHermes(
  key: HermesKey,
  log: LogInfo,
): readonly Allocation[] {
  const [, session, model, provider, first, last, i, o, r, w] = key
  const buckets: Buckets = [i, o, r, w]
  if (kstDateOf(first) === kstDateOf(last))
    return [{ ms: first, buckets, split: false }]
  const calls = log.calls.get(`${session}\0${model}\0${provider}`) ?? []
  const sums = [0, 0, 0, 0]
  for (const call of calls)
    for (const [index, value] of call.buckets.entries())
      sums[index] = (sums[index] ?? 0) + value
  const excessive = buckets.some((value, index) => (sums[index] ?? 0) > value)
  const split = !excessive && calls.length > 0
  const allocations: Allocation[] = excessive
    ? []
    : calls.map((call) => ({ ...call, split }))
  // Unknown-day remainder must never migrate to another day: old server rows remain stored.
  if (log.files === 0 || (log.oldest !== undefined && log.oldest <= first)) {
    const remaining = (index: number, amount: number) =>
      excessive ? amount : amount - (sums[index] ?? 0)
    allocations.push({
      ms: first,
      buckets: [
        remaining(0, i),
        remaining(1, o),
        remaining(2, r),
        remaining(3, w),
      ],
      split,
    })
  }
  return allocations
}
