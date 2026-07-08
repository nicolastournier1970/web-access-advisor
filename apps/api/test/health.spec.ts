import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@waa/shared';
import { createApp } from '../dist/app.factory.js';

describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a healthResponseSchema-valid body', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    const health = healthResponseSchema.parse(res.body);
    expect(health.status).toBe('ok');
    expect(health.version).toBe('2.0.0');
    expect(health.uptimeSeconds).toBeGreaterThan(0);
    // 'gemini' when the developer's real environment carries GEMINI_API_KEY.
    expect(['gemini', 'stub']).toContain(health.llmProvider);
  });
});
