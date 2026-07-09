import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSessionsTable, listSessions } from './sessions-list.js';

let dir: string;

async function writeSession(name: string, files: Record<string, unknown>): Promise<void> {
  const sessionDir = path.join(dir, name);
  await mkdir(sessionDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(sessionDir, file), JSON.stringify(content, null, 2), 'utf8');
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'waa-cli-sessions-'));

  // New-stack session: session.json + analysis.json.
  await writeSession('session_v2', {
    'session.json': {
      sessionId: 'session_v2',
      url: 'https://a.test/app',
      status: 'analyzed',
      startTime: '2026-07-08T10:00:00.000Z',
      actionCount: 5,
      authCheckpointCount: 1,
      recordingFormatVersion: 2,
      updatedAt: '2026-07-08T10:05:00.000Z',
    },
    'analysis.json': {},
  });

  // Legacy session: recording.json only (v1: no formatVersion).
  await writeSession('session_v1_legacy', {
    'recording.json': {
      sessionId: 'session_v1_legacy',
      url: 'https://b.test/portal',
      startTime: '2026-07-09T09:30:00.000Z',
      actions: [
        { type: 'navigate', step: 1, timestamp: 't' },
        { type: 'click', step: 2, timestamp: 't' },
      ],
    },
  });

  // Not a session: directory without session.json or recording.json.
  await mkdir(path.join(dir, 'not_a_session'), { recursive: true });
  // Not a session: stray file at the top level.
  await writeFile(path.join(dir, 'stray.txt'), 'ignore me', 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listSessions', () => {
  it('lists sessions newest-first and skips non-session entries', async () => {
    const rows = await listSessions(dir);
    expect(rows.map((row) => row.sessionId)).toEqual(['session_v1_legacy', 'session_v2']);
  });

  it('reads new sessions from session.json', async () => {
    const rows = await listSessions(dir);
    const v2 = rows.find((row) => row.sessionId === 'session_v2');
    expect(v2).toEqual({
      sessionId: 'session_v2',
      status: 'analyzed',
      url: 'https://a.test/app',
      startTime: '2026-07-08T10:00:00.000Z',
      actionCount: 5,
      authCheckpointCount: 1,
      recordingFormat: 'v2',
      hasAnalysis: true,
    });
  });

  it('derives legacy sessions from recording.json', async () => {
    const rows = await listSessions(dir);
    const legacy = rows.find((row) => row.sessionId === 'session_v1_legacy');
    expect(legacy).toEqual({
      sessionId: 'session_v1_legacy',
      status: 'recorded',
      url: 'https://b.test/portal',
      startTime: '2026-07-09T09:30:00.000Z',
      actionCount: 2,
      authCheckpointCount: 0,
      recordingFormat: 'v1',
      hasAnalysis: false,
    });
  });

  it('throws a descriptive error for an unreadable directory', async () => {
    await expect(listSessions(path.join(dir, 'does-not-exist'))).rejects.toThrow(
      /Cannot read sessions directory/,
    );
  });
});

describe('formatSessionsTable', () => {
  it('renders a header plus one line per session', async () => {
    const rows = await listSessions(dir);
    const table = formatSessionsTable(rows);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/SESSION\s+STATUS\s+FMT\s+ACTIONS\s+AUTH\s+ANALYZED\s+STARTED\s+URL/);
    expect(lines).toHaveLength(1 + rows.length);
    expect(table).toContain('session_v2');
    expect(table).toContain('session_v1_legacy');
    expect(table).toContain('https://b.test/portal');
  });

  it('handles the empty case', () => {
    expect(formatSessionsTable([])).toBe('No sessions found.');
  });
});
