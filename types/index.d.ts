export type MainStats = {
  turn: number
  reqs: number
  lastTokens: number | null
  growthSum: number
  growthCount: number
  growthMax: number
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
      usage: UsageSnapshot | null
    }
  }
}
