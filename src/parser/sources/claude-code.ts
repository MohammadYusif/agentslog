/**
 * Claude Code source adapter — wraps the existing discovery + parser so the
 * primary, fully-validated source plugs into the same registry as the others.
 */
import fs from 'node:fs';
import { claudeProjectsDir } from '../../utils/paths.js';
import { discoverSessionFiles, parseSessionFile } from '../index.js';
import type { SourceAdapter, DiscoveredUnit } from './types.js';

export const claudeCodeAdapter: SourceAdapter = {
  name: 'claude-code',
  label: 'Claude Code',
  experimental: false,

  isAvailable() {
    return fs.existsSync(claudeProjectsDir());
  },

  discover(): DiscoveredUnit[] {
    return discoverSessionFiles().map((f) => ({
      filePath: f.filePath,
      projectHash: f.projectHash,
    }));
  },

  async parse(unit: DiscoveredUnit) {
    const session = await parseSessionFile(unit.filePath, unit.projectHash);
    return session ? [session] : [];
  },
};
