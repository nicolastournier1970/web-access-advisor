# API reference

The NestJS API (`apps/api`) is a thin adapter over the engine: validated commands in, SSE events out, disk-backed session state. Base path is **`/api`** (global prefix); all bodies are JSON.

Sources of truth (this document describes them; on any conflict the code wins):

- DTO schemas: [`packages/shared/src/api/*.schema.ts`](../packages/shared/src/api) — every request/response type below is a zod schema there ([ADR 0004](./adr/0004-zod-contracts.md))
- Controllers: `apps/api/src/{sessions,recording,analysis,browsers,storage-state,events,health}`
- Generated contract: [`docs/openapi.json`](./openapi.json) and the live Swagger UI at **`/api/docs`**

## Conventions

- **Validation**: a global `ZodValidationPipe` (nestjs-zod) parses every `@Body()`/`@Query()` typed with a `createZodDto(schema)` class. Failures are `400` with zod issues in `details`.
- **Client rule**: omit empty optional request fields — never send `null` (zod defaults absorb only *absent* keys). The Angular api-client strips `null`/`undefined` before serializing.
- **Error envelope**: every non-2xx body matches `errorResponseSchema` ([`error-api.schema.ts`](../packages/shared/src/api/error-api.schema.ts)), produced by the global `AllExceptionsFilter`:

  ```json
  {
    "statusCode": 409,
    "error": "Conflict",
    "message": "Session session_123 already has a live worker",
    "details": [ { "path": ["url"], "message": "Invalid URL", "code": "invalid_format" } ]
  }
  ```

  `details` (zod issues) appears on validation failures only. Raw `ZodError`s thrown anywhere in the API are also mapped to this envelope as `400` (the filter duck-types on `issues`, so both zod majors in the pre-cutover tree are caught).

- **409 semantics**: the API enforces **one live worker per session** (`SessionWorkerRegistry`). `409 Conflict` consistently means *"the session's live-worker state doesn't allow this"* — a live worker exists where none may (start analysis twice, delete a live session), or no live worker exists where one is required (stop/auth-segment routes without a live recording, replay-auth routes without a running analysis), or a precondition holds a stale resource (reused storage state failed validation, analysis without a recording).

## Routes

### Health

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `GET /api/health` | — | `HealthResponse` (`status`, `version`, `uptimeSeconds`, `llmProvider`) | — | — |

### Sessions

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `GET /api/sessions` | — | `ListSessionsResponse` — `SessionSummary[]`, newest first; legacy v1 sessions folded in read-only | — | — |
| `GET /api/sessions/:id` | — | `SessionSummary` | `404` unknown session | — |
| `DELETE /api/sessions/:id` | — | `DeleteSessionResponse` | `409` session has a live worker; `404` unknown | Session's SSE channel is dropped (open streams complete) |
| `GET /api/sessions/:id/recording` | — | `recording.json` as a download (`content-disposition: attachment`) | `404` no recording | — |
| `GET /api/sessions/:id/snapshots/:step/:file` | — | Raw artifact; `file` ∈ `snapshot.html`, `axe_results.json`, `axe_context.json`, `screenshot.png` | `404` unknown filename / bad step / missing file (never a free path lookup) | — |

