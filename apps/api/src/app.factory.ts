/**
 * App assembly, shared by main.ts and the supertest specs (which import the
 * COMPILED dist build — vitest/esbuild cannot emit decorator metadata, so the
 * Nest app must always be constructed from tsc output).
 */
import 'reflect-metadata';
import type { INestApplication, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/http-exception.filter.js';

export interface CreateAppOptions {
  /** Pass `false` in tests to silence Nest boot logging. */
  logger?: LogLevel[] | false;
}

/**
 * Prefix/filter/pipe/shutdown wiring, shared by createApp and test modules
 * built with @nestjs/testing (which need provider overrides and therefore
 * cannot use NestFactory directly).
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  // nestjs-zod v5 global pipe: any @Body()/@Query()/@Param() typed with a
  // `createZodDto(schema)` class (schemas from @waa/shared, ADR 0004) is
  // parsed automatically; failures throw ZodValidationException, which the
  // AllExceptionsFilter maps to the shared error envelope with `details`.
  app.useGlobalPipes(new ZodValidationPipe());
  app.enableShutdownHooks();
  return app;
}

export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: options.logger ?? ['error', 'warn', 'log'],
  });
  configureApp(app);

  // Swagger UI at /api/docs. cleanupOpenApiDoc rewrites nestjs-zod DTO
  // schema output once zod DTOs appear on routes (engine wave).
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Web Access Advisor API')
      .setDescription(
        'Accessibility recording/replay/analysis API. Realtime updates stream over SSE at GET /api/sessions/{id}/events (ADR 0003).',
      )
      .setVersion('3.0.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document));

  return app;
}
