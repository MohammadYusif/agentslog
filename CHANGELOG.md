# Changelog

All notable changes to **agentslog** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.9.0] — 2026-06-10

### Changed

- **PreToolUse advisories no longer replay unrelated failures.** For tool calls
  with no command or file path to match on (Skill, MCP tools, a bare Glob…),
  the hook previously surfaced *every* past failure of that tool. It now emits
  at most a one-line frequency summary, and only when the tool failed ≥ 3 times
  in the last 7 days. Precise matching is unchanged where context exists.

- **Glob/Grep advisories now match on their `path` input.** `buildAdvisory`
  reuses the parser's `extractFilePath`, so the hook compares the same value
  ingest stores in `tool_calls.file_path`.

- **`setup --with-hooks` installs PreToolUse for all tools, not just Bash.**
  Lessons exist for Edit/Write/MCP tools too; the advisory only speaks when it
  has something relevant. Re-running `setup` upgrades a previously installed
  Bash-only matcher in place.

### Fixed

- **No "Read before Write" warning when Write creates a new file.** The
  tool-level "file not read" advisory is skipped when the target file does not
  exist — creating a file requires no prior Read.

- **Bash auto-lessons deduplicate by failure shape.** `reflectOnSession` now
  skips recording when an auto-lesson with the same scope, tool, and trigger
  already exists, instead of accumulating near-identical lessons whose rule
  text differs only in arguments or error detail.

- **`--version` and the MCP server version now come from package.json.** They
  were hardcoded and stale (`0.6.0` and `0.3.0` respectively).

- **Session-id prefix lookup escapes LIKE wildcards.** A prefix containing
  `%` or `_` now matches literally in `show`/`diff`/`get_session`.

- **Stale comments corrected** in `hook.ts` (lesson-hit accounting location,
  auto-lesson threshold) after the 0.8.0 behavior changes.

### Performance

- **`hook check` steady state is one read-only DB open.** `openDbReadonly`
  previously opened a writable connection and ran migration scaffolding on
  every call (i.e. before every tool call in hooked sessions); it now opens
  read-only first and falls back to the writable path only for a fresh or
  stale database. `migrate()` also early-exits on a current schema version.

## [0.7.1] — 2026-06-07

### Fixed

- **`list_lessons` hit tracking is now best-effort.** A transient DB lock
  during hit recording could propagate and fail the entire MCP read. The
  write is now wrapped in a try/catch so the lesson list is always returned.

- **No more double-warning for files with prior "file not read" failures.**
  `buildAdvisory` previously emitted two advisory sections for the same root
  cause when a file had both a per-file match and the tool-level pattern match.
  The pattern scan is now skipped when the per-file match already covered it.

- **`FILE_NOT_READ_PATTERN` constant centralises the matched substring.**
  The string was hardcoded in three places; a single constant now governs it.

- **Tests for the new Edit/Write branches.** Four tests were added covering
  the pattern advisory on new files, the no-double-warn guard, auto-lesson
  recording, and cross-session deduplication in `reflectOnSession`.

## [0.7.0] — 2026-06-07

### Fixed

- **Lesson hits counter now increments via MCP.** The `list_lessons` MCP tool
  previously fetched lessons over a read-only connection and never bumped hit
  counts. Hits now track actual in-session lookups, not just the `SessionStart`
  hook, making the counter meaningful.

- **`hook check` (PreToolUse) now catches the Edit/Write "file not read" pattern
  for any file.** The advisory previously matched Edit/Write errors only by exact
  file path, so it stayed silent for files that hadn't failed before — even when
  dozens of prior sessions hit the same "File has not been read yet" error. The
  hook now does a second pass over all past errors for the tool and emits a
  dedicated warning whenever this pattern is present in history.

- **Auto-reflection now records Edit/Write "file not read" lessons.** The
  `hook reflect` (Stop hook) previously only auto-recorded lessons for repeated
  Bash command failures. Edit and Write failures — the most common recurring error
  class — were invisible to the learning loop. They are now captured when the same
  pattern fires ≥ 2× in a session, deduplicated so only one global lesson is ever
  written per tool.

- **Session-start nudge query now uses the normalized project path.** The
  "previous session was inefficient" nudge queried `project_path` with the raw
  `cwd` from the hook payload, which could silently mismatch the normalized path
  stored in the database. It now uses the already-normalized `project` variable.

## [0.6.0] — 2026-06-02

### Added
- **Experimental Odysseus source adapter.** Ingests sessions from a self-hosted
  Odysseus AI-workspace SQLite database (located via `AGENTSLOG_ODYSSEUS_DB`),
  read directly instead of from transcript files: one session per non-archived
  chat, with tokens and tool/file activity derived from the session columns and
  per-message metadata. Not yet validated against real-world databases —
  best-effort. `agentslog sessions --source odysseus`.

## [0.5.1] — 2026-06-01

### Fixed
- **Time windows now track when activity happened, not when the session
  started.** `errors`, the MCP `recent_errors` tool, and the `review` list
  filtered `--last <window>` on each session's *start* time, so a recent failure
  inside a long-running session (started days ago, still active) was missed — e.g.
  `recent_errors --last 1h` could return nothing despite a failure seconds ago.
  They now window on the tool call's time (`called_at`), falling back to the
  session start only when a call has no timestamp. Session-scoped views (`stats`,
  `sessions`, reasoning search, `impact`) are unchanged — "started in the window"
  is the right semantic there.

