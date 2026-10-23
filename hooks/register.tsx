import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { bandLines, mainLine } from './format'
import {
  EMPTY_MAIN,
  applyConversation,
  contextTokens,
  recordMainRequest,
  recordRunRequest,
  returnedBytes,
  utf8Bytes,
} from './stats'

const main = atom({ plugin: 'context-stats', key: 'main' } as const, EMPTY_MAIN)
const runs = atom({ plugin: 'context-stats', key: 'runs' } as const, {})
const usage = atom({ plugin: 'context-stats', key: 'usage' } as const, null)
const pendingTools = atom({ plugin: 'context-stats', key: 'pendingTools' } as const, [])
const isExpanded = atom({ plugin: 'context-stats', key: 'isExpanded' } as const, false)

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
    const agentId = e.agentId

    if (stepUsage !== null) {
      await guard($, 'turn.step', async () => {
        if (agentId === undefined) {
          const toolResults = await read($, pendingTools)

          await update($, main, m =>
            recordMainRequest(m, contextTokens(stepUsage), toolResults),
          )
          await update($, pendingTools, () => [])
          await refreshStatus($)
        } else {
          await recordRun($, agentId, stepUsage)
        }
      })
    }

    return response
  })

  on('tool.call', async ($, e, next) => {
    const called = await next(e)

    if (e.agentId === undefined && called.deny === undefined) {
      await guard($, 'tool.call', () => {
        const bytes = utf8Bytes(called.text ?? JSON.stringify(called.result ?? null))

        return update($, pendingTools, results => [...results, { tool: e.tool, bytes }])
      })
    }

    return called
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
    const agentId = e.agentId

    await guard($, 'turn.complete', async () => {
      await measureConversation($, agentId)

      if (agentId === undefined) {
        await refreshStatus($)
      }
    })

    return completed
  })

  // /clear starts a new conversation in the same process: start counting again.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)

    if (e.reason === 'clear') {
      await guard($, 'session.end', async () => {
        await update($, main, () => EMPTY_MAIN)
        await update($, runs, () => ({}))
        await update($, usage, () => null)
        await update($, pendingTools, () => [])
        $.ui.status(undefined)
      })
    }

    return ended
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stats = await read($, main)

    if (e.props.hasSurvey || stats.reqs === 0) {
      return next(e)
    }

    const expanded = await read($, isExpanded)
    const lines = bandLines(stats, await read($, runs), await read($, usage), expanded)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        <Button
          key="toggle"
          hotkey="s"
          plain
          dimColor
          label={expanded ? 'collapse' : 'expand'}
          onPress={() => update($, isExpanded, value => !value)}
        />
      </Box>
    )
  })
}

async function recordRun(
  $: EngineInterface,
  agentId: string,
  stepUsage: ModelUsage,
): Promise<void> {
  const known = (await read($, runs))[agentId]
  // $.agent.list() drops an agent seconds after it ends, so the label is
  // looked up while the run is still going.
  const info =
    known?.type != null
      ? undefined
      : (await $.agent.list()).find(agent => agent.id === agentId)
  const { turn } = await read($, main)

  await update($, runs, all => recordRunRequest(all, agentId, info, turn, stepUsage))
}

// Measures one conversation (main, or a subagent's) as its next request
// would carry it, compaction applied, and what its Agent calls got back.
async function measureConversation(
  $: EngineInterface,
  agentId: string | undefined,
): Promise<void> {
  const api =
    agentId === undefined
      ? await $.session.messages({ as: 'api' })
      : await $.session.messages({ agentId, as: 'api' })
  const rows =
    agentId === undefined
      ? await $.session.messages()
      : await $.session.messages({ agentId })
  const bytes = Array.isArray(api) ? utf8Bytes(JSON.stringify(api)) : null
  const returned = Array.isArray(rows) ? returnedBytes(rows) : new Map<string, number>()

  if (agentId === undefined) {
    await update($, main, m => ({ ...m, msgsBytes: bytes }))
  }

  await update($, runs, all => applyConversation(all, agentId, bytes, returned))
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
