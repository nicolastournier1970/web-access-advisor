/**
 * Path conventions for the on-disk session layout. UNCHANGED from the legacy
 * server so existing snapshot directories keep working:
 *
 *   snapshots/<sessionId>/
 *     recording.json        — versioned recording (see recording-format.ts)
 *     storageState.json     — Playwright storage state (cookies/localStorage),
 *                             encrypted at rest (see secure-storage-state.ts)
 *     manifest.json         — replay manifest
 *     analysis.json         — axe + LLM analysis result
 *     session.json          — session metadata
 *     step_NNN/             — zero-padded per-step capture directory
 *       snapshot.html
 *       axe_results.json
 *       axe_context.json
 *       screenshot.png
 *
 * All returned paths are absolute; callers must never re-derive filenames.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** The four capture files inside one step_NNN directory (absolute paths). */
export interface StepFiles {
  /** Rendered DOM capture (step_NNN/snapshot.html). */
  snapshot: string;
  /** Raw axe-core scan output (step_NNN/axe_results.json). */
  axeResults: string;
  /** Context/metadata for the axe scan (step_NNN/axe_context.json). */
  axeContext: string;
  /** Full-page screenshot (step_NNN/screenshot.png). */
  screenshot: string;
}

/**
 * Absolute paths for every well-known file of one session. Constructed via
 * {@link sessionPaths}; do not build these strings by hand elsewhere.
 */
export interface SessionPaths {
  /** Session root: <snapshotsDir>/<sessionId>. */
  root: string;
  /** recording.json (v1 or v2 on disk; always loaded as v2 in memory). */
  recording: string;
  /** storageState.json — credentials-equivalent cookies, AES-256-GCM encrypted at rest (legacy files may be plaintext); never log its contents. */
  storageState: string;
  /** manifest.json written after replay. */
  manifest: string;
  /** analysis.json written after axe + LLM analysis. */
  analysis: string;
  /** session.json — session metadata (name, url, timestamps). */
  sessionMeta: string;
  /** Directory for one step's captures, zero-padded (1 → step_001). */
  stepDir(step: number): string;
  /** The four capture file paths inside {@link stepDir}. */
  stepFiles(step: number): StepFiles;
}

/**
 * Zero-pad a step number to the legacy `step_NNN` directory name (minimum
 * three digits; wider numbers are kept as-is so step 1234 → step_1234).
 */
function stepDirName(step: number): string {
  if (!Number.isInteger(step) || step < 0) {
    throw new Error(`Invalid step number: ${step}`);
  }
  return `step_${String(step).padStart(3, '0')}`;
}

/**
 * Build the absolute path set for a session. Pure — performs no I/O and does
 * not require the directories to exist (see {@link ensureSessionDir}).
 */
export function sessionPaths(snapshotsDir: string, sessionId: string): SessionPaths {
  const root = path.resolve(snapshotsDir, sessionId);
  const stepDir = (step: number): string => path.join(root, stepDirName(step));
  return {
    root,
    recording: path.join(root, 'recording.json'),
    storageState: path.join(root, 'storageState.json'),
    manifest: path.join(root, 'manifest.json'),
    analysis: path.join(root, 'analysis.json'),
    sessionMeta: path.join(root, 'session.json'),
    stepDir,
    stepFiles(step: number): StepFiles {
      const dir = stepDir(step);
      return {
        snapshot: path.join(dir, 'snapshot.html'),
        axeResults: path.join(dir, 'axe_results.json'),
        axeContext: path.join(dir, 'axe_context.json'),
        screenshot: path.join(dir, 'screenshot.png'),
      };
    },
  };
}

/**
 * Create the session root directory (recursively, idempotent). Step
 * directories are created lazily by the capture code, not here.
 */
export async function ensureSessionDir(paths: SessionPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
}
