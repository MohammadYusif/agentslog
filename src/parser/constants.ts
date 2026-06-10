/**
 * Shared magic strings matched against Claude Code's error messages. Kept in
 * one place because parsing (ingest), querying, and the hooks must all agree
 * on them — and because they are coupled to Claude Code's exact wording, which
 * may change across versions.
 */

/**
 * Substring of the tool_result error emitted when the user rejects a tool call
 * ("The user doesn't want to proceed…"). Rejections are not real tool
 * failures, so ingest and error queries filter them out.
 */
export const REJECTION_PATTERN = "doesn't want to proceed";

/** Substring of Claude Code's "file not pre-read" Edit/Write error messages. */
export const FILE_NOT_READ_PATTERN = 'has not been read';
