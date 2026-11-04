# context-stats

[![CI](https://github.com/fahimbagar/claude-context-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/fahimbagar/claude-context-stats/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that shows how big each request is: context tokens, approximate payload bytes, request counts and per-request growth for the main agent, its tool calls, and every subagent run. It reads the numbers from Claude Code's plugin hooks as requests happen, so nothing is parsed from transcript files and your `settings.json` is never edited.

```
main: tok 84.2k/200k (42%) | payload ~342 KB (sys 31 KB + msg 311 KB) | req 31 | +tok/req ~1.7k
tools: 42 calls | result 1.1 MB | max +20.1k (Read) | err 2 | time 1m12s
subagents: 3 runs | req 24 | tok 610k in / 14.2k out | msg 1.8 MB | returned 9.4 KB
session: $2.31
t: expand tools   s: expand subagents
```

Expanded, each section lists the current turn under `now:` and the rest under `earlier:`:

```
tools: 42 calls | result 1.1 MB | max +20.1k (Read) | err 2 | time 1m12s
  now:
  Read ×6    result 180 KB | largest 78 KB | time 0.4s
  Bash ×3    result 12 KB | largest 9 KB | err 1 | time 8.2s
  earlier:
  Read ×18   result 640 KB | largest 120 KB | time 1.1s
  Grep ×9    result 95 KB | largest 30 KB | time 0.9s
subagents: 3 runs | req 24 | tok 610k in / 14.2k out | msg 1.8 MB | returned 9.4 KB
  now:
  Explore "find hook config"       req 9 | tok 210k in / 4.1k out | msg 600 KB | returned 2.3 KB
  earlier:
  Explore "scan transcripts"       req 7 | tok 200k in / 5.7k out | msg 600 KB | returned 3.8 KB
  general-purpose "draft README"   req 8 | tok 210k in / 4.4k out | msg 600 KB | returned 3.3 KB
```

## Install

Built against Claude Code 2.1.309 and tested on 2.1.318. The plugin is a mod (a TypeScript hooks module), and that API is early access, so a later Claude Code release may need an update here.

From a clone, at the Claude Code prompt:

```
/plugin marketplace add /path/to/claude-context-stats
/plugin install context-stats@context-stats
```

A marketplace added from a folder is read in place: after pulling changes, run `/reload-plugins`.

## What you see

The `main:` line is pinned under the prompt and refreshed after every main-agent request. The full block sits above the prompt and updates as requests finish; byte counts update when a turn ends.

| Field | Meaning |
|---|---|
| `tok 84.2k/200k (42%)` | Tokens of the main agent's last request against the model's context window |
| `payload ~342 KB` | System prompt (`sys`) plus the messages (`msg`) the next request carries, after compaction. Tool definitions and the JSON envelope aren't counted, hence `~` |
| `req` | API requests made by that agent |
| `+tok/req ~1.7k` | Mean growth of the main context from one request to the next. A drop from compaction starts the count again instead of counting as negative growth |
| `result` | Bytes of tool results handed back to the main agent |
| `max +20.1k (Read)` | The biggest jump in main context between two requests, and the tool with the largest result just before it |
| `largest` | The biggest single result of that tool |
| `err` | Tool calls that returned an error. Hidden when there are none |
| `time` | Time spent inside tool calls |
| `tok X in / Y out` | For subagents: input tokens summed over all their requests, and output tokens. Each request re-sends the context, so this is volume sent, not context size |
| `msg` | Bytes of the run's own conversation |
| `returned` | Bytes of the report a run handed back to whoever started it |
| `session` | Cost of the whole session, subagents included |

`tools:` counts the main agent's tool calls only. Tools run by subagents are left out, because their results go into the subagent's context, not the main one.

Collapsed, the block shows one summary line per section. Each section expands on its own key: press `ctrl+x tab` to focus the block, then `t` for tools or `s` for subagents, or click a key in fullscreen mode. A key only appears once its section has something to show. Expanded, tools are grouped by name and subagent runs get a line each. "Now" is the running turn, or the one that just ended. Subagents started by other subagents are indented under their parent. Claude Code's own background runs, such as compaction, are listed as `internal:`.

`/clear` resets everything.

## Log

To keep a history, create the log file:

```
touch ~/.claude/context-stats.jsonl
```

If `CLAUDE_CONFIG_DIR` is set, the file goes in that directory instead. While the file exists, each main turn appends one JSON line with the main stats, usage, tool tallies and every subagent run. Delete the file to stop logging. Lines are appended with `tee -a`, so the log needs a POSIX system.

## Limits

- The payload figure is a lower bound on the HTTP request body. Measuring the exact body would need a logging proxy.
- The system prompt size comes from the last prompt Claude Code composed. If a subagent's system prompt is composed later, the main line may briefly show that size instead.
- Only one plugin draws the band above the prompt, so another plugin that also draws there would be hidden while this one has data.

## Development

```
claude plugin validate .
claude plugin test .
```

Running `claude --plugin-dir .` once writes the API type definitions to `.claude-plugin/types/`, after which `tsc -p .` type-checks the module.

## Credits

The plugin icon is `chart-bar` from [Tabler Icons](https://tabler.io/icons) 3.50.0, MIT licensed, © 2020-2026 Paweł Kuna. Its license is in `.claude-plugin/icon.LICENSE`.