### Recording

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `POST /api/sessions` (**201**) | `StartRecordingRequest` — `url` (http/https only), `browserType`, `browserName?`, `useProfile`, `name?`, `reuseStorageStateFrom?` | `StartRecordingResponse` — `sessionId`, `status: recording`, `url` | `400` validation; for `reuseStorageStateFrom`: `404` unknown source session, `400` source has no saved login, `409` saved login **failed the behavioural validation probe**; launch failure → `500` (session marked `failed`) | `session.status (recording)`, then the live feed: `recording.action`, `recording.navigated`, `recording.auth_suspected`, `recording.auth_segment` |
| `POST /api/sessions/:id/recording/stop` | — | `StopRecordingResponse` — `actionCount`, `actions`, `authCheckpoints`, `storageStateSaved` | `409` no live recording | `session.status (recorded)` |
| `POST /api/sessions/:id/recording/auth/start` | `StartAuthSegmentRequest` — `reason` (`user-marked` default \| `auto-detected`), `fromStep?` (retroactive backdate — see [auth-flows.md](./auth-flows.md#auto-detected-with-the-fromstep-mapping)) | `StartAuthSegmentResponse` — `checkpointId`, `afterStep`, `discardedActions` | `409` no live recording; starting a second segment while one is open surfaces as `500` (engine invariant) | `recording.auth_segment (started)` |
| `POST /api/sessions/:id/recording/auth/end` | — | `EndAuthSegmentResponse` — `checkpointId`, `storageStateSaved`, `postLoginUrl?` | `409` no live recording; no open segment surfaces as `500` (engine invariant) | `recording.auth_segment (ended)` |

### Analysis

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `POST /api/sessions/:id/analysis` (**202**) | `StartAnalysisRequest` — `staticSectionMode` (default `separate`), `captureScreenshots` (default `true`), `llmProvider?` (`gemini`\|`stub`\|`none`, overrides env) | `StartAnalysisResponse` — `analysisId` (= sessionId), `status: analyzing`, `phase` | `404` unknown session; `409` live worker already exists; `409` no `recording.json`; `400` `llmProvider: gemini` without `GEMINI_API_KEY` | `session.status (analyzing)`; `analysis.progress` throughout; on a login pause: `session.status (awaiting-auth)` + `replay.auth_required` (+ `replay.auth_state` mirrors); finally `analysis.complete` or `analysis.error`, then `session.status (analyzed` \| `failed)` |
| `GET /api/sessions/:id/analysis` | — | `AnalysisResult` (persisted `analysis.json`, schema-validated on read) | `404` no analysis yet | — |

### Replay auth (pause-for-login)

There is deliberately **no standalone replay endpoint** — replay only runs as the first stage of an analysis; these routes act on the embedded replay. Full flow: [auth-flows.md](./auth-flows.md#2-replay-the-pause-for-login-machine).

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `POST /api/sessions/:id/replay/auth/continue` | — | `ContinueReplayAuthResponse` — `state`, `reason?`. A failed validation is **200 with `reason`** (`not-paused`, `still-on-auth-page`, `password-field-still-present`, …), not an HTTP error | `409` no live analysis | `replay.auth_validating`, then `replay.auth_resolved` (+ `session.status (analyzing)`) or `replay.auth_failed` followed by a re-emitted `replay.auth_required` |
| `POST /api/sessions/:id/replay/auth/cancel` | — | `CancelReplayAuthResponse` — `state` | `409` no live analysis | `replay.auth_state (cancelled)`; the analysis then completes over the partial capture (manifest marked truncated) |

### Browsers

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `GET /api/browsers` | — | `ListBrowsersResponse` — installed browsers with `profilePath`/`profileSupported` | — | — |
| `POST /api/browsers/profile-probe` | `ProfileProbeRequest` — `browserType`, `browserName` | `ProfileProbeResponse` — `status` ∈ `usable`\|`locked`\|`no_profile`\|`error` + message | `400` unknown browser name | — |

### Storage state (saved logins)

Metadata and behavioural validation only — **cookie/token values never leave the server**.

| Method + path | Request | Response | Errors | SSE |
|---|---|---|---|---|
| `GET /api/sessions/:id/storage-state/status` | — | `StorageStateStatusResponse` — `present`, `expired` (nullable), `earliestExpiry`, `message` | `404` unknown session | — |
| `POST /api/sessions/:id/storage-state/validate` | `ValidateStorageStateRequest` — `probeUrl?` (default: session URL), `successSelector?`, `timeoutMs?` | `ValidateStorageStateResponse` — `ok`, `elapsedMs`, `reason?` (`storage-state-missing`, `landed-on-auth-page`, probe error) | `404` unknown session; `400` validation | — |
| `GET /api/storage-state/find?url=` | `FindStorageStateQuery` — `url` (http/https) | `FindStorageStateResponse` — `matches[]`, newest first. **Shallow match** (file exists + same hostname); `validated` is always `false` here — deep validation happens at reuse time (`POST /api/sessions` with `reuseStorageStateFrom`) | `400` invalid url | — |

### Events (SSE)

| Method + path | Contract |
|---|---|
| `GET /api/sessions/:id/events` | `text/event-stream`; one stream per session. Each message's `id:` is a per-session monotonic integer and its `data:` is a JSON object matching `sseEventSchema` — full catalog, payloads and reconnect semantics in **[sse-events.md](./sse-events.md)**. `404` for unknown sessions (checked against the on-disk session layout). Reconnects send `Last-Event-ID` and the ring buffer (last 500 events) replays everything newer; a keep-alive named `ping` event (no `id:`) fires every 25 s and never reaches `onmessage` or advances `Last-Event-ID`. |

## Generated OpenAPI

[`docs/openapi.json`](./openapi.json) is the committed OpenAPI 3 document generated by `@nestjs/swagger` + nestjs-zod's `cleanupOpenApiDoc` (DTO schemas are derived from the same `@waa/shared` zod schemas the runtime validates with, so the document tracks contract changes automatically — [ADR 0004](./adr/0004-zod-contracts.md)).

- **Live**: Swagger UI at `http://localhost:3002/api/docs`, raw JSON at `http://localhost:3002/api/docs-json`.
- **Regenerate the committed copy** after changing any route or shared schema:

  ```powershell
  npm run build
  $env:API_PORT = "3013"; node apps/api/dist/main.js   # any free port
  # in a second terminal:
  curl -s http://localhost:3013/api/docs-json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').writeFileSync('docs/openapi.json',JSON.stringify(JSON.parse(d),null,2)+'\n'))"
  ```

  then stop the server. The document is a build artifact: never edit it by hand.

Caveat: the SSE endpoint appears in OpenAPI as a plain `GET` returning `200` — OpenAPI cannot express an event stream; [sse-events.md](./sse-events.md) is its real contract.
