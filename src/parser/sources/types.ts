/**
 * Pluggable source adapters. Each agent tool (Claude Code, Cline, Aider, …)
 * stores its transcripts differently, so an adapter knows how to discover its
 * files and parse them into the shared {@link ParsedSession} model.
 */
import type { ParsedSession } from '../types.js';

/** A discovered ingestable unit: a transcript file or a task directory. */
export interface DiscoveredUnit {
  /** Absolute path to the file or directory to parse. */
  filePath: string;
  /** Stable grouping key for the originating project. */
  projectHash: string;
}

export interface SourceAdapter {
  /** Stable id stored on each session row ('claude-code', 'cline', 'aider'). */
  name: string;
  /** Human-friendly label for ingest output. */
  label: string;
  /** Whether this adapter is unvalidated against real-world data. */
  experimental: boolean;
  /** True when the source's data location exists or is configured. */
  isAvailable(): boolean;
  /** Enumerate the ingestable units for this source. */
  discover(): DiscoveredUnit[];
  /**
   * Parse one discovered unit into zero or more sessions. Returns an array
   * because a single file (e.g. an Aider history) can hold multiple sessions.
   */
  parse(unit: DiscoveredUnit): Promise<ParsedSession[]>;
}
