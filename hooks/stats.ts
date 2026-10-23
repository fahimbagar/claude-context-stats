import type { ModelUsage } from 'claude-code'

import type { MainStats } from '../types'

export const EMPTY_MAIN: MainStats = {
  turn: 0,
  reqs: 0,
  lastTokens: null,
  growthSum: 0,
  growthCount: 0,
  growthMax: 0,
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

export function recordMainRequest(main: MainStats, tokens: number): MainStats {
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
    growthMax: Math.max(main.growthMax, growth),
  }
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
