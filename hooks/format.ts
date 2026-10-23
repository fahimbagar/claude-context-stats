import type { MainStats, UsageSnapshot } from '../types'

export function formatTokens(n: number): string {
  return withUnit(n, 1000, ['', 'k', 'M', 'B'])
}

export function formatBytes(n: number): string {
  return withUnit(n, 1024, [' B', ' KB', ' MB', ' GB'])
}

// One decimal under 100 ("84.2k"), none from 100 up ("610k"). The unit steps
// up when rounding would print the base itself, so 999,960 is "1M", not "1000k".
function withUnit(n: number, base: number, units: readonly string[]): string {
  let value = n
  let unit = 0

  while (unit < units.length - 1 && roundForDisplay(value) >= base) {
    value /= base
    unit += 1
  }

  return `${roundForDisplay(value)}${units[unit]}`
}

function roundForDisplay(value: number): number {
  return value >= 100 ? Math.round(value) : Number(value.toFixed(1))
}

export function mainLine(main: MainStats, usage: UsageSnapshot | null): string {
  const parts = [`tok ${contextPart(usage)}`, `reqs ${main.reqs}`]

  if (main.growthCount > 0) {
    const mean = main.growthSum / main.growthCount
    parts.push(
      `+tok/req mean ${formatTokens(mean)}, max ${formatTokens(main.growthMax)}`,
    )
  }

  return `main: ${parts.join(' | ')}`
}

function contextPart(usage: UsageSnapshot | null): string {
  if (usage === null || usage.tokens === null) {
    return 'n/a'
  }

  const percent = usage.percent === null ? '' : ` (${usage.percent}%)`

  return `${formatTokens(usage.tokens)}/${formatTokens(usage.window)}${percent}`
}
