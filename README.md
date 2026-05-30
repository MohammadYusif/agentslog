# agentslog

**Your Claude Code history is a database. Query it like one.**

Every Claude Code session writes a full JSONL transcript to `~/.claude/projects/` — every tool call, file edit, token count, and error. That data is already on your disk. You just can't ask it anything.

`agentslog` indexes all of it into a local SQLite database and gives you a CLI to query across every session you've ever run.

```
$ agentslog query --file CLAUDE.md

sessions touching CLAUDE.md

SESSION ID    TITLE                           PROJECT             MODEL          STARTED    TOKENS
fceb63d2      Analyze PR merge rates and re…  githubmaxxing       sonnet-4-6      1h ago    145.5k
ea2ddef7      Create claude.md with agent w…  githubmaxxing       sonnet-4-6      2d ago      519k
5417574a      Assess Azure deployment proce…  pointly             sonnet-4-6      5d ago     59.3k
…
17 session(s)
```

No cloud. No SDK. No account. It runs entirely on your machine and works on your existing history the moment you install it.

---

## Why

You ran an agent on your repo last week and it touched something it shouldn't have. Which session was that? You've burned through your token budget and have no idea where. You want to know which files your agents keep coming back to, or compare how two runs of the same task diverged.

The transcripts hold all the answers. `agentslog` makes them queryable.

```
$ agentslog stats

PERIOD      all time
SESSIONS    35
TOKENS      5.1M   (in: 160.1k  out: 4.9M  cached: 614M)
TOOLS       4,102  (errors: 186, 4.5%)

TOP FILES                         TOUCHES
page.tsx                          118
translations.ts                   49
CLAUDE.md                         34
PRs.md                            29

TOP TOOLS                         CALLS
Bash                              1,055
Read                              953
Edit                              857
Write                             279
```

---

## Install

```bash
git clone https://github.com/MohammadYusif/agentslog.git
cd agentslog
npm install
npm run build
npm link          # installs the `agentslog` binary globally
```

Requires Node.js ≥ 20.

Then index your history:

```bash
agentslog ingest
```

That's it. Everything below works against your real sessions immediately.

---

## Commands

```bash
agentslog ingest                       # index every session transcript
agentslog watch                        # daemon: index new sessions as they land

agentslog sessions                     # list recent sessions
agentslog sessions --last 7d           # only the last 7 days
agentslog sessions --project pointly   # filter by project
agentslog sessions --json              # machine-readable

agentslog query --file auth.ts         # every session that touched auth.ts
agentslog query --tool Agent           # every session that spawned a sub-agent

agentslog stats                        # tokens / tools / files, aggregated
agentslog stats --last 30d

agentslog show 4834771a                # full detail of one session (id prefix)
agentslog diff 4834771a ad6a413b       # compare two sessions side by side
```

`--last` accepts `Ns`, `Nm`, `Nh`, `Nd`, `Nw`.

### `show` — the full picture of a single run

```
$ agentslog show fceb63d2

Analyze PR merge rates and rejection reasons

Session         fceb63d2-0975-48c8-9b0c-1e10ca3c3a53
Project         C:\Users\Psycho\Desktop\githubmaxxing
Model           sonnet-4-6
Duration        1h 16m
User turns      9

Tokens
  Billed in     5,754
  Output        140,022
  Cache         read 9.6M, created 476.1k

Tool calls: 61 (10 errors)
  Bash            25
  Edit            15
  Agent           8
  …

Files touched: 3
  FILE                          R    W    E
  greedy-skipping-micali.md     1    1    10
  CLAUDE.md                     2    0    5
  PRs.md                        1    0    0
```

### `diff` — how two runs differed

```
$ agentslog diff fceb63d2 4834771a

              A: fceb63d2               B: 4834771a
title         Analyze PR merge rates …  Run project opened in editor
model         sonnet-4-6                opus-4-8
tokens        146.8k                    116.1k
tool calls    63                        40

Tool usage (A vs B)
  Bash            27    11    -16
  Edit            15    1     -14
  PowerShell      0     21    +21
```

---

## How it works

- **It's just your data.** `agentslog` never makes a network call. It reads the JSONL files Claude Code already writes, parses them, and stores a structured index locally. Delete the database and re-`ingest` any time.
- **Streaming parser.** Transcripts are read line-by-line via Node's `readline`, so multi-megabyte sessions index with constant memory. Partially-written or corrupt lines (from a crash or `Ctrl+C` mid-session) are skipped silently rather than halting the ingest.
- **Honest token accounting.** `input_tokens` is the sum of every assistant usage block — what you were actually billed. Because every request re-sends the full history, this is large by design, and it's the number that matters for cost.
- **Idempotent.** Re-ingesting a session replaces its rows atomically in one transaction. Run `ingest` or `watch` as often as you like; nothing duplicates.
- **Safe under concurrency.** The database runs in WAL mode with a busy timeout, so the `watch` daemon and a manual query can hit it at the same time without locking each other out.

## Storage

The database lives in your OS application-data directory (resolved via `env-paths`), never inside `~/.claude/` — so a Claude Code update can't wipe it. On Windows that's `%LOCALAPPDATA%\agentslog\`.

## Development

```bash
npm run dev        # rebuild on change
npm test           # vitest suite
```

---

## Limitations (v0.1)

- **Sub-agent activity isn't rolled up yet.** Sub-agent (sidechain) transcripts share their parent's session id, so indexing them naively would overwrite the parent. For now they're skipped — stats reflect the main session thread. Attributing sub-agent work to the parent is the headline item for v0.2.
- **Claude Code only.** Aider / Cline / Continue support is on the roadmap once the Claude Code path is rock-solid.
- **No dollar costs.** Per-model pricing shifts too often to bake in reliably.
- **Terminal only.** Plain colored output — no web UI or TUI.

## License

MIT
