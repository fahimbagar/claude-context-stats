import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { mainLine } from './format'
import { EMPTY_MAIN, contextTokens, recordMainRequest } from './stats'

const main = atom({ plugin: 'context-stats', key: 'main' } as const, EMPTY_MAIN)
const usage = atom({ plugin: 'context-stats', key: 'usage' } as const, null)

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    const started = await next(e)

    if (e.agentId === undefined) {
      await guard($, 'turn.start', () =>
        update($, main, m => ({ ...m, turn: m.turn + 1 })),
      )
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const stepUsage = response.usage

    if (e.agentId === undefined && stepUsage !== null) {
      await guard($, 'turn.step', async () => {
        await update($, main, m => recordMainRequest(m, contextTokens(stepUsage)))
        await refreshStatus($)
      })
    }

    return response
  })
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const current = await $.session.usage()
  const snapshot: UsageSnapshot = {
    tokens: current.context.tokens ?? null,
    window: current.context.window,
    percent: current.context.percent ?? null,
    costUsd: current.cost?.usd ?? null,
  }

  await update($, usage, () => snapshot)
  $.ui.status(mainLine(await read($, main), snapshot))
}

// The stats are a side view. A failure is logged to the debug log and never
// holds up the session.
async function guard(
  $: EngineInterface,
  where: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work()
  } catch (err) {
    $.ui.log(`context-stats: ${where}: ${String(err)}`, { to: 'debug' })
  }
}
