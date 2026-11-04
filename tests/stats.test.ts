import { expect, test } from 'claude-code/testing'

import { formatBytes, formatDuration, formatTokens } from '../hooks/format'
import {
  EMPTY_MAIN,
  recordMainRequest,
  recordToolCall,
  returnedBytes,
} from '../hooks/stats'

test('token counts step up a unit instead of printing the base', () => {
  expect(formatTokens(850)).toBe('850')
  expect(formatTokens(84_200)).toBe('84.2k')
  expect(formatTokens(200_000)).toBe('200k')
  expect(formatTokens(999_960)).toBe('1M')
  expect(formatTokens(6_100_000)).toBe('6.1M')
})

test('byte sizes use binary units', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(2_355)).toBe('2.3 KB')
  expect(formatBytes(350_000)).toBe('342 KB')
  expect(formatBytes(1_900_000)).toBe('1.8 MB')
})

test('durations read in seconds, minutes, then hours', () => {
  expect(formatDuration(400)).toBe('0.4s')
  expect(formatDuration(8_240)).toBe('8.2s')
  expect(formatDuration(12_400)).toBe('12s')
  expect(formatDuration(72_000)).toBe('1m12s')
  expect(formatDuration(3_720_000)).toBe('1h02m')
})

test('tool calls tally per tool per turn', () => {
  let tallies = recordToolCall([], 1, 'Read', 500, false, 100)
  tallies = recordToolCall(tallies, 1, 'Read', 2_000, true, 300)
  tallies = recordToolCall(tallies, 2, 'Read', 10, false, 5)

  expect(tallies).toEqual([
    { turn: 1, tool: 'Read', calls: 2, bytes: 2_500, largest: 2_000, errors: 1, durationMs: 400 },
    { turn: 2, tool: 'Read', calls: 1, bytes: 10, largest: 10, errors: 0, durationMs: 5 },
  ])
})

test('growth skips the first request and a compaction drop', () => {
  let main = recordMainRequest(EMPTY_MAIN, 10_000, [])
  expect(main.growthCount).toBe(0)

  main = recordMainRequest(main, 12_000, [{ tool: 'Bash', bytes: 100 }])
  main = recordMainRequest(main, 32_000, [
    { tool: 'Bash', bytes: 50 },
    { tool: 'Read', bytes: 80_000 },
  ])
  expect(main).toMatchObject({ growthMax: 20_000, growthMaxTool: 'Read' })

  main = recordMainRequest(main, 5_000, [])
  expect(main).toMatchObject({
    reqs: 4,
    growthCount: 2,
    growthSum: 22_000,
    lastTokens: 5_000,
  })

  main = recordMainRequest(main, 6_000, [{ tool: 'Grep', bytes: 10 }])
  expect(main).toMatchObject({ growthCount: 3, growthMaxTool: 'Read' })
})

test('only answered Agent calls count as returned', () => {
  const returned = returnedBytes([
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 't1', tool: 'Agent', input: {}, agentId: 'a1', text: 'done ✓' },
        { tool_use_id: 't2', tool: 'Agent', input: {}, agentId: 'a2' },
        { tool_use_id: 't3', tool: 'Read', input: {}, text: 'file' },
      ],
    },
  ])

  expect([...returned]).toEqual([['a1', 8]])
})
