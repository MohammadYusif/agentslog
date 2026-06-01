import { describe, expect, it } from 'vitest';
import {
  BLOCK_END,
  BLOCK_START,
  lenientJsonParse,
  MEMORY_BLOCK,
  mergeHooks,
  stripJsonComments,
  stripTrailingCommas,
  upsertManagedBlock,
} from '../src/cli/commands/setup.js';

describe('upsertManagedBlock', () => {
  it('inserts the managed block into empty/missing content', () => {
    const out = upsertManagedBlock(null, MEMORY_BLOCK);
    expect(out).toContain(BLOCK_START);
    expect(out).toContain(BLOCK_END);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('appends after existing content, preserving it', () => {
    const out = upsertManagedBlock('# My notes\n\nkeep me\n', MEMORY_BLOCK);
    expect(out).toContain('# My notes');
    expect(out).toContain('keep me');
    expect(out.indexOf('keep me')).toBeLessThan(out.indexOf(BLOCK_START));
  });

  it('is idempotent — re-running yields identical output and never duplicates', () => {
    const once = upsertManagedBlock('# Notes\n', MEMORY_BLOCK);
    const twice = upsertManagedBlock(once, MEMORY_BLOCK);
    expect(twice).toBe(once);
    expect(once.match(new RegExp(BLOCK_START, 'g'))).toHaveLength(1);
  });

  it('replaces a stale block in place when the body changes', () => {
    const stale = `intro\n\n${BLOCK_START}\nOLD RULES\n${BLOCK_END}\n\noutro\n`;
    const out = upsertManagedBlock(stale, MEMORY_BLOCK);
    expect(out).not.toContain('OLD RULES');
    expect(out).toContain('your own coding history');
    expect(out).toContain('intro');
    expect(out).toContain('outro');
    expect(out.match(new RegExp(BLOCK_START, 'g'))).toHaveLength(1);
  });
});

describe('tolerant JSON', () => {
  it('strips // and /* */ comments but not those inside strings', () => {
    const text = `{
      // a line comment
      "a": 1, /* block */
      "url": "http://example.com" // keep the http://
    }`;
    const cleaned = stripJsonComments(text);
    expect(cleaned).toContain('http://example.com');
    expect(cleaned).not.toContain('a line comment');
    expect(cleaned).not.toContain('block');
  });

  it('removes trailing commas', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]');
  });

  it('parses strict JSON, and JSON with comments + trailing commas', () => {
    expect(lenientJsonParse('{"a":1}')).toEqual({ a: 1 });
    const messy = `{
      "hooks": {}, // existing
      "x": 2, /* trailing */
    }`;
    expect(lenientJsonParse(messy)).toEqual({ hooks: {}, x: 2 });
  });

  it('throws on genuinely broken JSON so the caller can avoid clobbering', () => {
    expect(() => lenientJsonParse('{ this is not json')).toThrow();
  });
});

describe('mergeHooks', () => {
  it('adds the three agentslog hooks to empty settings', () => {
    const { settings, added } = mergeHooks({});
    expect(added).toHaveLength(3);
    expect(Object.keys(settings.hooks ?? {})).toEqual(
      expect.arrayContaining(['PreToolUse', 'Stop', 'SessionStart']),
    );
  });

  it('is idempotent — re-running adds nothing', () => {
    const first = mergeHooks({});
    const second = mergeHooks(first.settings);
    expect(second.added).toHaveLength(0);
  });

  it('preserves unrelated keys and pre-existing hooks', () => {
    const { settings, added } = mergeHooks({
      permissions: { allow: ['Bash'] },
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'other tool' }] }],
      },
    });
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
    // Existing PreToolUse entry kept; our Bash check added alongside it.
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
    expect(added).toContain('agentslog hook check');
  });

  it('keeps disableAllHooks visible so the caller can warn', () => {
    const { settings } = mergeHooks({ disableAllHooks: true });
    expect(settings.disableAllHooks).toBe(true);
  });
});
