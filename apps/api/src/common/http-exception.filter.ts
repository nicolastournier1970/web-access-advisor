/**
 * Global exception filter: maps EVERY error (HttpException, zod validation
 * failures, unknown throwables) to the `errorResponseSchema` envelope from
 * @waa/shared, so the Angular api-client can parse all non-2xx bodies at the
 * boundary (ADR 0004).
 *
 * NOTE on zod detection: two physical zod copies exist in this workspace until
 * the Phase 7 cutover (root hoists v3 for legacy deps; @waa/shared and
 * apps/api each nest their own v4). `instanceof ZodError` across copies is
 * therefore unreliable — this filter duck-types on the `issues` array instead.
 */
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorResponse } from '@waa/shared';

interface IssueLike {
  path: PropertyKey[];
  message: string;
  code?: unknown;
}

function isIssueLike(value: unknown): value is IssueLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    Array.isArray((value as { path?: unknown }).path)
  );
}

/** Matches zod v3 and v4 ZodError instances from any copy of zod. */
function isZodErrorLike(value: unknown): value is { issues: IssueLike[] } {
  if (typeof value !== 'object' || value === null) return false;
  const issues = (value as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.length > 0 && issues.every(isIssueLike);
}

function toDetails(issues: IssueLike[]): NonNullable<ErrorResponse['details']> {
  return issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'string' || typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
    ...(typeof issue.code === 'string' ? { code: issue.code } : {}),
  }));
}

/** Pure mapping, exported for unit tests. */
export function toErrorResponse(exception: unknown): ErrorResponse {
  // Raw ZodError (e.g. thrown by a hand-rolled schema.parse in a service).
  if (isZodErrorLike(exception)) {
    return {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      details: toDetails(exception.issues),
    };
  }

  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const raw = exception.getResponse();
    const body: Record<string, unknown> = typeof raw === 'string' ? { message: raw } : { ...(raw as object) };

    const message =
      typeof body.message === 'string' ||
      (Array.isArray(body.message) && body.message.every((m) => typeof m === 'string'))
        ? (body.message as string | string[])
        : exception.message;

    // zod issues may travel as nestjs-zod's `errors` array or as the `cause`.
    const issues = Array.isArray(body.errors) && body.errors.every(isIssueLike)
      ? (body.errors as IssueLike[])
      : isZodErrorLike(exception.cause)
        ? exception.cause.issues
        : undefined;

    return {
      statusCode,
      error: typeof body.error === 'string' ? body.error : exception.name,
      message,
      ...(issues ? { details: toDetails(issues) } : {}),
    };
  }

  return {
    statusCode: 500,
    error: 'Internal Server Error',
    message: exception instanceof Error && exception.message ? exception.message : 'Unexpected error',
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    // An SSE stream (or any streamed response) may fail after headers went out.
    if (response.headersSent) {
      response.end();
      return;
    }
    const body = toErrorResponse(exception);
    response.status(body.statusCode).json(body);
  }
}
