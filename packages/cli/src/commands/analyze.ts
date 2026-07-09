/**
 * `waa analyze --url <url>`: build a single-navigate v2 recording in memory,
 * persist it into the output session directory (so the session is later
 * replayable and listable), and run the full analysis pipeline.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { saveRecording, sessionPaths } from '@waa/core';
import type { RecordingV2 } from '@waa/shared';
import type { AnalyzeCommand } from '../args.js';
import { executeAnalysis } from '../run-analysis.js';

/** Pure builder for the one-step "navigate to <url>" recording. */
export function buildSingleNavigateRecording(
  url: string,
  sessionId: string,
  now: Date = new Date(),
): RecordingV2 {
  const timestamp = now.toISOString();
  return {
    formatVersion: 2,
    sessionId,
    sessionName: `CLI analyze of ${url}`,
    url,
    startTime: timestamp,
    actionCount: 1,
    actions: [{ type: 'navigate', step: 1, timestamp, url, redacted: false }],
    authCheckpoints: [],
    browserType: 'chromium',
    useProfile: false,
    metadata: { source: '@waa/cli' },
  };
}

export async function runAnalyzeCommand(args: AnalyzeCommand): Promise<number> {
  const outDir = path.resolve(args.out ?? path.join('snapshots', `session_cli_${Date.now()}`));
  const sessionId = path.basename(outDir);
  const paths = sessionPaths(path.dirname(outDir), sessionId);

  const recording = buildSingleNavigateRecording(args.url, sessionId);
  await mkdir(paths.root, { recursive: true });
  await saveRecording(paths.recording, recording);

  console.log(`Analyzing ${args.url}`);
  console.log(`Output session directory: ${paths.root}`);
  return executeAnalysis({
    recording,
    sessionDir: paths.root,
    llm: args.llm,
    headless: args.headless,
    screenshots: args.screenshots,
    authTimeoutMs: args.authTimeoutMs,
  });
}
