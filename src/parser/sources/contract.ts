/**
 * The source-adapter contract.
 *
 * Every adapter ultimately produces {@link ParsedSession} objects that are
 * written verbatim into SQLite. To keep the database trustworthy no matter who
 * wrote the adapter, each parsed session is validated against this contract at
 * the ingest boundary — a buggy adapter is rejected with a clear message rather
 * than silently corrupting the index.
 *
 * Adapter authors: use {@link defineAdapter} for type-safe authoring and run
 * your fixtures through {@link validateParsedSession} in tests.
 */
import type { ParsedSession } from '../types.js';
import type { SourceAdapter } from './types.js';

/**
 * Identity helper that enforces the {@link SourceAdapter} shape at definition
 * site, giving adapter authors immediate type errors and editor completion.
 */
export function defineAdapter(adapter: SourceAdapter): SourceAdapter {
  return adapter;
}

/** A finite, non-negative integer. */
function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** A non-empty string. */
function isNonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

/**
 * Validate a parsed session against the contract. Returns a list of problems;
 * an empty list means the session is valid. Never throws.
 */
export function validateParsedSession(s: ParsedSession): string[] {
  const issues: string[] = [];
  const at = (field: string, msg: string) => issues.push(`${field}: ${msg}`);

  if (!isNonEmpty(s.id)) at('id', 'must be a non-empty string');
  if (!isNonEmpty(s.source)) at('source', 'must be a non-empty string');
  if (!isNonEmpty(s.projectHash)) at('projectHash', 'must be a non-empty string');
  if (!isNonEmpty(s.startedAt)) at('startedAt', 'must be a non-empty ISO timestamp');
  if (s.parentSessionId !== null && typeof s.parentSessionId !== 'string') {
    at('parentSessionId', 'must be a string or null');
  }
  if (s.parentSessionId === s.id && s.id) at('parentSessionId', 'must not equal id (self-parent)');

  for (const f of [
    'inputTokens',
    'outputTokens',
    'lastInputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'toolCallCount',
    'errorCount',
    'userTurnCount',
  ] as const) {
    if (!isCount(s[f])) at(f, 'must be a finite, non-negative number');
  }

  if (!Array.isArray(s.toolCalls)) {
    at('toolCalls', 'must be an array');
  } else {
    s.toolCalls.forEach((tc, i) => {
      if (!Number.isInteger(tc.sequenceNum) || tc.sequenceNum < 0) {
        at(`toolCalls[${i}].sequenceNum`, 'must be a non-negative integer');
      }
      if (!isNonEmpty(tc.toolName)) at(`toolCalls[${i}].toolName`, 'must be a non-empty string');
      if (tc.filePath?.includes('\\')) {
        at(`toolCalls[${i}].filePath`, 'must be POSIX-normalized (no backslashes)');
      }
    });
  }

  if (!Array.isArray(s.filesTouched)) {
    at('filesTouched', 'must be an array');
  } else {
    s.filesTouched.forEach((f, i) => {
      if (!isNonEmpty(f.filePath)) at(`filesTouched[${i}].filePath`, 'must be a non-empty string');
      if (f.filePath?.includes('\\')) {
        at(`filesTouched[${i}].filePath`, 'must be POSIX-normalized (no backslashes)');
      }
      if (!isCount(f.readCount) || !isCount(f.writeCount) || !isCount(f.editCount)) {
        at(`filesTouched[${i}]`, 'read/write/edit counts must be non-negative numbers');
      }
    });
  }

  if (s.reasoning !== undefined) {
    if (!Array.isArray(s.reasoning)) {
      at('reasoning', 'must be an array when present');
    } else {
      s.reasoning.forEach((r, i) => {
        if (!Number.isInteger(r.sequenceNum) || r.sequenceNum < 0) {
          at(`reasoning[${i}].sequenceNum`, 'must be a non-negative integer');
        }
        if (typeof r.text !== 'string') at(`reasoning[${i}].text`, 'must be a string');
      });
    }
  }

  return issues;
}

/**
 * Assert a parsed session is valid, throwing a descriptive error otherwise.
 * Used at the ingest boundary so a non-conforming adapter fails loudly.
 */
export function assertValidSession(s: ParsedSession): void {
  const issues = validateParsedSession(s);
  if (issues.length > 0) {
    throw new Error(
      `invalid ParsedSession (source=${s.source ?? '?'}, id=${s.id ?? '?'}):\n  - ${issues.join('\n  - ')}`,
    );
  }
}
