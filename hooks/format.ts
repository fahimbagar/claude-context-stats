import type { MainStats, Run, UsageSnapshot } from '../types'

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
  const parts = [`tok ${contextPart(usage)}`]

  if (main.systemBytes !== null || main.msgsBytes !== null) {
    parts.push(payloadPart(main.systemBytes, main.msgsBytes))
  }

  parts.push(`reqs ${main.reqs}`)

  if (main.growthCount > 0) {
    const mean = main.growthSum / main.growthCount
    parts.push(
      `+tok/req mean ${formatTokens(mean)}, max ${formatTokens(main.growthMax)}`,
    )
  }

  return `main: ${parts.join(' | ')}`
}

// "~" because tool schemas and the request's JSON envelope aren't counted.
function payloadPart(system: number | null, msgs: number | null): string {
  const total = (system ?? 0) + (msgs ?? 0)
  const show = (n: number | null) => (n === null ? 'n/a' : formatBytes(n))

  return `payload ~${formatBytes(total)} (system ${show(system)} + msgs ${show(msgs)})`
}

function contextPart(usage: UsageSnapshot | null): string {
  if (usage === null || usage.tokens === null) {
    return 'n/a'
  }

  const percent = usage.percent === null ? '' : ` (${usage.percent}%)`

  return `${formatTokens(usage.tokens)}/${formatTokens(usage.window)}${percent}`
}

type IdentifiedRun = Run & { id: string }

const DESCRIPTION_WIDTH = 30

export function bandLines(
  main: MainStats,
  runs: Readonly<Record<string, Run>>,
  usage: UsageSnapshot | null,
  isExpanded: boolean,
): string[] {
  const lines = [mainLine(main, usage)]
  const all = Object.entries(runs)
    .map(([id, run]) => ({ ...run, id }))
    .sort((a, b) => a.seq - b.seq)
  const subagents = all.filter(run => run.type !== null)
  const internal = all.filter(run => run.type === null)

  if (subagents.length > 0) {
    lines.push(subagentsLine(subagents))

    // main.turn is the running turn, or the one that just ended while idle.
    const current = subagents.filter(run => run.turn === main.turn)
    const earlier = subagents.filter(run => run.turn !== main.turn)

    if (current.length > 0) {
      lines.push('  this turn:', ...runLines(current))
    }

    if (earlier.length > 0) {
      lines.push('  earlier:', ...(isExpanded ? runLines(earlier) : typeLines(earlier)))
    }
  }

  if (internal.length > 0) {
    lines.push(`internal: ${countRuns(internal)} | ${volume(internal)}`)
  }

  if (usage !== null && usage.costUsd !== null) {
    lines.push(`session: $${usage.costUsd.toFixed(2)}`)
  }

  return lines
}

function subagentsLine(runs: readonly IdentifiedRun[]): string {
  const ids = new Set(runs.map(run => run.id))
  const toMain = runs.filter(run => run.parentId === null || !ids.has(run.parentId))

  return [
    `subagents: ${countRuns(runs)}`,
    volume(runs),
    `msgs ${formatBytes(sum(runs, run => run.msgsBytes ?? 0))}`,
    `returned to main ${formatBytes(sum(toMain, run => run.returnedBytes ?? 0))}`,
  ].join(' | ')
}

// One line per run, children indented under their parent when both are listed.
function runLines(runs: readonly IdentifiedRun[]): string[] {
  const ids = new Set(runs.map(run => run.id))
  const ordered: { run: IdentifiedRun; depth: number }[] = []
  const placed = new Set<string>()
  const visit = (parentId: string | null, depth: number) => {
    for (const run of runs) {
      const isRoot = run.parentId === null || !ids.has(run.parentId)
      const isChild = parentId === null ? isRoot : run.parentId === parentId

      if (isChild && !placed.has(run.id)) {
        placed.add(run.id)
        ordered.push({ run, depth })
        visit(run.id, depth + 1)
      }
    }
  }
  visit(null, 0)

  // Parent links that loop leave runs with no root; list them flat.
  for (const run of runs) {
    if (!placed.has(run.id)) {
      ordered.push({ run, depth: 0 })
    }
  }

  const labels = ordered.map(({ run, depth }) => '  '.repeat(depth + 1) + runLabel(run))
  const width = Math.max(...labels.map(label => label.length))

  return ordered.map(({ run }, i) =>
    [
      `${labels[i]?.padEnd(width)}   reqs ${run.reqs}`,
      `peak tok ${formatTokens(run.peakTokens)}`,
      tokensInOut(run.tokensIn, run.tokensOut),
      `msgs ${optionalBytes(run.msgsBytes)}`,
      `returned ${optionalBytes(run.returnedBytes)}`,
    ].join(' | '),
  )
}

function typeLines(runs: readonly IdentifiedRun[]): string[] {
  const byType = new Map<string, IdentifiedRun[]>()

  for (const run of runs) {
    const type = run.type ?? ''
    byType.set(type, [...(byType.get(type) ?? []), run])
  }

  const labels = [...byType].map(([type, group]) => `  ${type} ×${group.length}`)
  const width = Math.max(...labels.map(label => label.length))

  return [...byType.values()].map((group, i) =>
    [
      `${labels[i]?.padEnd(width)}   ${volume(group)}`,
      `msgs ${formatBytes(sum(group, run => run.msgsBytes ?? 0))}`,
      `returned ${formatBytes(sum(group, run => run.returnedBytes ?? 0))}`,
    ].join(' | '),
  )
}

function runLabel(run: Run): string {
  const description =
    run.description.length > DESCRIPTION_WIDTH
      ? `${run.description.slice(0, DESCRIPTION_WIDTH - 1)}…`
      : run.description

  return `${run.type} "${description}"`
}

function volume(runs: readonly Run[]): string {
  return [
    `reqs ${sum(runs, run => run.reqs)}`,
    tokensInOut(sum(runs, run => run.tokensIn), sum(runs, run => run.tokensOut)),
  ].join(' | ')
}

function tokensInOut(tokensIn: number, tokensOut: number): string {
  return `tok ${formatTokens(tokensIn)} in / ${formatTokens(tokensOut)} out`
}

function countRuns(runs: readonly Run[]): string {
  return runs.length === 1 ? '1 run' : `${runs.length} runs`
}

function optionalBytes(n: number | null): string {
  return n === null ? 'n/a' : formatBytes(n)
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0)
}
