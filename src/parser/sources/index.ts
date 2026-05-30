/**
 * Source adapter registry. `ingest` walks every available adapter; the primary
 * Claude Code adapter is always present, the experimental ones activate only
 * when their data location exists or is configured.
 */
import { claudeCodeAdapter } from './claude-code.js';
import { clineAdapter } from './cline.js';
import { aiderAdapter } from './aider.js';
import type { SourceAdapter } from './types.js';

export type { SourceAdapter, DiscoveredUnit } from './types.js';
export { claudeCodeAdapter } from './claude-code.js';
export { clineAdapter, parseClineTask } from './cline.js';
export { aiderAdapter, parseAiderHistory } from './aider.js';

/** All registered adapters, primary source first. */
export const ALL_ADAPTERS: SourceAdapter[] = [claudeCodeAdapter, clineAdapter, aiderAdapter];

/** Adapters whose data is actually present/configured on this machine. */
export function availableAdapters(): SourceAdapter[] {
  return ALL_ADAPTERS.filter((a) => {
    try {
      return a.isAvailable();
    } catch {
      return false;
    }
  });
}
