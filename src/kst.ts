const offsetMs = 9 * 60 * 60 * 1000
export function kstDateOf(value: number | string): string {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return new Date(ms + offsetMs).toISOString().slice(0, 10)
}

export function windowStart(now: number, days: number): number {
  return (
    Date.parse(`${kstDateOf(now)}T00:00:00+09:00`) - (days - 1) * 86_400_000
  )
}
