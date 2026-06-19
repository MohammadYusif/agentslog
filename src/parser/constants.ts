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

/**
 * Substring of the Edit/Write error emitted when a file changed between the
 * Read and the Edit ("File has been modified since read, either by the user or
 * by a linter…") — typically a formatter rewriting the file on save. Distinct
 * from {@link FILE_NOT_READ_PATTERN}: this survives an initial Read, so the fix
 * is to re-Read immediately before the Edit rather than to Read at all.
 */
export const FILE_MODIFIED_SINCE_READ_PATTERN = 'has been modified since read';
