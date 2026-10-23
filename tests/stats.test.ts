import { expect, test } from 'claude-code/testing'

import { formatBytes, formatTokens } from '../hooks/format'
import { EMPTY_MAIN, recordMainRequest, returnedBytes } from '../hooks/stats'

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
