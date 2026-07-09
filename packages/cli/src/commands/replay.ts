/**
 * `waa replay --recording <file>`: load a recording (v1 files upgrade to v2
 * in memory automatically) and run the replay + analysis pipeline. Warns up
 * front when the replay is likely to pause for login (auth checkpoints
 * recorded but no storageState.json in the output directory).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadRecordingFile } from '@waa/core';
import type { RecordingV2 } from '@waa/shared';
import type { ReplayCommand } from '../args.js';
import { AUTH_POLL_INTERVAL_MS, executeAnalysis } from '../run-analysis.js';
import { UsageError } from '../usage.js';

export async function runReplayCommand(args: ReplayCommand): Promise<number> {
  const recordingPath = path.resolve(args.recording);
  if (!existsSync(recordingPath)) {
    throw new UsageError(`Recording file not found: ${recordingPath}`);
  }

  let recording: RecordingV2;
  try {
    recording = await loadRecordingFile(recordingPath); // v1 → v2 in memory
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Default output: the recording's own session directory, so an existing
  // storageState.json is picked up and an authenticated replay skips pauses.
  const outDir = path.resolve(args.out ?? path.dirname(recordingPath));

  if (
    recording.authCheckpoints.length > 0 &&
    !existsSync(path.join(outDir, 'storageState.json'))
  ) {
    console.warn(
      `NOTE: this recording has ${recording.authCheckpoints.length} auth checkpoint(s) and no ` +
        `storageState.json exists in ${outDir} — the replay will PAUSE for login.`,
    );
    console.warn(
      'When it pauses: sign in using the opened browser window; the CLI re-checks every ' +
        `${AUTH_POLL_INTERVAL_MS / 1000} seconds and continues automatically (timeout ${args.authTimeoutMs} ms). ` +
        'Run headed (omit --headless) so there is a window to sign in with.',
    );
  }

  console.log(
    `Replaying session ${recording.sessionId} (${recording.actions.length} action(s), ` +
      `${recording.authCheckpoints.length} auth checkpoint(s))`,
  );
  console.log(`Output session directory: ${outDir}`);
  return executeAnalysis({
    recording,
    sessionDir: outDir,
    llm: args.llm,
    headless: args.headless,
    screenshots: args.screenshots,
    authTimeoutMs: args.authTimeoutMs,
  });
}
