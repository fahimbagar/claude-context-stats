import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'context-stats',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 250,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

const MODEL = 'claude-opus-5-5'

// The context size the next turn.step answers with, by loop ('' is main).
const nextTokens = new Map<string, number>()

async function step($: Engine, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: MODEL, messageCount: index + 1, agentId })

  for await (const _chunk of stream) {
    // The plugin's hook runs as the stream is read.
  }

  await stream.result
}

async function complete($: Engine, turnId: string, agentId?: string) {
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId,
    agentId,
    reason: 'answer',
  })
}

test('the band counts main and subagent requests and expands', async ($, on) => {
  // Nothing sits beneath the plugin: these hooks stand for the engine.
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // biome-ignore lint/correctness/useYield: a turn.step hook must be a generator; this stub answers with no chunks
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: nextTokens.get(e.agentId ?? '') ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
        model: MODEL,
      },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'x'.repeat(80_000) }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'Explore', description: 'find hook config', status: 'running' },
    ],
  }))
  on('session.messages', (_, e) => {
    if (e.as === 'api') {
      return { value: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    }

    if (e.agentId !== undefined) {
      return { value: [] }
    }

    return {
      value: [
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { tool_use_id: 't1', tool: 'Agent', input: {}, agentId: 'a1', text: 'found' },
          ],
        },
      ],
    }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 32_000, window: 200_000, percent: 16 },
      rateLimits: [],
      cost: { usd: 0.42 },
    },
  }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  // A guarded failure is reported through $.ui.log; this run should have none.
  const logged: unknown[] = []
  on('ui.log', (_, e) => {
    logged.push(e)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.turn.start({ text: 'go', turnId: 'm1' })
  nextTokens.set('', 10_000)
  await step($, 'm1', 0)

  await $.turn.start({ text: '', turnId: 's1', agentId: 'a1' })
  nextTokens.set('a1', 40_000)
  await step($, 's1', 0, 'a1')
  nextTokens.set('a1', 41_000)
  await step($, 's1', 1, 'a1')
  await complete($, 's1', 'a1')

  await $.tool.call({ tool: 'Read', file_path: '/big' })
  nextTokens.set('', 30_000)
  await step($, 'm1', 1)
  await complete($, 'm1')

  expect(logged).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const mainRow = await ui.find({ type: 'Text', text: /^main:/ })

  expect(mainRow?.text).toBe(
    'main: tok 32k/200k (16%) | payload ~57 B (sys n/a + msg 57 B) | req 2 | +tok/req ~20k, max 20k',
  )
  expect((await ui.find({ type: 'Text', text: /^subagents:/ }))?.text).toBe(
    'subagents: 1 run | req 2 | tok 81k in / 200 out | msg 57 B | returned 5 B',
  )
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toContain(
    'req 2 | tok 81k in / 200 out',
  )
  expect((await ui.find({ type: 'Text', text: /^session:/ }))?.text).toBe('session: $0.42')

  await ui.press({ key: 'toggle' })

  expect((await ui.find({ type: 'Text', text: /^main:/ }))?.text).toContain(
    'max 20k (Read)',
  )
  await ui.unmount()
})
