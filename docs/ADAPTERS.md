# Writing a source adapter

`agentslog` can index transcripts from any agent, not just Claude Code. Support
for a new source is a **source adapter**: a small module that knows how to find
that tool's transcripts and turn each one into the shared `ParsedSession` shape.

This is a stable, documented contract — you can plug in a parser for a
proprietary or local agent without touching the rest of the codebase.

## The contract

An adapter implements the `SourceAdapter` interface
(`src/parser/sources/types.ts`):

```ts
import { defineAdapter } from './contract.js';

export const myAdapter = defineAdapter({
  name: 'my-agent',          // stored on every session row; lowercase, stable
  label: 'My Agent',         // shown in ingest output
  experimental: true,        // until validated against real-world data

  // Does this source's data exist / is it configured on this machine?
  isAvailable() {
    return fs.existsSync(myStorageDir());
  },

  // Enumerate the units to parse (files or directories).
  discover() {
    return listMyTranscripts().map((filePath) => ({
      filePath,
      projectHash: deriveStableProjectKey(filePath),
    }));
  },

  // Parse one unit into zero or more sessions. Returning an array lets a single
  // file contain multiple sessions (as Aider histories do).
  async parse(unit) {
    return parseMyTranscript(unit.filePath); // -> ParsedSession[]
  },
});
```

Register it in `src/parser/sources/index.ts` by adding it to `ALL_ADAPTERS`.

## Producing a `ParsedSession`

Your `parse` must return objects matching `ParsedSession`
(`src/parser/types.ts`). The rules the ingest boundary enforces
(`validateParsedSession`):

| Field | Rule |
|-------|------|
| `id` | Non-empty, **stable across re-ingests** and globally unique. Re-parsing the same transcript must yield the same id (idempotent ingest). |
| `source` | Your adapter's `name`. |
| `projectHash` | Non-empty, stable grouping key for the project. |
| `parentSessionId` | `null` for top-level sessions, or the id of the spawning session for sub-agents. Must not equal `id`. |
| `startedAt` | Non-empty ISO-8601 timestamp. |
| token / count fields | Finite, non-negative numbers. |
| `toolCalls[].sequenceNum` | Non-negative integer, in execution order. |
| `toolCalls[].toolName` | Non-empty. |
| file paths | **POSIX-normalized** — no backslashes. Use `normalizePath()` from `claude-code.ts`. |

### Guidelines

- **Stream large files.** Use `readline` for line-oriented formats; guard JSON
  files with a size check before `JSON.parse`.
- **Never throw on malformed input.** Skip a bad line/record and continue.
- **Tokens are the sum of all request usage** (what was billed), matching the
  Claude Code adapter's accounting.
- **Degrade gracefully.** If a field isn't available in a given version of the
  format, leave it `null`/`0` rather than guessing.

## Testing your adapter

Run representative real transcripts through your parser and assert the result,
then pass it through the contract validator:

```ts
import { validateParsedSession } from '../src/parser/sources/contract.js';

const [session] = parseMyTranscript(fixturePath);
expect(validateParsedSession(session)).toEqual([]); // contract holds
expect(session.inputTokens).toBe(/* known value */);
```

See `test/sources.test.ts` and `test/contract.test.ts` for patterns. Don't
commit third-party transcript data — encode the format as a synthetic fixture.
