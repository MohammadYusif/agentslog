# Changelog

All notable changes to **agentslog** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.5.1]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.5.1
[0.5.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.5.0
[0.4.1]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.1
[0.4.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.0
[0.3.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.3.0
[0.2.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.2.0
[0.1.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.1.0
