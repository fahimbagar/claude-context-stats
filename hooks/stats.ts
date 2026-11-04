import type { AgentInfo, ModelUsage, SessionMessage } from 'claude-code'

import type { MainStats, Run, ToolResultSize, ToolTally } from '../types'

export const EMPTY_MAIN: MainStats = {
  turn: 0,
  reqs: 0,
  lastTokens: null,
  growthSum: 0,
  growthCount: 0,
  growthMax: 0,
  growthMaxTool: null,
  systemBytes: null,
  msgsBytes: null,
}

export function contextTokens(usage: ModelUsage): number {
  return (
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  )
}

export function recordMainRequest(
  main: MainStats,
  tokens: number,
  toolResults: readonly ToolResultSize[],
): MainStats {
  const counted = { ...main, reqs: main.reqs + 1, lastTokens: tokens }

  // A smaller context than last time means it was compacted. Restart from
  // the new size instead of recording a negative step.
  if (main.lastTokens === null || tokens < main.lastTokens) {
    return counted
  }

  const growth = tokens - main.lastTokens

  return {
    ...counted,
    growthSum: main.growthSum + growth,
    growthCount: main.growthCount + 1,
    ...(growth > main.growthMax && {
      growthMax: growth,
      growthMaxTool: largestTool(toolResults),
    }),
  }
}

// Several tools can run in parallel before one request; the largest result
// is the likeliest cause of the jump.
function largestTool(toolResults: readonly ToolResultSize[]): string | null {
  let largest: ToolResultSize | null = null

  for (const result of toolResults) {
    if (largest === null || result.bytes > largest.bytes) {
      largest = result
    }
  }

  return largest?.tool ?? null
}

export function recordToolCall(
  tallies: readonly ToolTally[],
  turn: number,
  tool: string,
  bytes: number,
  isError: boolean,
  durationMs: number,
): ToolTally[] {
  const index = tallies.findIndex(t => t.turn === turn && t.tool === tool)
  const tally = tallies[index] ?? {
    turn,
    tool,
    calls: 0,
    bytes: 0,
    largest: 0,
    errors: 0,
    durationMs: 0,
  }
  const counted: ToolTally = {
    ...tally,
    calls: tally.calls + 1,
    bytes: tally.bytes + bytes,
    largest: Math.max(tally.largest, bytes),
    errors: tally.errors + (isError ? 1 : 0),
    durationMs: tally.durationMs + durationMs,
  }

  return index === -1
    ? [...tallies, counted]
    : tallies.map((t, i) => (i === index ? counted : t))
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function recordRunRequest(
  runs: Readonly<Record<string, Run>>,
  agentId: string,
  info: AgentInfo | undefined,
  mainTurn: number,
  usage: ModelUsage,
): Record<string, Run> {
  const run = runs[agentId] ?? newRun(Object.keys(runs).length, mainTurn)
  const labelled = info === undefined ? run : withLabel(run, info)
  const tokens = contextTokens(usage)

  return {
    ...runs,
    [agentId]: {
      ...labelled,
      reqs: run.reqs + 1,
      peakTokens: Math.max(run.peakTokens, tokens),
      tokensIn: run.tokensIn + tokens,
      tokensOut: run.tokensOut + usage.output_tokens,
    },
  }
}

export function withLabel(run: Run, info: AgentInfo): Run {
  return {
    ...run,
    type: info.type,
    description: info.description,
    parentId: info.parentId ?? null,
  }
}

function newRun(seq: number, turn: number): Run {
  return {
    seq,
    turn,
    type: null,
    description: '',
    parentId: null,
    reqs: 0,
    peakTokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    msgsBytes: null,
    returnedBytes: null,
  }
}

// What each finished Agent call handed back to the conversation that made it,
// by the id of the agent it spawned.
export function returnedBytes(rows: readonly SessionMessage[]): Map<string, number> {
  const returned = new Map<string, number>()

  for (const row of rows) {
    for (const use of row.toolUses) {
      if (use.agentId !== undefined && use.text !== undefined) {
        returned.set(use.agentId, utf8Bytes(use.text))
      }
    }
  }

  return returned
}

export function applyConversation(
  runs: Readonly<Record<string, Run>>,
  agentId: string | undefined,
  msgsBytes: number | null,
  returned: ReadonlyMap<string, number>,
): Record<string, Run> {
  const updated = { ...runs }
  const own = agentId === undefined ? undefined : updated[agentId]

  if (agentId !== undefined && own !== undefined && msgsBytes !== null) {
    updated[agentId] = { ...own, msgsBytes }
  }

  for (const [childId, bytes] of returned) {
    const child = updated[childId]

    if (child !== undefined) {
      updated[childId] = { ...child, returnedBytes: bytes }
    }
  }

  return updated
}