## [0.5.0] — 2026-06-01

The **adoption** release: one-command setup, and a way to see it working.

### Added
- **`agentslog setup`** — a transparent, idempotent installer that wires
  agentslog into Claude Code automatically: registers the MCP server at user
  scope (so *every* project gets it), writes a managed instruction block to
  `~/.claude/CLAUDE.md`, and runs an initial ingest. Everything it changes is
  printed. Components are individually selectable (`--no-mcp`, `--no-memory`,
  `--with-hooks`, `--with-reasoning`, `--no-ingest`), with an interactive picker
  (`-i`, Enter = recommended) and a `--dry-run` preview. Hardened: write-permission
  preflight, tolerant `settings.json` parsing (survives comments / trailing
  commas, never clobbers unparseable config), and a managed-block marker so the
  memory edit is re-runnable and reversible.
- **`agentslog impact`** — contrasts your agent activity *before* vs *after* you
  started using agentslog (avg tool calls, tokens, error rate per session). The
  cutover is auto-detected from the first session that called an `mcp__agentslog__*`
  tool, falling back to the recorded setup date; `--since` overrides. Framed
  honestly as a correlation, not a controlled experiment.
- Schema **v5**: a small `meta` key/value table (stores the adoption timestamp).

## [0.4.1] — 2026-06-01

### Changed
- **Cost breakdown.** `stats` (and the MCP `get_stats` tool) now split the
  estimated cost into input / output / cache-write / cache-read. Cache reads
  usually dominate the headline number — showing them separately makes clear
  that prompt caching is *saving* money, not wasting it.

## [0.4.0] — 2026-06-01

The **self-improvement** release: agentslog now detects inefficient runs, distils
durable lessons, and recalls them before the agent repeats a mistake.

### Added
- **`agentslog review [id] [--last]`** — flags inefficient sessions from data
  already captured: high failure rate, repeated identical failures, and
  disproportionate token spend. Heuristics are candidates, not verdicts; a
  thorough research/plan phase (high tokens, lots of reading, no edits) is not
  flagged.
- **Lessons store** (schema v4): durable rules kept in a local table, recalled
  before similar actions. `agentslog lessons` and `lesson add/rm/export`.
  Lessons never auto-write to `CLAUDE.md` — `export` is the human-reviewed path.
- **The learning loop:**
  - `hook reflect` (Stop) — refreshes the index and auto-records a lesson when a
    command fails 3× identically.
  - `hook session-start` (SessionStart) — injects the top 5 lessons (ranked by
    usefulness) and nudges the agent after a flagged run.
  - `hook check` (PreToolUse) — now surfaces matching lessons alongside past errors.
  - MCP tools `record_lesson` (agent-authored, short-lived writable connection),
    `list_lessons`, and `review_session`.
- `agentslog db vacuum` and `AGENTSLOG_DB` to relocate the database.

## [0.3.0] — 2026-05-31

The **agent-integration** release: give your coding agent a memory.

### Added
- **MCP server** (`agentslog mcp`) exposing read-only tools so an agent can query
  its own history mid-task: `recent_errors`, `find_sessions_by_file`,
  `get_session`, `get_stats`, `list_sessions`, `find_sessions_by_tool`,
  `search_reasoning`. Read-only connection avoids lock contention.
- **Hooks** — `hook check` (PreToolUse error-avoidance advisory) and `hook ingest`
  (Stop/SessionEnd real-time refresh), with `docs/AGENT-INTEGRATION.md`.
- **Reasoning indexing** (opt-in, `--reasoning` / `AGENTSLOG_INDEX_REASONING`):
  FTS5 full-text index of `thinking` blocks, searchable via `agentslog reasoning`.

## [0.2.0] — 2026-05-30

The **analytics & ecosystem** release.

### Added
- **Sub-agent rollup** — sidechain transcripts are indexed as their own rows and
  rolled up into the parent (tokens, tools, files, errors).
- **Token cost estimation** — per-model USD estimates in `stats` and `show`,
  overridable via `pricing.json` / `AGENTSLOG_PRICING`.
- **`agentslog errors`** — recent failed tool calls across sessions, for forensics.
- **Experimental Aider & Cline adapters** behind a formalized, validated
  source-adapter contract (`docs/ADAPTERS.md`, `CONTRIBUTING.md`).

### Changed
- Adopted **Biome** (lint + format), **GitHub Actions CI** (Node 20 & 22), and
  migrated package management to **pnpm**.

## [0.1.0] — 2026-05-29

Initial release.

### Added
- Index Claude Code JSONL transcripts into a local SQLite database.
- Commands: `ingest`, `sessions`, `query` (`--file` / `--tool`), `stats`,
  `show`, `diff`, `watch`.
- Streaming line-by-line parser (constant memory, skips corrupt lines), WAL-mode
  database with a busy timeout, idempotent per-session writes, and storage in the
  OS app-data directory via `env-paths`.

[0.6.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.6.0
[0.5.1]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.5.1
[0.5.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.5.0
[0.4.1]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.1
[0.4.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.0
[0.3.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.3.0
[0.2.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.2.0
[0.1.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.1.0
