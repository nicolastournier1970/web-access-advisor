# Development guide

How to build, run, and extend Web Access Advisor v2. Windows-first (the primary dev environment is Windows 11 / PowerShell); everything also runs on Linux/macOS with the same commands.

Companion docs: [architecture.md](./architecture.md) (what the pieces are), [testing.md](./testing.md) (how they are tested), [api-reference.md](./api-reference.md) (routes), [rewrite-plan.md](./rewrite-plan.md) (history and rationale).

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node 24.x** | Angular 21 toolchain baseline (Angular 22 is blocked on Node ≥ 24.15 — rewrite-plan, Phase 4) |
| **npm** (ships with Node) | Plain npm workspaces — no Nx, no pnpm ([ADR 0002](./adr/0002-npm-workspaces-not-nx.md)) |
| **Playwright browsers** | `npx playwright install chromium` after install (firefox/webkit optional). Edge/Chrome *profile* launches run on the bundled chromium binary, so chromium is always required |
| `GEMINI_API_KEY` (optional) | Without it the LLM provider defaults to `stub` — everything works offline except real AI findings |

## Install, build, run

```powershell
npm install
npm run build      # tsc project chain: shared → engine → api, then ng build
npm test           # all workspace suites (see testing.md)
npm run dev        # NestJS API on :3002 + Angular dev server on :4300 (proxied)
```

`npm run dev` gives you the app at `http://localhost:4300`; the Angular dev server proxies `/api` to `http://localhost:3002` (`apps/web/proxy.conf.json`). Health check: `http://localhost:3002/api/health`; Swagger UI: `http://localhost:3002/api/docs`.

### Per-workspace loops

Build order matters (`shared` → `engine` → `api`); each package's `build` is plain `tsc -p tsconfig.json`.

| Workspace | Watch loop |
|---|---|
| `packages/shared` | `npx tsc -p packages/shared/tsconfig.json -w` |
| `packages/engine` | `npx tsc -p packages/engine/tsconfig.json -w` (plus `npm run test:watch -w @waa/core` for vitest) |
| `apps/api` | `npx tsc -p apps/api/tsconfig.json -w` in one terminal, `node apps/api/dist/main.js` (restart on change) in another. The API always runs from `dist/` — the supertest suite also imports the compiled output because vitest/esbuild cannot emit the decorator metadata Nest needs |
| `apps/web` | `npm run dev -w @waa/web` — `ng serve` with proxy on **:4300** (4200 is occupied on the primary dev machine; see ports table) |

### Environment

Parsed once at bootstrap by the zod schema in [`apps/api/src/config/env.ts`](../apps/api/src/config/env.ts); empty-string values count as unset (so a blank `.env` line falls back to the default). See `.env.example` at the repo root.

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `3002` | API listen port |
| `GEMINI_API_KEY` | — | Enables the Gemini provider |
| `LLM_PROVIDER` | derived: key present → `gemini`, else `stub` | Explicit override (`gemini`\|`stub`) |
| `HTTPS_PROXY` | — | Outbound proxy for the Gemini client (per-client undici dispatcher, [ADR 0006](./adr/0006-llm-provider-abstraction.md)) |
| `SNAPSHOTS_DIR` | `./snapshots` | Session storage root |
| `AUTH_DOMAINS_CONFIG` | `./config/auth-domains.json` | User-editable auth-domain patterns (merged over built-in defaults) |
| `PLAYWRIGHT_HEADLESS` | `false` | Headed by default — recording in a visible browser is the product's point. Accepts `true/1/yes/on` etc. (`z.stringbool`) |
| `REPLAY_AUTH_TIMEOUT_MS` | `600000` | Pause-for-login budget (10 min) — [auth-flows.md](./auth-flows.md) |

## Workspace layout

```
web-access-advisor/
├─ apps/
│  ├─ web/                  # Angular 21 (standalone, signals, zoneless), Tailwind v4 + CDK
│  │  └─ src/app/{core,features,shared}   # api/sse clients + stores | pages | UI kit
│  └─ api/                  # NestJS 11
│     └─ src/{sessions,recording,analysis,browsers,storage-state,events,health,config,engine,common}
├─ packages/
│  ├─ shared/               # @waa/shared — zod v4 schemas + z.infer types ONLY
│  └─ engine/               # @waa/core — Playwright engine (recording/replay/snapshot/analysis/llm/auth/storage)
├─ e2e/
│  ├─ fixtures/             # static fixture site + serve.mjs (fake cookie login)
│  └─ parity/               # golden-session parity harness
├─ config/auth-domains.json # user-editable auth-domain patterns
├─ docs/                    # this documentation set + ADRs + openapi.json
└─ snapshots/               # session data (recording.json, storageState.json, step_NNN/, …)
```

