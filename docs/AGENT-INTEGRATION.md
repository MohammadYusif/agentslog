# Give your agent a memory

AI coding agents are stateless — every session starts from zero, with no memory
of what a past run decided, broke, or learned. `agentslog` already turns that
history into a queryable database; this guide wires it back **into** the agent
so it can use that memory mid-task.

There are two integration surfaces, and they complement each other:

| | What it does | Mechanism |
|---|---|---|
| **MCP server** | Lets the agent *pull* its history on demand (past errors, file history, reasoning, stats) | `agentslog mcp` |
| **Hooks** | *Push* a warning before a known-bad action, and keep the index fresh | `agentslog hook …` |

---

## 1. MCP server

Expose agentslog's read tools to any MCP-capable agent. For Claude Code:

```bash
claude mcp add agentslog -- agentslog mcp
```

This registers a server that, on start, refreshes the index and then serves
these read-only tools over stdio:

| Tool | When the agent reaches for it |
|------|-------------------------------|
| `recent_errors` | Before a tricky command/edit — "have I failed this before?" |
| `find_sessions_by_file` | Before editing a file — "what happened here last time?" |
| `get_session` | "Show me exactly what that past run did." |
| `search_reasoning` | "*Why* did a past run choose this approach?" (needs reasoning indexing) |
| `list_sessions` / `find_sessions_by_tool` / `get_stats` | Orientation, locating work, spend/activity |

The server opens the database **read-only**, so it never contends with a
concurrent write (e.g. the `Stop` hook below) — WAL mode handles the rest.

Pass `--no-ingest` to skip the on-start refresh (e.g. if a `watch` daemon or the
`Stop` hook already keeps the index current).

---

## 2. Hooks

Add to your `~/.claude/settings.json` (or a project `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "agentslog hook check" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agentslog hook reflect" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "agentslog hook session-start" }] }
    ]
  }
}
```

### `hook check` (PreToolUse) — error avoidance + lesson recall

Before a `Bash` command runs, agentslog surfaces (a) any **lesson** you've
recorded that matches it and (b) whether the same kind of command has failed
before — as a non-blocking advisory:

```
agentslog memory:
📌 Lesson(s) you've recorded for this:
- On Windows use Get-ChildItem, not ls -Recurse
⚠ 1 similar Bash failure(s) before:
- 15h ago: `ls "C:/…/src" -Recurse -Name` → Exit code 2: ls: unknown option -- e
Consider this before running.
```

It never blocks (always exits 0) and stays fast (read-only, indexed). Add more
`matcher`s (`Edit`, `Write`) to cover file tools too.

### `hook reflect` (Stop) — refresh **and learn**

`hook reflect` refreshes the index when a session ends *and* learns from it: if a
command failed the exact same way 3+ times, it records a high-precision lesson
automatically. (Use `hook ingest` instead if you only want the refresh.)

### `hook session-start` (SessionStart) — recall up front

At the start of each session, agentslog injects the top 5 lessons for this
project (plus global ones, ranked by usefulness) and — if your last session here
was flagged inefficient — nudges the agent to record what it learned.

---

## 3. Reasoning indexing (opt-in)

`search_reasoning` and `agentslog reasoning` need the agent's *thinking* blocks
indexed. This is **off by default** (thinking can be large and sensitive). Turn
it on per ingest:

```bash
AGENTSLOG_INDEX_REASONING=1 agentslog ingest      # one-off
agentslog ingest --reasoning                       # same thing
```

Or set `AGENTSLOG_INDEX_REASONING=1` in the environment your `hook ingest` /
`mcp` runs in to capture it automatically. The text is stored in a local FTS5
index; run `agentslog db vacuum` occasionally to reclaim space as it churns.

---

## 4. Self-improvement (learning from mistakes)

agentslog detects inefficient runs and turns the lessons into recallable rules.

**See what went wrong:**

```bash
agentslog review --last 7d        # flag sessions with failures / repeats / waste
agentslog review <session-id>     # full report for one session
```

**Lessons** are the durable rules. They come from three places:

- **Auto** — `hook reflect` records one when a command fails 3+ times identically.
- **Agent** — via the `record_lesson` MCP tool, the agent saves a non-obvious
  gotcha mid-task (`record_lesson({ rule, tool, trigger, scope })`).
- **You** — `agentslog lesson add --rule "…" --tool Bash --trigger "ls -Recurse"`.

Manage them:

```bash
agentslog lessons                 # list (use --project / --global)
agentslog lesson rm <id>
agentslog lesson export           # markdown to paste into CLAUDE.md (human-curated)
```

Lessons live **only** in the local DB — nothing is ever auto-written to a shared
file. They surface again at `PreToolUse` (matching the action) and `SessionStart`
(top 5 by usefulness), closing the loop.

---

## Putting it together

A complete "agent that remembers and learns" setup:

1. `claude mcp add agentslog -- agentslog mcp`
2. The `PreToolUse` + `Stop` (`reflect`) + `SessionStart` hooks above.
3. `AGENTSLOG_INDEX_REASONING=1` in your shell profile (optional, for the *why*).

Everything stays on your machine — no network calls, no account.
