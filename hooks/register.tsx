import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { mainLine } from './format'
import { EMPTY_MAIN, contextTokens, recordMainRequest, utf8Bytes } from './stats'

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

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    await guard($, 'prompt.compose', () => {
      const bytes = composed.sections.reduce((sum, s) => sum + utf8Bytes(s.text), 0)

      return update($, main, m => ({ ...m, systemBytes: bytes }))
    })

    return composed
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    if (e.agentId === undefined) {
      await guard($, 'turn.complete', async () => {
        // The messages the next request is built from, compaction applied.
        const messages = await $.session.messages({ as: 'api' })
        const bytes = utf8Bytes(JSON.stringify(messages))

        await update($, main, m => ({ ...m, msgsBytes: bytes }))
        await refreshStatus($)
      })
    }

    return completed
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
