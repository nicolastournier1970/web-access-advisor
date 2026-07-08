/**
 * Disk-backed session store (docs/rewrite-plan.md §5): the source of truth is
 * the snapshots directory, not process memory, so API restarts lose nothing.
 *
 *  - New sessions get snapshots/<id>/session.json (schema below).
 *  - Legacy v1 sessions (recording.json but no session.json) are folded into
 *    listings read-only, with facts derived from the files present.
 *  - Startup marks sessions stuck in a live status as 'interrupted' (their
 *    browser/worker died with the previous process).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sessionSummarySchema, sessionStatusSchema } from '@waa/shared';
import type { SessionStatus, SessionSummary } from '@waa/shared';
import { ENV, type Env } from '../config/env.js';

/** Persisted shape of session.json — derived facts are folded in at read time. */
export const sessionMetaSchema = sessionSummarySchema
  .omit({ hasStorageState: true, hasAnalysis: true })
  .extend({ updatedAt: z.string() });
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

const LIVE_STATUSES: readonly SessionStatus[] = [
  'recording',
  'replaying',
  'awaiting-auth',
  'analyzing',
];

@Injectable()
export class SessionStoreService implements OnModuleInit {
  readonly root: string;
  /** Legacy-summary cache keyed by sessionId, invalidated by recording.json mtime. */
  private readonly legacyCache = new Map<string, { mtimeMs: number; summary: SessionSummary }>();

  constructor(@Inject(ENV) env: Env) {
    this.root = path.resolve(env.SNAPSHOTS_DIR);
  }

  /** Mark sessions the previous process left in a live status as interrupted. */
  async onModuleInit(): Promise<void> {
    for (const id of await this.sessionDirs()) {
      const meta = await this.readMeta(id);
      if (meta && LIVE_STATUSES.includes(meta.status)) {
        await this.patch(id, { status: 'interrupted' });
      }
    }
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  /** A session exists when it has metadata, a recording, or (new) a directory. */
  exists(sessionId: string): boolean {
    const dir = this.sessionDir(sessionId);
    return (
      existsSync(path.join(dir, 'session.json')) || existsSync(path.join(dir, 'recording.json'))
    );
  }

  async create(meta: Omit<SessionMeta, 'updatedAt'>): Promise<void> {
    await mkdir(this.sessionDir(meta.sessionId), { recursive: true });
    await this.writeMeta({ ...meta, updatedAt: new Date().toISOString() });
  }

  async patch(sessionId: string, partial: Partial<SessionMeta>): Promise<void> {
    const meta = await this.readMeta(sessionId);
    if (!meta) return;
    await this.writeMeta({ ...meta, ...partial, sessionId, updatedAt: new Date().toISOString() });
  }

  /** Full summary (disk facts folded in), or null when the session is unknown. */
  async get(sessionId: string): Promise<SessionSummary | null> {
    const meta = await this.readMeta(sessionId);
    if (meta) return this.fold(meta);
    return this.legacySummary(sessionId);
  }

  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const id of await this.sessionDirs()) {
      const summary = await this.get(id);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  /** Delete the whole session directory. Caller must refuse live sessions. */
  async delete(sessionId: string): Promise<boolean> {
    if (!this.exists(sessionId)) return false;
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    this.legacyCache.delete(sessionId);
    return true;
  }

  private async sessionDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async readMeta(sessionId: string): Promise<SessionMeta | null> {
    try {
      const raw = await readFile(path.join(this.sessionDir(sessionId), 'session.json'), 'utf-8');
      return sessionMetaSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    const validated = sessionMetaSchema.parse(meta);
    await writeFile(
      path.join(this.sessionDir(meta.sessionId), 'session.json'),
      JSON.stringify(validated, null, 2),
      'utf-8',
    );
  }

  private fold(meta: SessionMeta): SessionSummary {
    const dir = this.sessionDir(meta.sessionId);
    const { updatedAt: _updatedAt, ...summary } = meta;
    return sessionSummarySchema.parse({
      ...summary,
      hasStorageState: existsSync(path.join(dir, 'storageState.json')),
      hasAnalysis:
        existsSync(path.join(dir, 'analysis.json')) || existsSync(path.join(dir, 'manifest.json')),
    });
  }

  /** Derive a read-only summary for a legacy session (no session.json). */
  private async legacySummary(sessionId: string): Promise<SessionSummary | null> {
    const dir = this.sessionDir(sessionId);
    const recordingPath = path.join(dir, 'recording.json');
    try {
      const { stat } = await import('node:fs/promises');
      const { mtimeMs } = await stat(recordingPath);
      const cached = this.legacyCache.get(sessionId);
      if (cached && cached.mtimeMs === mtimeMs) return cached.summary;

      const raw = JSON.parse(await readFile(recordingPath, 'utf-8')) as Record<string, unknown>;
      const hasAnalysis =
        existsSync(path.join(dir, 'analysis.json')) || existsSync(path.join(dir, 'manifest.json'));
      const summary = sessionSummarySchema.parse({
        sessionId,
        ...(typeof raw['sessionName'] === 'string' ? { name: raw['sessionName'] } : {}),
        url: typeof raw['url'] === 'string' ? raw['url'] : 'unknown://',
        status: sessionStatusSchema.parse(hasAnalysis ? 'analyzed' : 'recorded'),
        startTime: typeof raw['startTime'] === 'string' ? raw['startTime'] : '1970-01-01T00:00:00Z',
        ...(typeof raw['endTime'] === 'string' ? { endTime: raw['endTime'] } : {}),
        actionCount: Array.isArray(raw['actions']) ? raw['actions'].length : 0,
        authCheckpointCount: Array.isArray(raw['authCheckpoints'])
          ? raw['authCheckpoints'].length
          : 0,
        hasStorageState: existsSync(path.join(dir, 'storageState.json')),
        hasAnalysis,
        recordingFormatVersion: raw['formatVersion'] === 2 ? 2 : 1,
        ...(typeof raw['browserType'] === 'string' ? { browserType: raw['browserType'] } : {}),
        ...(typeof raw['browserName'] === 'string' ? { browserName: raw['browserName'] } : {}),
        ...(typeof raw['useProfile'] === 'boolean' ? { useProfile: raw['useProfile'] } : {}),
      });
      this.legacyCache.set(sessionId, { mtimeMs, summary });
      return summary;
    } catch {
      return null;
    }
  }
}
