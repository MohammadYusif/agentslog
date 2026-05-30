/**
 * Discovery + parsing entry points for Claude Code transcripts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from '../utils/paths.js';
import { normalizePath, parseSessionFile } from './claude-code.js';
import type { ParsedSession } from './types.js';

export type { ParsedSession } from './types.js';
export { normalizePath, parseSessionFile };

/** A `.jsonl` file discovered on disk, tagged with its project hash. */
export interface DiscoveredFile {
  filePath: string;
  projectHash: string;
}

/**
 * Recursively enumerate every `.jsonl` transcript under the Claude projects
 * directory. The project hash is the top-level directory name directly under
 * the projects root (never a nested subdirectory).
 */
export function discoverSessionFiles(projectsDir = claudeProjectsDir()): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  if (!fs.existsSync(projectsDir)) return out;

  let hashDirs: fs.Dirent[];
  try {
    hashDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue;
    const projectHash = hashDir.name;
    const root = path.join(projectsDir, projectHash);
    walk(root, projectHash, out);
  }
  return out;
}

/** Depth-first walk collecting `.jsonl` files, tagging each with the hash. */
function walk(dir: string, projectHash: string, out: DiscoveredFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, projectHash, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push({ filePath: full, projectHash });
    }
  }
}

/** Derive the project hash for an arbitrary transcript path. */
export function projectHashForFile(filePath: string, projectsDir = claudeProjectsDir()): string {
  const rel = path.relative(projectsDir, filePath);
  const segments = rel.split(path.sep).filter(Boolean);
  return segments[0] ?? path.basename(path.dirname(filePath));
}

/** Parse a single discovered file into a normalized session. */
export async function parseDiscovered(file: DiscoveredFile): Promise<ParsedSession | null> {
  return parseSessionFile(file.filePath, file.projectHash);
}
