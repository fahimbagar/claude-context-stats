# context-stats

A Claude Code plugin that shows how big each request is: context tokens, approximate payload bytes, request counts and per-request growth, for the main agent and for every subagent run. It reads the numbers from Claude Code's plugin hooks as requests happen, so nothing is parsed from transcript files and your `settings.json` is never edited.

```
main: tok 84.2k/200k (42%) | payload ~342 KB (system 31 KB + msgs 311 KB) | reqs 31 | +tok/req mean 1.7k, max 20.1k
subagents: 3 runs | reqs 24 | tok 610k in / 14.2k out | msgs 1.8 MB | returned to main 9.4 KB
  this turn:
  Explore "find hook config"   reqs 9 | peak tok 41k | tok 210k in / 4.1k out | msgs 600 KB | returned 2.3 KB
  earlier:
  Explore ×1           reqs 7 | tok 200k in / 5.7k out | msgs 600 KB | returned 3.8 KB
  general-purpose ×1   reqs 8 | tok 210k in / 4.4k out | msgs 600 KB | returned 3.3 KB
session: $2.31
s: expand
```

## Install

Built and tested against Claude Code 2.1.309. The plugin is a mod (a TypeScript hooks module), and that API is early access, so a later Claude Code release may need an update here.

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
| `payload ~342 KB` | System prompt bytes plus the bytes of the messages the next request carries (after compaction). Tool definitions and the JSON envelope aren't counted, hence `~` |
| `reqs` | API requests made by that agent |
| `+tok/req mean, max` | How much the main context grew from one request to the next. A drop from compaction starts the count again instead of counting as negative growth |
| `tok X in / Y out` | For subagents: input tokens summed over all their requests, and output tokens. Each request re-sends the context, so this is volume sent, not context size |
| `peak tok` | The largest single request of that run |
| `msgs` | Bytes of the run's own conversation |
| `returned` | Bytes of the report the run handed back to whoever started it |
| `session` | Cost of the whole session, subagents included |

Subagent runs from the current turn (or the turn that just ended) get a line each. Earlier runs are grouped by agent type. Subagents started by other subagents are indented under their parent. Claude Code's own background runs, such as compaction, are listed as `internal:`.

To expand the block, press `ctrl+x tab` to focus it, then `s`, or click it in fullscreen mode. Expanded, earlier runs get a line each and the max names the tool whose result caused it, e.g. `max 20.1k (Read)`.

`/clear` resets everything.

## Log

To keep a history, create the log file:

```
touch ~/.claude/context-stats.jsonl
```

If `CLAUDE_CONFIG_DIR` is set, the file goes in that directory instead. While the file exists, each main turn appends one JSON line with the main stats, usage and every subagent run. Delete the file to stop logging. Lines are appended with `tee -a`, so the log needs a POSIX system.

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
