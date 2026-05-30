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
      { "hooks": [{ "type": "command", "command": "agentslog hook ingest" }] }
    ]
  }
}
```

### `hook check` (PreToolUse) — error avoidance

Before a `Bash` command runs, agentslog checks whether the same kind of command
has failed before. If so, it injects a non-blocking advisory the agent sees as
context — for example:

```
⚠ agentslog memory: you (or a past session) hit 1 similar Bash failure(s) before:
- 15h ago: `ls "C:/…/src" -Recurse -Name` → Exit code 2: ls: unknown option -- e
Consider adjusting before running this.
```

It never blocks execution (always exits 0) and stays fast (a single indexed
read-only query). Add more `matcher`s (`Edit`, `Write`) to cover file tools too.

### `hook ingest` (Stop) — real-time freshness

Cross-session memory only works if the index is current. Running `hook ingest`
on `Stop`/`SessionEnd` re-indexes as soon as a session finishes, so the next
session (and the MCP tools) see it immediately.

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

## Putting it together

A complete "agent with memory" setup:

1. `claude mcp add agentslog -- agentslog mcp`
2. The `PreToolUse` + `Stop` hooks above.
3. `AGENTSLOG_INDEX_REASONING=1` in your shell profile (optional, for the *why*).

Everything stays on your machine — no network calls, no account.
