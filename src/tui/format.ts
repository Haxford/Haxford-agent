/** Small pure formatters shared across TUI components. */

/** Format a token count compactly: 200000 -> "200k", 1000000 -> "1M". */
export function formatCtx(n: number): string {
  if (n >= 1_000_000) {
    const whole = n % 1_000_000 === 0
    return `${whole ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** Format seconds as a compact elapsed label: "8s", "1m12s", "1h04m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min < 60) return `${min}m${String(sec).padStart(2, "0")}s`
  const hr = Math.floor(min / 60)
  return `${hr}h${String(min % 60).padStart(2, "0")}m`
}

/** Format a token count for the activity line: 2100 -> "2.1k". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
