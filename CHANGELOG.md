# Changelog

All notable changes to **agentslog** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.4.1]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.1
[0.4.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.4.0
[0.3.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.3.0
[0.2.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.2.0
[0.1.0]: https://github.com/MohammadYusif/agentslog/releases/tag/v0.1.0