Module boundary rules (who may import what) are enforced by ESLint — see [architecture.md § Module boundaries](./architecture.md#module-boundaries).

## Schema-first workflow: adding an endpoint

Contracts flow one way: `@waa/shared` schema → Nest DTO → Angular client → store ([ADR 0004](./adr/0004-zod-contracts.md)). Example — a hypothetical "rename session" endpoint:

**1. Define the schema in `packages/shared/src/api/`** (and export it from `index.ts`):

```ts
// packages/shared/src/api/sessions-api.schema.ts
export const renameSessionRequestSchema = z.object({
  name: z.string().min(1).max(200),
});
export type RenameSessionRequest = z.infer<typeof renameSessionRequestSchema>;
```

**2. Controller with a `createZodDto` class** (the global `ZodValidationPipe` parses it automatically; invalid bodies become the `400` error envelope):

```ts
// apps/api/src/sessions/sessions.controller.ts
class RenameSessionDto extends createZodDto(renameSessionRequestSchema) {}

@Post(':id/name')
@HttpCode(200)
rename(@Param('id') id: string, @Body() body: RenameSessionDto): Promise<SessionSummary> {
  return this.sessions.rename(id, body.name);
}
```

**3. Api-client method** — the only HTTP surface of the web app; parse the *response* with its schema so malformed data fails at the boundary:

```ts
// apps/web/src/app/core/api/api-client.ts
renameSession(id: string, body: RenameSessionRequestInput): Promise<SessionSummary> {
  return this.request(sessionSummarySchema, 'POST', `/sessions/${encodeURIComponent(id)}/name`, body);
}
```

Request payloads are typed as `z.input<>` (defaults applied server-side) and `null`/`undefined` fields are stripped before serializing — omit empty optionals, never send `null`.

**4. Store method** (signal stores own all state; components stay dumb):

```ts
// apps/web/src/app/core/stores/sessions.store.ts
async rename(id: string, name: string): Promise<void> {
  const updated = await this.api.renameSession(id, { name });
  this.sessionsState.update((list) => list.map((s) => (s.sessionId === id ? updated : s)));
}
```

**5. Rebuild `@waa/shared`**, then api/web pick up the types. Add a fixture test in `packages/shared/src/__tests__/` if the schema validates an on-disk format, and regenerate [`docs/openapi.json`](./api-reference.md#generated-openapi).

If the endpoint emits realtime events, extend the discriminated union in `packages/shared/src/events/sse-events.schema.ts` and document it in [sse-events.md](./sse-events.md) — the events module validates every published event against that union, so an unregistered event type throws at the publish site.

## Engine test seams

Everything Playwright-facing in the engine is expressed against narrow structural interfaces plus an injectable `deps` parameter — `RecorderDeps` ([`recorder.ts`](../packages/engine/src/recording/recorder.ts)) and `AnalyzerDeps` ([`analyzer.ts`](../packages/engine/src/analysis/analyzer.ts)). Production callers pass nothing (the default launcher lazy-imports `playwright`); tests inject fakes — or a *real* browser they keep a handle to, which is how the auth-v2 gate signs in mid-replay:

```ts
const control = runAnalysis(options, {
  // Replace the default Playwright launch; keep the page to drive it from the test.
  launch: async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = (await context.newPage()) as Page;
    return { browser, context, page };
  },
  clock: () => fakeNow,                                   // auth-pause timeout is clock-injected
  timers: fakeTimers,                                     // ...and timer-injected
  axeRunner: async () => ({ violations: [] }),            // no real axe in unit tests
  settleDelaysMs: { navigate: 100, click: 100, default: 50 },
  snapshotRetryDelayMs: 50,
});
```

Unit tests with an injected `launch` never load Playwright at all. The same pattern covers `validateStorageState` (`launchBrowser` seam) and `createRecorder` (`launch` + `clock`).

## Debugging SSE with curl

The stream is plain HTTP ([ADR 0003](./adr/0003-sse-over-websocket.md)) — no special client needed:

```powershell
# live stream (also replays the session's ring buffer — up to the last 500 events)
curl -N http://localhost:3002/api/sessions/<sessionId>/events

# simulate a reconnect that already saw event id 42
curl -N -H "Last-Event-ID: 42" http://localhost:3002/api/sessions/<sessionId>/events
```

What you'll see: `id: <n>` + `data: {"type":"recording.action",...}` blocks (the JSON `type` field is the discriminator — the SSE `event:` field is unused for data events), and an `event: ping` keep-alive every 25 s (no `id:`, ignored by `EventSource.onmessage`). Unknown session ids are a `404` with the error envelope. Full catalog: [sse-events.md](./sse-events.md).

## The zod-v4-per-package rule

Every package that imports zod **must declare `"zod": "^4.0.0"` in its own `package.json`** (`shared`, `engine`, `api`, `web` all do). History: until the Phase 7 cutover the root hoisted zod 3 (via legacy deps), so a package relying on hoisting could silently resolve the wrong major — `z.stringbool`, `z.url({ protocol })` and friends are v4-only, and `instanceof ZodError` fails across copies (which is why the API's exception filter duck-types on `issues` instead). `apps/api` additionally needs a nestjs-zod release with a zod ^4 peer range (5.4+). Sanity check: `npm ls zod`.

## Ports

| Port | What | Where set |
|---|---|---|
| **3002** | NestJS API (`/api`, `/api/docs`) | `API_PORT` default ([`env.ts`](../apps/api/src/config/env.ts)); `apps/web/proxy.conf.json` targets it |
| **4300** | Angular dev server | `npm run dev -w @waa/web` (`--port 4300` — chosen because 4200 is occupied on the primary dev machine) |
| **4310** | Fixture site as started **by the auth-v2 gate spec** (it spawns `e2e/fixtures/serve.mjs 4310` itself) | [`auth-v2-e2e.spec.ts`](../packages/engine/src/analysis/auth-v2-e2e.spec.ts) |
| *(4300)* | Fixture site default when run standalone — **clashes with the web dev server**, so pass a port: `npm run fixture:serve -- 4310` | [`e2e/fixtures/serve.mjs`](../e2e/fixtures/serve.mjs) |
| **5500** | Static server for `snapshots/waa_test/` golden sessions during parity runs | [testing.md § parity harness](./testing.md#the-parity-harness) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Recording starts with "profile could not be used; continuing with a clean browser session" | The requested browser profile is **locked** by a running Edge/Chrome/Firefox. Close the real browser, or probe first: `POST /api/browsers/profile-probe` (`status: locked`). The fallback is deliberate — a clean session with a warning beats a failed launch |
| `browserType.launch: Executable doesn't exist …` | Playwright browsers not installed: `npx playwright install chromium` |
| `ng serve` fails: port 4200/4300 in use | 4200 being occupied is expected (that's why dev runs on 4300). If 4300 is also taken: `npm run dev -w @waa/web -- --port 4301` |
| API fails to boot: `EADDRINUSE :3002` | Another API instance (or the old dev loop) is alive. Find it: `netstat -ano \| findstr :3002`, then `taskkill /PID <pid> /F`. Remember the web proxy is pinned to 3002 — if you move `API_PORT`, update `apps/web/proxy.conf.json` |
| Engine test run takes minutes / needs a display | The engine suite includes real-browser smokes and the auth-v2 gate. `WAA_SKIP_BROWSER_TESTS=1` runs only the fast unit tests ([testing.md](./testing.md#skipping-real-browser-tests)) |
| Web UI: every API call 404s | The Angular dev server is running without the API (proxy target down). Start `npm run dev` (both) or the API separately |
| Analysis pauses for login on a public site | A URL matched the auth-domain config too eagerly — check `config/auth-domains.json` patterns (substring host match; segment-aware path match). See [auth-flows.md](./auth-flows.md#pause-triggers-exactly-as-implemented) |
| Zod error mentions a missing v4 API (e.g. `z.stringbool is not a function`) | The package resolved a hoisted zod 3 — declare `"zod": "^4.0.0"` in that package's own `package.json` (see above) and reinstall |
