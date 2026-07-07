/**
 * Versioned recording file (snapshots/<sessionId>/recording.json).
 *
 * Two formats exist on disk (see @waa/shared recording.schema.ts and
 * docs/adr/0005):
 *  - v2: discriminated by `formatVersion: 2` — parsed as-is.
 *  - v1: legacy files WITHOUT `formatVersion` (their `metadata.version`
 *    string is meaningless) — upgraded in memory, never rewritten on disk.
 *
 * Upgrade rules (v1 → v2): each action's crude CSS `selector` becomes a
 * single `css` target candidate, `redacted` is false (v1 recorded values in
 * plaintext), `authCheckpoints` is empty (v1 had no login segments).
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  browserTypeSchema,
  recordingV1Schema,
  recordingV2Schema,
  type ActionV2,
  type RecordingV1,
  type RecordingV2,
} from '@waa/shared';
import type { ZodError } from 'zod';

/** Compact human-readable summary of zod issues for error messages. */
function describeIssues(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Best-effort sessionId extraction from unvalidated input, for error text. */
function sessionLabel(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as Record<string, unknown>)['sessionId'];
    if (typeof id === 'string' && id.length > 0) return ` (session ${id})`;
  }
  return '';
}

/** Upgrade a schema-valid v1 recording to v2 in memory (no disk rewrite). */
function upgradeV1(v1: RecordingV1): RecordingV2 {
  const actions: ActionV2[] = v1.actions.map((action) => ({
    type: action.type,
    step: action.step,
    timestamp: action.timestamp,
    ...(action.url !== undefined ? { url: action.url } : {}),
    ...(action.selector !== undefined
      ? {
          selector: action.selector,
          target: { candidates: [{ strategy: 'css' as const, value: action.selector }] },
        }
      : {}),
    ...(action.value !== undefined ? { value: action.value } : {}),
    redacted: false,
    ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
  }));

  // v1 stored browserType as a free string; only carry it when it is a valid
  // Playwright browser type, otherwise drop it.
  const browserType = browserTypeSchema.safeParse(v1.browserType);

  const upgraded = {
    formatVersion: 2 as const,
    sessionId: v1.sessionId,
    ...(v1.sessionName !== undefined ? { sessionName: v1.sessionName } : {}),
    url: v1.url,
    startTime: v1.startTime,
    ...(v1.endTime !== undefined ? { endTime: v1.endTime } : {}),
    ...(v1.duration !== undefined ? { duration: v1.duration } : {}),
    ...(v1.actionCount !== undefined ? { actionCount: v1.actionCount } : {}),
    actions,
    authCheckpoints: [],
    ...(browserType.success ? { browserType: browserType.data } : {}),
    ...(v1.browserName !== undefined ? { browserName: v1.browserName } : {}),
    ...(v1.useProfile !== undefined ? { useProfile: v1.useProfile } : {}),
    ...(v1.metadata !== undefined ? { metadata: v1.metadata } : {}),
  };

  // Re-validate so upgrade bugs surface here, not deep in the replayer.
  return recordingV2Schema.parse(upgraded);
}

/**
 * Parse an unknown value (typically `JSON.parse` of recording.json) into a
 * v2 recording. v2 files (`formatVersion: 2`) are validated as-is; files
 * without a `formatVersion` are validated against the v1 schema and upgraded
 * in memory. Throws a descriptive Error (including the sessionId when one is
 * present in the input) on any schema failure or unknown format version.
 */
export function loadRecording(raw: unknown): RecordingV2 {
  const label = sessionLabel(raw);
  const formatVersion =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)['formatVersion']
      : undefined;

  if (formatVersion === 2) {
    const parsed = recordingV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid v2 recording${label}: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
  }

  if (formatVersion !== undefined) {
    throw new Error(
      `Unsupported recording formatVersion ${JSON.stringify(formatVersion)}${label}; expected 2 or a legacy v1 file without formatVersion`,
    );
  }

  const parsed = recordingV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid v1 recording${label}: ${describeIssues(parsed.error)}`);
  }
  return upgradeV1(parsed.data);
}

/**
 * Read + parse a recording.json from disk (v1 files are upgraded in memory;
 * the file itself is never rewritten). Throws on missing file, invalid JSON,
 * or schema failure.
 */
export async function loadRecordingFile(path: string): Promise<RecordingV2> {
  const rawText = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `recording.json at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return loadRecording(raw);
}

/**
 * Validate + write a v2 recording as pretty-printed JSON. Refuses to write
 * anything that fails `recordingV2Schema` so a corrupt in-memory state can
 * never clobber a good file.
 */
export async function saveRecording(path: string, recording: RecordingV2): Promise<void> {
  const parsed = recordingV2Schema.safeParse(recording);
  if (!parsed.success) {
    throw new Error(
      `Refusing to save invalid v2 recording${sessionLabel(recording)}: ${describeIssues(parsed.error)}`,
    );
  }
  await writeFile(path, JSON.stringify(parsed.data, null, 2), 'utf8');
}
