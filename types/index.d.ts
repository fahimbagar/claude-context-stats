export type MainStats = {
  turn: number
  reqs: number
  lastTokens: number | null
  growthSum: number
  growthCount: number
  growthMax: number
  // The tool with the largest result among those run just before the max step.
  growthMaxTool: string | null
  systemBytes: number | null
  msgsBytes: number | null
}

export type ToolResultSize = {
  tool: string
  bytes: number
}

export type Run = {
  // Order first seen, and the main turn it started in.
  seq: number
  turn: number
  // null while $.agent.list() doesn't know the id: Claude Code's own runs
  // (compaction, memory) never appear there.
  type: string | null
  description: string
  parentId: string | null
  reqs: number
  peakTokens: number
  tokensIn: number
  tokensOut: number
  msgsBytes: number | null
  returnedBytes: number | null
}

export type UsageSnapshot = {
  tokens: number | null
  window: number
  percent: number | null
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-stats': {
      main: MainStats
      runs: Record<string, Run>
      // Main-loop tool results since the last main request.
      pendingTools: ToolResultSize[]
      usage: UsageSnapshot | null
      isExpanded: boolean
    }
  }
}
