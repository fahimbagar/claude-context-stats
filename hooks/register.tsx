import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { UsageSnapshot } from '../types'
import { bandLines } from './format'
import {
  EMPTY_MAIN,
  applyConversation,
  contextTokens,
  recordMainRequest,
  recordRunRequest,
  recordToolCall,
  returnedBytes,
  utf8Bytes,
} from './stats'

const main = atom({ plugin: 'context-stats', key: 'main' } as const, EMPTY_MAIN)
const runs = atom({ plugin: 'context-stats', key: 'runs' } as const, {})
const usage = atom({ plugin: 'context-stats', key: 'usage' } as const, null)
const pendingTools = atom({ plugin: 'context-stats', key: 'pendingTools' } as const, [])
const tools = atom({ plugin: 'context-stats', key: 'tools' } as const, [])
const toolsExpanded = atom(
  { plugin: 'context-stats', key: 'toolsExpanded' } as const,
  false,
)
const subagentsExpanded = atom(
  { plugin: 'context-stats', key: 'subagentsExpanded' } as const,
  false,
)

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
          await refreshUsage($)
        } else {
          await recordRun($, agentId, stepUsage)
        }
      })
    }

    return response
  })

  // The .catch hands back the settled call through next(e), so a failure in
  // this hook never reruns or blocks the tool.
  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const called = await next(e)

    if (e.agentId === undefined && called.deny === undefined) {
      await guard($, 'tool.call', async () => {
        const durationMs = (await $.clock.now()) - startedAt
        const bytes = utf8Bytes(called.text ?? JSON.stringify(called.result ?? null))
        const isError = called.isError === true
        const { turn } = await read($, main)

        await update($, pendingTools, results => [...results, { tool: e.tool, bytes }])
        await update($, tools, all =>
          recordToolCall(all, turn, e.tool, bytes, isError, durationMs),
        )
      })
    }

    return called
  }).catch((_, e, next) => next(e))

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
        await refreshUsage($)
        await appendLog($)
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
        await update($, tools, () => [])
      })
    }

    return ended
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stats = await read($, main)

    if (e.props.hasSurvey || stats.reqs === 0) {
      return next(e)
    }

    const runList = await read($, runs)
    const toolList = await read($, tools)
    const expanded = {
      tools: await read($, toolsExpanded),
      subagents: await read($, subagentsExpanded),
    }
    const lines = bandLines(stats, runList, toolList, await read($, usage), expanded)
    const { Box, Button, Text } = $.ui.resolve(e)
    const toggle = (key: string, hotkey: string, isOpen: boolean, onPress: () => void) => (
      <Button
        key={key}
        hotkey={hotkey}
        plain
        dimColor
        label={`${isOpen ? 'collapse' : 'expand'} ${key}`}
        onPress={onPress}
      />
    )
    // A key only shows when its section has a line to reveal.
    const toggles = [
      ...(toolList.length > 0
        ? [
            toggle('tools', 't', expanded.tools, () =>
              update($, toolsExpanded, value => !value),
            ),
          ]
        : []),
      ...(Object.values(runList).some(run => run.type !== null)
        ? [
            toggle('subagents', 's', expanded.subagents, () =>
              update($, subagentsExpanded, value => !value),
            ),
          ]
        : []),
    ]

    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        {toggles.length > 0 ? (
          <Box flexDirection="row" gap={3}>
            {toggles}
          </Box>
        ) : null}
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

async function refreshUsage($: EngineInterface): Promise<void> {
  const current = await $.session.usage()
  const snapshot: UsageSnapshot = {
    tokens: current.context.tokens ?? null,
    window: current.context.window,
    percent: current.context.percent ?? null,
    costUsd: current.cost?.usd ?? null,
  }

  await update($, usage, () => snapshot)
}

// Opt-in: a line is written only when the file already exists.
async function appendLog($: EngineInterface): Promise<void> {
  const path = await logPath($)

  if (path === null || !(await $.fs.exists(path))) {
    return
  }

  const line = JSON.stringify({
    at: new Date(await $.clock.now()).toISOString(),
    sessionId: await $.session.id(),
    main: await read($, main),
    usage: await read($, usage),
    runs: await read($, runs),
    tools: await read($, tools),
  })
  // $.fs has no append. tee -a opens the file O_APPEND, so lines from two
  // sessions sharing the log don't overwrite each other.
  const appended = await $.process.run(['tee', '-a', path], { stdin: `${line}\n` })

  if (appended.exitCode !== 0) {
    throw new Error(`tee -a ${path} exited ${appended.exitCode}: ${appended.stderr}`)
  }
}

// Beside Claude Code's own config: CLAUDE_CONFIG_DIR when set, else ~/.claude.
async function logPath($: EngineInterface): Promise<string | null> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')

  if (configDir !== undefined && configDir !== '') {
    return `${configDir}/context-stats.jsonl`
  }

  const home = await $.env.get('HOME')

  return home === undefined ? null : `${home}/.claude/context-stats.jsonl`
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
