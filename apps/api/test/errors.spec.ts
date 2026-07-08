import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { errorResponseSchema } from '@waa/shared';
import { createApp } from '../dist/app.factory.js';
import { toErrorResponse } from '../dist/common/http-exception.filter.js';

describe('error envelope (errorResponseSchema)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('unknown route → 404 in envelope shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/definitely-not-a-route').expect(404);
    const body = errorResponseSchema.parse(res.body);
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toContain('/api/definitely-not-a-route');
  });

  it('raw ZodError → 400 with {path,message,code} details', () => {
    const result = z.object({ url: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    const envelope = errorResponseSchema.parse(toErrorResponse(result.error));
    expect(envelope.statusCode).toBe(400);
    expect(envelope.error).toBe('Bad Request');
    expect(envelope.details).toHaveLength(1);
    expect(envelope.details?.[0]).toMatchObject({ path: ['url'], code: 'invalid_type' });
  });

  it("nestjs-zod's ZodValidationException → 400 with details", () => {
    const result = z.object({ step: z.number() }).safeParse({ step: 'x' });
    expect(result.success).toBe(false);
    const envelope = errorResponseSchema.parse(
      toErrorResponse(new ZodValidationException(result.error as never)),
    );
    expect(envelope.statusCode).toBe(400);
    expect(envelope.message).toBe('Validation failed');
    expect(envelope.details?.[0]).toMatchObject({ path: ['step'], code: 'invalid_type' });
  });

  it('unknown throwables → 500 envelope', () => {
    expect(toErrorResponse('boom')).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Unexpected error',
    });
    expect(toErrorResponse(new Error('kaput'))).toMatchObject({
      statusCode: 500,
      message: 'kaput',
    });
  });
});
