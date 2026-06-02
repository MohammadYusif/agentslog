# Contributing to agentslog

Thanks for your interest! `agentslog` is a local-first CLI that indexes AI
coding-agent transcripts into SQLite. Contributions of all sizes are welcome.

## Development setup

Requires Node.js ≥ 20 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/MohammadYusif/agentslog.git
cd agentslog
pnpm install
pnpm build
pnpm link --global   # makes the `agentslog` binary available locally
```

## Common tasks

```bash
pnpm test            # run the vitest suite
pnpm typecheck       # tsc --noEmit
pnpm check           # biome lint + format check
pnpm check:fix       # auto-fix lint/format issues
pnpm build           # bundle the CLI with tsup
```

Before opening a pull request, please make sure `pnpm check`, `pnpm typecheck`,
and `pnpm test` all pass. CI runs the same checks on every PR.

## Guidelines

- **Keep it local-first.** No network calls during ingest or query — `agentslog`
  only reads transcript files the agents already wrote.
- **Match the existing style.** Biome enforces formatting and lint rules; run
  `pnpm check:fix` and commit the result.
- **Add tests.** New behavior should come with a vitest fixture. Don't commit
  third-party transcript data — encode formats as synthetic fixtures.
- **Conventional commits.** e.g. `fix: …`, `feat: …`, `docs: …`, `chore: …`.

## Adding support for a new agent

Want `agentslog` to index Cursor, Continue, Cody, or your own in-house agent?
That's a **source adapter** — see [docs/ADAPTERS.md](docs/ADAPTERS.md) for the
formal contract and a worked example. The adapter interface is stable and your
parser is validated at the ingest boundary, so you can plug one in without
touching the core.

## Reporting bugs

Open an issue with the agent/tool, its version, and (if a parser mismatch) a
small redacted snippet of the transcript shape that wasn't handled correctly.
The experimental Cline/Aider/Odysseus adapters especially benefit from real-world
format reports — the Odysseus adapter in particular is not yet validated against
real databases.
