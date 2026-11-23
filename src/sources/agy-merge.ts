// Mutable event accumulator; identities and maxima are folded in place.
export type AgyEvent = {
  ms: number
  timeRank: number
  model: string
  modelRank: number
  fallback: string | undefined
  keys: string[]
  input: number
  visible: number
  output: number
  cacheWrite: number
  cacheRead: number
  reasoning: number
}
export type AgyTotal = readonly [
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
]
export function antigravityMerge() {
  const fold = (target: AgyEvent, duplicate: AgyEvent) => {
    target.input = Math.max(target.input, duplicate.input)
    target.visible = Math.max(target.visible, duplicate.visible)
    target.cacheWrite = Math.max(target.cacheWrite, duplicate.cacheWrite)
    target.cacheRead = Math.max(target.cacheRead, duplicate.cacheRead)
    target.reasoning = Math.max(target.reasoning, duplicate.reasoning)
    target.output = Math.max(
      target.output,
      duplicate.output,
      target.visible + target.reasoning,
    )
    if (duplicate.modelRank > target.modelRank) {
      target.model = duplicate.model
      target.modelRank = duplicate.modelRank
      target.fallback = duplicate.fallback
    }
    if (
      duplicate.timeRank > target.timeRank ||
      (duplicate.timeRank === target.timeRank && duplicate.ms < target.ms)
    ) {
      target.ms = duplicate.ms
      target.timeRank = duplicate.timeRank
    }
    target.keys = [...new Set([...target.keys, ...duplicate.keys])]
  }
  const totals = (
    events: readonly AgyEvent[],
    sinceMs: number,
  ): readonly AgyTotal[] => {
    const slots: (AgyEvent | undefined)[] = []
    const indexes = new Map<string, number>()
    for (const event of events) {
      const matched = [
        ...new Set(
          event.keys.flatMap((key) => {
            const index = indexes.get(key)
            return index === undefined ? [] : [index]
          }),
        ),
      ].toSorted((a, b) => a - b)
      const first = matched[0]
      const target = first === undefined ? undefined : slots[first]
      if (first === undefined || target === undefined) {
        for (const key of event.keys) indexes.set(key, slots.length)
        slots.push(event)
        continue
      }
      for (const index of matched.slice(1)) {
        const duplicate = slots[index]
        if (duplicate) fold(target, duplicate)
        slots[index] = undefined
      }
      fold(target, event)
      for (const key of target.keys) indexes.set(key, first)
    }
    const daily = new Map<string, AgyTotal>()
    for (const event of slots) {
      if (!event || event.ms < sinceMs) continue
      let model =
        event.modelRank === 2 ? event.model : (event.fallback ?? 'agy')
      for (const suffix of [
        '-extra-low',
        '-extra-high',
        '-minimal',
        '-low',
        '-medium',
        '-high',
      ]) {
        if (!model.endsWith(suffix)) continue
        model = model.slice(0, -suffix.length)
        break
      }
      const date = new Date(event.ms + 32400000).toISOString().slice(0, 10)
      const key = JSON.stringify([date, model])
      const prior = daily.get(key)
      const tokens =
        event.input + event.cacheWrite + event.cacheRead + event.output
      daily.set(key, [
        date,
        model,
        (prior?.[2] ?? 0) + tokens,
        (prior?.[3] ?? 0) + event.input,
        (prior?.[4] ?? 0) + event.output,
        (prior?.[5] ?? 0) + event.cacheRead,
        (prior?.[6] ?? 0) + event.cacheWrite,
        (prior?.[7] ?? 0) + event.reasoning,
      ])
    }
    return [...daily.values()]
  }
  return { totals }
}
