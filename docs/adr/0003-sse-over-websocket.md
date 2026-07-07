# ADR 0003: Server-Sent Events for realtime updates

- **Status**: Accepted (2026-07-07)

## Context

v1 delivered realtime state by HTTP polling: the recording action feed every 1 s and analysis status every 2 s. The rewrite needs live updates for: the recording action feed, replay/analysis progress, and pause-for-login notifications (ADR 0005). The alternatives are WebSockets or Server-Sent Events (SSE).

## Decision

Use **SSE** (`GET /api/sessions/:id/events`) for all server→client streams, and plain validated POSTs for client→server commands (start/stop/continue/cancel).

## Rationale

- Every realtime need is strictly server→client. Client→server traffic consists of rare, discrete commands that benefit from DTO validation, OpenAPI documentation, and easy testing as normal endpoints.
- `EventSource` has built-in auto-reconnect with `Last-Event-ID`; paired with a per-session ring buffer (last 500 events, monotonic ids) it solves missed-events-during-reconnect without hand-rolled heartbeat/replay logic.
- NestJS supports SSE first-class (`@Sse()` returning an RxJS `Observable<MessageEvent>`), with no gateway/adapter or socket.io dependency.
- Plain HTTP works through the Angular dev-server proxy and is trivially debuggable with curl.

## Consequences

- Both v1 polling loops are deleted.
- All event payloads are typed by a zod discriminated union in `@waa/shared` (`events/sse-events.schema.ts`); the Angular `SseClient` validates each message at the boundary.
- If a genuinely bidirectional feature ever appears, revisit; nothing in the design precludes adding a WS channel later.
