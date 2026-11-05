import type { MainStats, Run, ToolTally, UsageSnapshot } from '../types'

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

export function formatDuration(ms: number): string {
  if (ms < 9_950) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const seconds = Math.round(ms / 1000)

  if (seconds < 60) {
    return `${seconds}s`
  }

  const pad = (n: number) => String(n).padStart(2, '0')

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`
  }

  return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`
}

export function mainLine(main: MainStats, usage: UsageSnapshot | null): string {
  const parts = [`tok ${contextPart(usage)}`]

  // With no system prompt size (another plugin handled prompt.compose before
  // this one), the messages alone aren't a payload, so they're shown as msg.
  if (main.systemBytes !== null) {
    parts.push(payloadPart(main.systemBytes, main.msgsBytes))
  } else if (main.msgsBytes !== null) {
    parts.push(`msg ${formatBytes(main.msgsBytes)}`)
  }

  parts.push(`req ${main.reqs}`)

  if (main.growthCount > 0) {
    parts.push(`+tok/req ~${formatTokens(main.growthSum / main.growthCount)}`)
  }

  return `main: ${parts.join(' | ')}`
}

// "~" because tool schemas and the request's JSON envelope aren't counted.
function payloadPart(system: number, msgs: number | null): string {
  const msgPart = msgs === null ? 'n/a' : formatBytes(msgs)

  return `payload ~${formatBytes(system + (msgs ?? 0))} (sys ${formatBytes(system)} + msg ${msgPart})`
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

export type Expanded = { tools: boolean; subagents: boolean }

type Row = [label: string, rest: string]

export function bandLines(
  main: MainStats,
  runs: Readonly<Record<string, Run>>,
  tools: readonly ToolTally[],
  usage: UsageSnapshot | null,
  expanded: Expanded,
): string[] {
  const lines = [mainLine(main, usage)]

  if (tools.length > 0) {
    lines.push(toolsLine(main, tools))

    if (expanded.tools) {
      const now = tools.filter(t => t.turn === main.turn)
      const earlier = mergeByTool(tools.filter(t => t.turn !== main.turn))
      lines.push(...nowAndEarlier(now.map(toolRow), earlier.map(toolRow)))
    }
  }

  const all = Object.entries(runs)
    .map(([id, run]) => ({ ...run, id }))
    .sort((a, b) => a.seq - b.seq)
  const subagents = all.filter(run => run.type !== null)
  const internal = all.filter(run => run.type === null)

  if (subagents.length > 0) {
    lines.push(subagentsLine(subagents))

    if (expanded.subagents) {
      const now = subagents.filter(run => run.turn === main.turn)
      const earlier = subagents.filter(run => run.turn !== main.turn)
      lines.push(...nowAndEarlier(runRows(now), runRows(earlier)))
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

// "now" is the running turn, or the one that just ended while idle. Labels
// are padded to one width across both groups so the columns line up.
function nowAndEarlier(now: readonly Row[], earlier: readonly Row[]): string[] {
  const width = Math.max(...[...now, ...earlier].map(([label]) => label.length))
  const render = (rows: readonly Row[]) =>
    rows.map(([label, rest]) => `${label.padEnd(width)}   ${rest}`)

  return [
    ...(now.length > 0 ? ['  now:', ...render(now)] : []),
    ...(earlier.length > 0 ? ['  earlier:', ...render(earlier)] : []),
  ]
}

function toolsLine(main: MainStats, tools: readonly ToolTally[]): string {
  const calls = sum(tools, t => t.calls)
  const errors = sum(tools, t => t.errors)
  const parts = [
    `tools: ${calls === 1 ? '1 call' : `${calls} calls`}`,
    `result ${formatBytes(sum(tools, t => t.bytes))}`,
  ]

  // The biggest jump in main context between two requests, and the tool
  // whose result most likely caused it.
  if (main.growthCount > 0) {
    const cause = main.growthMaxTool === null ? '' : ` (${main.growthMaxTool})`
    parts.push(`max +${formatTokens(main.growthMax)}${cause}`)
  }

  if (errors > 0) {
    parts.push(`err ${errors}`)
  }

  parts.push(`time ${formatDuration(sum(tools, t => t.durationMs))}`)

  return parts.join(' | ')
}

function toolRow(tally: ToolTally): Row {
  const parts = [
    `result ${formatBytes(tally.bytes)}`,
    `largest ${formatBytes(tally.largest)}`,
  ]

  if (tally.errors > 0) {
    parts.push(`err ${tally.errors}`)
  }

  parts.push(`time ${formatDuration(tally.durationMs)}`)

  return [`  ${tally.tool} ×${tally.calls}`, parts.join(' | ')]
}

// One tally per tool across turns, in the order each tool first ran.
function mergeByTool(tallies: readonly ToolTally[]): ToolTally[] {
  const byTool = new Map<string, ToolTally>()

  for (const tally of tallies) {
    const merged = byTool.get(tally.tool)

    byTool.set(
      tally.tool,
      merged === undefined
        ? tally
        : {
            ...merged,
            calls: merged.calls + tally.calls,
            bytes: merged.bytes + tally.bytes,
            largest: Math.max(merged.largest, tally.largest),
            errors: merged.errors + tally.errors,
            durationMs: merged.durationMs + tally.durationMs,
          },
    )
  }

  return [...byTool.values()]
}

function subagentsLine(runs: readonly IdentifiedRun[]): string {
  const ids = new Set(runs.map(run => run.id))
  const toMain = runs.filter(run => run.parentId === null || !ids.has(run.parentId))

  return [
    `subagents: ${countRuns(runs)}`,
    volume(runs),
    `msg ${formatBytes(sum(runs, run => run.msgsBytes ?? 0))}`,
    `returned ${formatBytes(sum(toMain, run => run.returnedBytes ?? 0))}`,
  ].join(' | ')
}

// One row per run, children indented under their parent when both are listed.
function runRows(runs: readonly IdentifiedRun[]): Row[] {
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

  return ordered.map(({ run, depth }) => [
    '  '.repeat(depth + 1) + runLabel(run),
    [
      `req ${run.reqs}`,
      tokensInOut(run.tokensIn, run.tokensOut),
      `msg ${optionalBytes(run.msgsBytes)}`,
      `returned ${optionalBytes(run.returnedBytes)}`,
    ].join(' | '),
  ])
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
    `req ${sum(runs, run => run.reqs)}`,
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
