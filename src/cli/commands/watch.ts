/**
 * `agentslog watch` — daemon that re-ingests transcripts as they change.
 */
import chalk from 'chalk';
import { openDb, closeDb } from '../../db/index.js';
import { startWatcher } from '../../watcher/index.js';
import { runIngest } from './ingest.js';

export interface WatchCmdOptions {
  /** Skip the initial full ingest before watching. */
  noInitial?: boolean;
}

/** Start the watch daemon; resolves only when interrupted. */
export async function runWatch(options: WatchCmdOptions = {}): Promise<void> {
  const db = openDb();

  // Catch up on anything added while we were offline, then watch.
  if (!options.noInitial) {
    await runIngest({ quiet: true });
  }

  const stop = startWatcher(db);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.stdout.write('\n' + chalk.dim('stopping watcher…') + '\n');
      void stop().then(() => {
        closeDb();
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
