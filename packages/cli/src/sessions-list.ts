/**
 * Session listing for `waa sessions`: a simplified, read-only take on the
 * API's disk-backed session store. Each snapshots/<id>/ directory is read
 * from session.json (new sessions) or recording.json (legacy sessions);
 * directories with neither file are skipped. Nothing is ever written.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { renderTable } from './table.js';

/** Loose session.json reader — unknown/extra keys never break the listing. */
const sessionMetaLooseSchema = z
  .object({
    url: z.string().optional(),
    status: z.string().optional(),
    startTime: z.string().optional(),
    actionCount: z.number().int().optional(),
    authCheckpointCount: z.number().int().optional(),
    recordingFormatVersion: z.number().optional(),
  })
  .catchall(z.unknown());

/** Loose recording.json reader — enough for a listing row, v1 or v2. */
const recordingLooseSchema = z
  .object({
    formatVersion: z.number().optional(),
    url: z.string().optional(),
    startTime: z.string().optional(),
    actions: z.array(z.unknown()).optional(),
    authCheckpoints: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export interface SessionRow {
  sessionId: string;
  status: string;
  url: string;
  startTime: string;
  actionCount: number;
  authCheckpointCount: number;
  recordingFormat: 'v1' | 'v2' | '-';
  hasAnalysis: boolean;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Build one row from a session directory, or null when it is not a session. */
async function readSessionRow(sessionDir: string, sessionId: string): Promise<SessionRow | null> {
  const hasAnalysis =
    existsSync(path.join(sessionDir, 'analysis.json')) ||
    existsSync(path.join(sessionDir, 'manifest.json'));

  const recordingRaw = await readJson(path.join(sessionDir, 'recording.json'));
  const recording =
    recordingRaw !== null ? recordingLooseSchema.safeParse(recordingRaw) : undefined;
  const recordingFormat: SessionRow['recordingFormat'] =
    recording?.success === true ? (recording.data.formatVersion === 2 ? 'v2' : 'v1') : '-';

  const metaRaw = await readJson(path.join(sessionDir, 'session.json'));
  if (metaRaw !== null) {
    const meta = sessionMetaLooseSchema.safeParse(metaRaw);
    if (meta.success) {
      const fromMetaVersion =
        meta.data.recordingFormatVersion === 2
          ? 'v2'
          : meta.data.recordingFormatVersion === 1
            ? 'v1'
            : recordingFormat;
      return {
        sessionId,
        status: meta.data.status ?? 'unknown',
        url: meta.data.url ?? 'unknown://',
        startTime: meta.data.startTime ?? '',
        actionCount: meta.data.actionCount ?? 0,
        authCheckpointCount: meta.data.authCheckpointCount ?? 0,
        recordingFormat: fromMetaVersion,
        hasAnalysis,
      };
    }
  }

  if (recording?.success === true) {
    return {
      sessionId,
      status: hasAnalysis ? 'analyzed' : 'recorded',
      url: recording.data.url ?? 'unknown://',
      startTime: recording.data.startTime ?? '',
      actionCount: recording.data.actions?.length ?? 0,
      authCheckpointCount: recording.data.authCheckpoints?.length ?? 0,
      recordingFormat,
      hasAnalysis,
    };
  }

  return null;
}

/**
 * List sessions in a snapshots directory, newest first. Throws when the
 * directory itself cannot be read; individual malformed sessions are skipped.
 */
export async function listSessions(dir: string): Promise<SessionRow[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Cannot read sessions directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows: SessionRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const row = await readSessionRow(path.join(dir, entry.name), entry.name);
    if (row !== null) rows.push(row);
  }
  return rows.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Render session rows as a table (empty input → a no-sessions message). */
export function formatSessionsTable(rows: readonly SessionRow[]): string {
  if (rows.length === 0) return 'No sessions found.';
  return renderTable(
    ['SESSION', 'STATUS', 'FMT', 'ACTIONS', 'AUTH', 'ANALYZED', 'STARTED', 'URL'],
    rows.map((row) => [
      row.sessionId,
      row.status,
      row.recordingFormat,
      String(row.actionCount),
      String(row.authCheckpointCount),
      row.hasAnalysis ? 'yes' : 'no',
      truncate(row.startTime.replace('T', ' '), 19),
      truncate(row.url, 48),
    ]),
    ['l', 'l', 'l', 'r', 'r', 'l', 'l', 'l'],
  );
}
