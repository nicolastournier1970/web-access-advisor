# Web Access Advisor v2 — Rewrite Plan (Angular + NestJS)

> **Status**: in progress on branch `refactor`. See [Progress](#progress) at the bottom.
> Decision records live in [docs/adr/](./adr/). This document is the working plan and is updated as phases complete.

## 1. Context — why a rewrite

Web Access Advisor records a browsing session in a real (headed) Playwright browser, replays it with snapshot capture (HTML + axe-core + screenshots, gated by smart DOM-change detection), and produces AI-assisted accessibility findings merged with axe violations. Sessions persist under `./snapshots/<sessionId>/`.

The v1 implementation (React 18 + Express + `packages/core`) works but accumulated debt that makes incremental improvement more expensive than a rewrite:

| Area | Confirmed problems in v1 |
|---|---|
| Frontend | ~1,400-line `App.tsx` god component; no router; manual `setInterval` polling (1 s action feed, 2 s analysis status); promise-bridged modals; two competing API clients (one dead); ~15 dead files; types duplicated with `packages/core` and drifted |
| Backend | Single global analyzer + recording singleton → effectively single-user; all state in memory (lost on restart, never GC'd); 1,250+ line monoliths |
| Recording/replay | Crude selectors (`#id` → first class → `nth-child`) break replays; `actions[i]`/`snapshots[i]` misalignment bug attributes wrong actions to manifest steps; auth-domain detection hardcodes client domains (PowerApps/gov.au) and misclassifies everything else as `external_redirect` |
| **Security (login)** | Recorder captures **passwords in plaintext** into `recording.json`; replay re-types them; snapshots of filled forms can reach the cloud LLM; `storageState.json` holds live cookies unencrypted; one re-login fallback saves an *empty* browser state as if it were valid auth; the redaction helper is dead code |
| Auth UX | Validate/Re-login UI orphaned in dead components; saved logins reused *without validation*; fresh recordings' storageState invisible to reuse (discovery requires `manifest.json`, which only exists after analysis); replay hitting a login wall aborts or silently analyzes login pages |

**Goal**: rewrite end-to-end with best practices and full documentation. Headline improvement: first-class login handling — **auth checkpoints at recording time** (credentials never touch disk) and **pause-for-login during replay**.

## 2. Locked decisions

1. **Full rewrite**: Angular (latest stable — standalone components, signals, zoneless change detection, OnPush, typed forms, `inject()`) + **NestJS** backend. Engine refactored into a clean workspace library. (Angular re-confirmed over Vue after explicit comparison — see ADR 0001.)
2. **UI**: Tailwind CSS + **Angular CDK** primitives only (dialog/overlay, focus trap, LiveAnnouncer, a11y). No Material/PrimeNG. The tool's own UI must be exemplary on accessibility (ADR 0007).
3. **Repo**: same repo — workspace layout `apps/*` + `packages/*` on branch `refactor`. At cutover the legacy app is removed **on this branch only** (user-confirmed 2026-07-08): the pre-deletion commit is tagged `v1-legacy` and `main` still carries the full v1 app, so recovery is one `git checkout v1-legacy` away.
4. **Auth headline**: pause-for-login during replay via a first-class auth-checkpoint state machine (ADR 0005).

Supporting decisions (each has an ADR):

- **Plain npm workspaces, not Nx** (ADR 0002) — boundaries via tsconfig path aliases + ESLint rules; `apps/web` may import only `@waa/shared`.
- **SSE, not WebSockets** (ADR 0003) — all realtime traffic is server→client; commands are validated POSTs; `Last-Event-ID` + per-session ring buffer handles reconnects.
- **Zod v4 contracts in `@waa/shared`** (ADR 0004) — one schema source for Nest DTO validation/OpenAPI, Angular boundary parsing, and file-format validation.
- **LLM provider abstraction** (ADR 0006) — `GeminiProvider` (per-client undici dispatcher, no global fetch patch) + `StubProvider` for tests/CI.

## 3. Target workspace layout

```
web-access-advisor/
├─ package.json                 # workspaces: ["apps/*", "packages/*"]
├─ tsconfig.base.json           # @waa/shared, @waa/core aliases; strict
├─ eslint.config.mjs            # flat config + module boundary rules
├─ config/auth-domains.json     # user-editable auth-domain patterns
├─ apps/
│  ├─ web/                      # Angular, standalone, zoneless, Tailwind + CDK
│  └─ api/                      # NestJS
├─ packages/
│  ├─ shared/                   # @waa/shared — zod schemas + inferred types only
│  ├─ core/                     # @waa/core — Playwright engine (no HTTP imports)
│  └─ cli/                      # parked; re-ported in Phase 8
├─ e2e/                         # Playwright: fixtures/site/ (fake login), specs/, parity/
├─ docs/                        # architecture, auth-flows, formats, ADRs, OpenAPI
└─ snapshots/                   # unchanged; gains snapshots/index.json session index
```

## 4. Angular app (`apps/web`)

Routes replace the v1 single-page mode switch (deep-linkable, refresh-safe; a `sessionResolver` recovers state from the API):

| Path | Page | Replaces (v1) |
|---|---|---|
| `/` | setup — URL input, browser/profile picker, recent sessions | setup mode |
| `/sessions` | session browser | SessionSelector |
| `/sessions/:id/record` | live action feed, **mark-login toggle**, stop | recording mode |
| `/sessions/:id/analyze` | three-phase progress, **auth-checkpoint banner** | analyzing mode |
| `/sessions/:id/results` | AI findings + axe table + screenshots + export | results mode |

Key structure:

- `core/api/api-client.ts` — the **only** HTTP surface; every response zod-parsed at the boundary.
- `core/api/sse-client.ts` — EventSource wrapper: typed events, Last-Event-ID resume, `connectionState` signal.
- `core/stores/` — signal stores (`recording`, `analysis`, `auth`, `sessions`); SSE dispatcher feeds them; zoneless change detection reacts natively.
- `core/a11y/announcer.service.ts` — CDK LiveAnnouncer; phase transitions announced politely.
- `shared/ui/` — small UI kit on CDK primitives; `confirm-dialog` (focus trap/restore) replaces v1's promise-bridged modals.
- `features/` — setup, record (action feed `role="log"` `aria-live="polite"`, virtualized), analyze, results, sessions.
- Styling: Tailwind + `styles/theme.css` porting the v1 "Blueberry" design tokens.
- Export: print stylesheet + `window.print()` (replaces jspdf/html2canvas); revisit only if a PDF lib is genuinely needed.

## 5. NestJS app (`apps/api`)

- `main.ts`: global ZodValidationPipe (nestjs-zod), Swagger UI at `/api/docs`, `enableShutdownHooks()` closes live browsers gracefully.
- `config/env.schema.ts` (zod-validated env): `API_PORT`, `GEMINI_API_KEY?`, `LLM_PROVIDER (gemini|stub)`, `HTTPS_PROXY?`, `AUTH_DOMAINS_CONFIG`, `SNAPSHOTS_DIR`, `PLAYWRIGHT_HEADLESS`, `REPLAY_AUTH_TIMEOUT_MS`.
- Modules:

| Module | Responsibility |
|---|---|
| `sessions` | List/get/delete; snapshot file serving; **disk-backed session store** (`snapshots/index.json` + per-session `session.json`) that survives restarts (interrupted sessions marked, not lost); **SessionWorker registry** — per-session isolation replacing the global singleton; idle GC; graceful shutdown |
| `recording` | `POST /api/sessions` (start), `POST /:id/recording/stop`, `POST /:id/recording/auth/start\|end` (login segments); recorder events → SSE |
| `replay` | `POST /:id/replay/auth/continue\|cancel`; drives the auth-checkpoint machine |
| `analysis` | `POST /:id/analysis` (202; progress over SSE), `GET /:id/analysis`; result persisted to `snapshots/<id>/analysis.json` |
| `browsers` | `GET /api/browsers`, `POST /api/browsers/profile-probe` |
| `storage-state` | status / validate / `GET /api/storage-state/find?url=` (**validated** cross-session reuse; index includes recording-only sessions) |
| `events` | `@Sse('sessions/:id/events')`; per-session Subject + ring buffer (500 events, monotonic ids) |
| `llm` | provider token → Gemini or Stub by env |

Deliberately **not ported** from v1: interactive-relogin (incl. the empty-storageState fallback), the auth-detour endpoint trio, the 3-second URL-mismatch heuristic, raw cookie-file "login detection" — all superseded by auth segments + pause-for-login.

## 6. Core engine refactor (`packages/core` → `@waa/core`)

Public API: `createRecorder`, `createReplayer`, `runAnalysis`, `loadRecording`, `saveRecording`, `detectBrowsers`, `validateStorageState`. No HTTP framework imports; communicates via typed events/callbacks.

```
recording/recorder.ts               # from BrowserRecordingService; honors auth segments
recording/injected/recorder-script.ts  # in-page script; sensitive inputs never emit values
recording/selector-engine.ts        # ranked locator candidates (below)
replay/replayer.ts                  # candidate fallback chain; outcomes executed|skipped|failed
replay/auth-checkpoint.ts           # AuthCheckpointMachine — pure, unit-testable
snapshot/snapshotter.ts             # HTML + axe + screenshot with retries
snapshot/dom-change-detector.ts     # significant-change gating (ported)
snapshot/html-scrub.ts              # NEW: strip filled values/password fields before disk/LLM
analysis/analyzer.ts                # orchestration; keeps v1 onProgress phase vocabulary
analysis/batching.ts                # hierarchical batching + progressive summary (ported)
analysis/manifest-builder.ts        # FIX: join snapshots↔actions on step, never array index
llm/{provider,gemini.provider,stub.provider,prompts,slimming}.ts
auth/domain-config.ts               # loads config/auth-domains.json
auth/login-detection.ts             # login-wall heuristics
storage/recording-format.ts         # v2 writer + v1→v2 in-memory loader
storage/session-files.ts            # path conventions (disk layout unchanged)
browsers/detect.ts                  # table-driven per-OS profile paths
```

### Selector engine
Ordered locator candidates per interacted element:
`data-testid` → stable `#id` (auto-generated-looking ids rejected) → ARIA `{role, name}` (`getByRole`) → exact text (links/buttons) → stable CSS (utility/hashed classes rejected) → nth-child path (last resort, = v1 behaviour). Replayer tries candidates in order with short timeouts.

### recording.json v2
Discriminated by top-level `formatVersion: 2` (absent → v1). Adds `target.candidates`, `redacted` flag, `authCheckpoints[]` (`{id, afterStep, reason: user-marked|auto-detected, loginUrl, postLoginUrl, storageStateSaved, startedAt, completedAt}`). v1 files are upgraded in memory and never rewritten; all existing sessions in `./snapshots/` stay loadable. Full spec: `docs/recording-format.md` (Phase 8).

### Auth-checkpoint state machine (headline)

States: `running → auth_required → validating → resuming → running`, plus `auth_failed` (→ back to `auth_required`), `cancelled`, `timed_out`.

Replay pauses (`auth_required`, headed browser kept alive on the login page) when:
1. it reaches a recorded `authCheckpoint.afterStep` and no **validated** storageState covers the target origin;
2. navigation lands on a configured auth domain, or the login-wall heuristic fires (password field present AND target candidates fail to resolve);
3. an action fails AND the login-wall heuristic fires.

Then: SSE `replay.auth_required` → UI banner + screen-reader announcement → user signs in **in the open browser** → `POST /:id/replay/auth/continue` → server validates (off auth domain, probe reachable) → saves fresh `storageState.json` (indexed for reuse) → resumes from the paused step. Failure keeps it paused with a reason; cancel aborts cleanly (partial snapshots kept, manifest notes truncation). Timeout default 10 min.

**Recording-side auth segments**: "I'm logging in now" toggle → actions during the segment are **discarded** (only the checkpoint marker persists — credentials never touch disk); storageState saved immediately at segment end. Auto-detect assist: `recording.auth_suspected` SSE event (auth-domain navigation or password-field focus) → accessible dialog offers to start a segment retroactively.

### SSE event catalog
`recording.action`, `recording.navigated`, `recording.auth_suspected`, `recording.auth_segment`, `analysis.progress`, `analysis.complete`, `analysis.error`, `replay.auth_required`, `replay.auth_validating`, `replay.auth_resolved`, `replay.auth_failed`, `replay.auth_state`, `session.status`.

## 7. Testing strategy

- **Unit (bulk, Vitest)**: core pure logic (selector engine, auth-checkpoint machine, format loader, DOM-change detector, batching, HTML scrubber), Nest services (`@nestjs/testing` + supertest), Angular signal stores.
- **Component (selective)**: ~6 high-value components asserting accessibility semantics (roles, names, `aria-live`, focus trap/restore); `vitest-axe` smoke checks.
- **E2E (small, Playwright)**: 4 journeys against a local fixture site (`e2e/fixtures/site/` — static pages with intentional a11y violations + fake login that sets a cookie): record→stop persisted; record with marked login → masked checkpoint + zero credential actions; analyze → manifest + axe results; replay hits login wall → pause → login → resume. LLM stubbed (`LLM_PROVIDER=stub`); recorder headless in e2e mode.
- **Parity harness** (`e2e/parity/compare-manifests.ts`): golden sessions from `./snapshots/` run through old engine vs new core in axe-only mode; asserts same executed-action sequence, explained snapshot-step differences, same axe rule-id sets per step. Gate for Phase 2 merge and again before cutover.
- **CI**: GitHub Actions, windows + ubuntu matrix: lint → typecheck → unit → e2e (ubuntu); LLM always stubbed.

## 8. Phases

| # | Phase | Scope | Effort | Gate |
|---|---|---|---|---|
| 0 | Scaffold | branch, workspaces, tsconfig.base, ESLint boundaries, Prettier, ADRs 0001–0007, `config/auth-domains.json` | S | — |
| 1 | Shared contracts | `@waa/shared` zod schemas (recording v1/v2, manifest, analysis, API DTOs, SSE union, config); fixture tests against real `snapshots/` files | M | fixture tests + adversarial schema review |
| 2 | Core engine refactor | split monoliths per §6; behavior-preserving port, then fixes (step join, swallowed failures, provider abstraction, config-driven domains, HTML scrub); selector engine; v2 format | **XL — long pole** | parity harness green |
| 3 | NestJS API | skeleton + env config + Swagger; disk-backed session store + worker registry + graceful shutdown; all modules; SSE + ring buffer; supertest | L | golden-session analyze end-to-end (stub LLM) |
| 4 | Angular shell + recording | workspace, zoneless, Tailwind theme port, UI kit + CDK plumbing, routes/stores/clients; setup + record pages | L | record→stop journey on new stack |
| 5 | Analysis + results UI | analyze page (SSE progress), results page (findings/axe/screenshots/print), sessions browser | M | component tests + vitest-axe |
| 6 | Auth v2 | recording auth segments end-to-end; replay pause-for-login end-to-end | L | fixture-login e2e journey green |
| 7 | Cutover | tag `v1-legacy` FIRST, then on this branch delete `src/`, `server/`, legacy `packages/core`/`packages/cli` leftovers, root Vite/Tailwind/PostCSS configs and legacy deps; new root scripts (`npm run dev` = Nest + Angular); rewrite README | S | full manual verification pass; `git checkout v1-legacy` restores v1 |
| 8 | Docs, CLI, CI | docs set (below), JSDoc pass, CLI re-port over `@waa/core`, GitHub Actions | M | — |

## 9. Documentation deliverables (Phase 8, drafted continuously)

| Path | Content |
|---|---|
| `README.md` | Rewritten: what/why, Windows-first quickstart, screenshots, architecture thumbnail |
| `docs/architecture.md` | System overview + Mermaid diagram (web ⇄ api ⇄ core ⇄ Playwright/LLM, disk layout) |
| `docs/api-reference.md` + `docs/openapi.json` | Generated OpenAPI (committed) + narrative; live Swagger at `/api/docs` |
| `docs/auth-flows.md` | State-machine diagrams, storageState lifecycle, security posture |
| `docs/recording-format.md` | recording.json v2 spec, v1 compat, manifest + step layout |
| `docs/sse-events.md` | Event catalog, reconnect semantics |
| `docs/development.md` | Workspace layout, run/debug on Windows, schema-first endpoint workflow |
| `docs/testing.md` | Pyramid, fixture site, parity harness, CI |
| `docs/adr/` | 0001–0007 (done) + any new decisions as they arise |

## 10. Verification plan (Windows, end-to-end)

1. **Dev loop**: `npm run dev` → Nest (watch) + `ng serve` with proxy; health at `/api/health`; Swagger at `/api/docs`.
2. **Public-site smoke**: record 5–6 actions on the HBS design-system preview site (used by existing golden sessions) → SSE feed → stop → analyze → results render; compare finding shapes against a legacy manifest.
3. **Login-site e2e**: fixture site — record with login segment (verify v2 checkpoints + zero credential actions); clear storageState → replay → pause banner → sign in → resume + fresh storageState. Repeat once against the real test portal.
4. **Restart resilience**: kill API mid-analysis → restart → session `interrupted`, not vanished; SSE reconnects via Last-Event-ID.
5. **Parity gate** before Phase 3 merge and before cutover.

---

## Progress

- [x] **Phase 0 — Scaffold** (commit `073edbd`): workspaces extended to `apps/*`; `tsconfig.base.json` (`@waa/shared`, `@waa/core`); flat ESLint with boundary rules; Prettier; ADRs 0001–0007; `config/auth-domains.json` seeded with the four previously hardcoded domains.
- [x] **Phase 1 — Shared contracts**: `packages/shared` (recording v1/v2 + auth checkpoints + target candidates, manifest, analysis/axe, API DTOs, SSE union, error/health envelopes, auth-domains config). 17/17 tests — every real `recording.json`/`manifest.json` under `snapshots/` parses. An adversarial 3-lens review (legacy fidelity / zod v4 semantics / plan coverage) found and fixed: `wcagReference` is an object not a string (blocker — would have broken the whole results parse); LLM debug logs made representable; shadow-DOM axe targets widened; LLM-origin `impact`/`score` made degrade-not-fail; error envelope + health schemas added; retroactive auth-segment fields added (`suspectedAtStep`, `fromStep`); `z.url()` restricted to http/https (was accepting `javascript:`/`file:`); enum dedup.
- [ ] **Phase 2 — Core engine refactor** *(in progress)*:
  - [x] 2a Skeleton: `packages/engine` (`@waa/core`), `engine-types.ts` internal contracts (RecorderEvent/AnalyzeEvent unions, RecorderHandle, LlmProvider, AnalyzeControl).
  - [x] 2b Wave 1 leaf modules (commit `e982a7b`, 227 tests): storage (v1→v2 loader — all 59 real recordings upgrade), auth (config-driven classification, same-host fix), selector engine (ranked candidates, jsdom-tested), AuthCheckpointMachine (pure, full transition table), DOM-change detector + sensitive-value scrubber, LLM providers (undici REST Gemini, stub), browser detection (cookie-reading dropped).
  - [x] 2c Wave 2 (commit `812fe47`): recorder + injected script (in-page redaction, auth segments, storageState at segment end) | replayer (candidate fallback, structured outcomes, `redacted-credential` skip) + snapshotter (scrub-before-write). Real-browser smokes green.
  - [x] 2d Wave 3 (commit `290cae2`): analyzer orchestration with pause-for-login (pause → validate live page → save storageState → retry paused action; cancel/timeout truncate), manifest-builder step-join fix (regression-tested), batching with progressive-summary fix. `@waa/core` barrel compiles; 365 engine tests.
  - [x] 2e Parity gate GREEN (commit `46a7e1f`): all golden sessions pass — waa_test sessions identical snapshot steps + 100% axe overlap (needed serving `waa_test/` on :5500); public sessions 67–100% overlap (axe-version/live-site drift). Two fixes surfaced: login-wall false positive on pages with incidental password fields (now requires explicit failed-resolution signal) and per-action `actionOutcomes` added to the manifest. **Phase 2 complete.**
- [x] **Phase 3 — NestJS API** (commits `14e8d43`, `f686d63`): skeleton (env, SSE ring buffer + Last-Event-ID, health, error envelope, Swagger, nestjs-zod 5.4 with zod v4) + engine-backed modules (disk-backed session store with legacy folding + interrupted-marking, per-session worker registry with graceful shutdown, recording with auth segments + validated storageState reuse, analysis with pause-for-login mapped to SSE, replay auth continue/cancel, browsers, storage-state). 27 supertest specs on a fake engine; verified live against real `snapshots/` (legacy sessions listed with derived facts). SSE 404s unknown sessions.
- [ ] Phase 4 — Angular shell + recording flow
- [ ] Phase 5 — Analysis + results UI
- [ ] Phase 6 — Auth v2
- [ ] Phase 7 — Cutover (tag `v1-legacy`, then delete legacy on this branch; `main` unaffected)
- [ ] Phase 8 — Docs, CLI, CI

### Open items carried forward
- **Phase 6 decision**: mapping `recording.auth_suspected.suspectedAtStep` → `fromStep` when the user confirms a retroactive segment: for `auth-domain-navigation` the trigger IS a recorded step (use `suspectedAtStep − 1`); for `password-field` the trigger is a focus that was never recorded (use `suspectedAtStep`). Decide + test in Phase 6.
- **Phase 8 docs reconciliation**: `docs/sse-events.md` says fresh SSE connections are live-only, but the implemented events module replays the buffer to fresh connections too (per its tests). Pick one (probably implementation) and align doc + tests.
- SSE controller streams for unknown session ids — add a session-store existence guard when the sessions module lands (Phase 3 rest).

### Notes / deviations
- Branch is `refactor` (created in VS Code) rather than the originally planned `rewrite/angular-nest`.
- Zod v4 gotcha found by tests: `.refine()` can't see unknown keys (stripped first) and `z.undefined()` makes a key required — the v1 "no formatVersion" rule uses `z.never().optional()`.
- **Two zod majors coexist in the workspace** until cutover: root hoists zod 3.x via `auto-playwright`→`openai`; `packages/shared` uses zod 4.x. Every new package that imports zod (`packages/core`, `apps/api`, `apps/web`) MUST declare `"zod": "^4.0.0"` in its own `package.json`, and `apps/api` must use a nestjs-zod release with a zod ^4 peer range. Add a CI check (`npm ls zod`) at Phase 8; the hoisted zod 3 copy disappears with `auto-playwright` in the Phase 7 cutover commit.
- There is deliberately no standalone `POST /:id/replay` endpoint — replay only runs as the first stage of an analysis; the auth continue/cancel routes act on the embedded replay.
- Client rule: omit empty optional request fields; the Angular api-client strips `null`/`undefined` before serializing (zod defaults absorb only absent keys, not `null`).
- The new engine lives in **`packages/engine`** (package name `@waa/core`), not `packages/core` as originally planned: the legacy server resolves `@web-access-advisor/core` from `packages/core` at runtime, and gutting it would break the legacy app before cutover. `packages/engine` stays the engine's home even after the legacy `packages/core` is deleted at cutover (no rename churn). Also: legacy `npm run build`/`build:server` must NOT be run on this branch — the legacy app runs from the prebuilt `server/dist`.
