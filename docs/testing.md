# Testing

The test pyramid as actually built: fast, deterministic unit suites in every workspace (fakes injected at documented seams), a small set of real-browser smokes plus the auth-v2 end-to-end gate inside the engine suite, and a parity harness that pins the new engine against legacy golden output. Everything runs with `npm test` from the root; the LLM is always stubbed or absent in tests.

Sources of truth: the `*.spec.ts` files next to each module; [`e2e/parity/compare-manifests.mjs`](../e2e/parity/compare-manifests.mjs); [`e2e/fixtures/`](../e2e/fixtures). Counts below are as of the Phase 6 gate ([rewrite-plan.md § Progress](./rewrite-plan.md#progress)) and grow with the code — treat the *shape*, not the numbers, as normative.

## The pyramid

| Suite | Tests | Runner | What it covers |
|---|---|---|---|
| `packages/shared` | 17 | vitest | Schema fixture tests: **every real `recording.json` / `manifest.json` under `snapshots/` must parse** (legacy compatibility is a test, not a promise), plus adversarial cases (v1/v2 discrimination, `z.never().optional()` for the "no formatVersion" rule, redaction constants, SSE union completeness) |
| `packages/engine` | 369 | vitest | The bulk. Pure logic exhaustively (AuthCheckpointMachine full transition table, selector engine, recorder-state segment/discard semantics, v1→v2 loader, DOM-change detector, HTML scrubber, batching, login-wall heuristics, manifest step-join regression) + orchestration wiring against fake pages/contexts via the `RecorderDeps`/`AnalyzerDeps` seams ([development.md § Engine test seams](./development.md#engine-test-seams)) + **real-browser smokes and the auth-v2 gate** (below) |
| `apps/api` | 27 | vitest + supertest | Every controller against the **compiled Nest app with a fake engine** (the `ENGINE` token is overridden; no Playwright, no browsers): route contracts, error envelope, 404/409 semantics, SSE ring-buffer + `Last-Event-ID` replay, env schema. Specs import the compiled `dist/` build because vitest/esbuild cannot emit Nest's decorator metadata — `npm test -w @waa/api` builds first |
| `apps/web` | 71 | vitest + jsdom | Signal stores against fake `FETCH`/`EVENT_SOURCE_FACTORY` tokens (SSE event → state transitions, `fromStep` mapping, interrupted handling), api/sse client boundary parsing (invalid payloads dropped/rejected), and component tests asserting **accessibility semantics** — roles, names, `aria-live`, focus behaviour — for the high-value components (action feed, auth banners, results view, CSV export) |

### Real-browser tests inside the engine suite

Four `describe` blocks launch real headless chromium; everything else in the suite is browser-free:

| Spec | What it proves |
|---|---|
| `recording/recorder.spec.ts` → "browser smoke" | End-to-end capture wiring, and that typed credentials appear nowhere in memory or on disk even *without* a marked segment (source-level redaction) |
| `snapshot/snapshotter.spec.ts` → "browser smoke (chromium)" | Real snapshot capture: scrubbed HTML + real axe scan + screenshot land in `step_NNN/` |
| `analysis/analyzer.spec.ts` → "browser smoke (analyzer)" | The full analyze pipeline over a data-URL page with real axe |
| `analysis/auth-v2-e2e.spec.ts` — **the Phase 6 gate** | Journeys A/B/C against the fixture login site (spec serves it itself on :4310): marked-segment recording persists zero credentials and saves storage state; replay pauses at the recorded checkpoint, rejects a premature continue, resumes after a real sign-in; a seeded saved login replays with zero pauses. Detailed walkthrough: [auth-flows.md § worked example](./auth-flows.md#5-worked-example-the-phase-6-gate-journeys) |

### Skipping real-browser tests

```powershell
$env:WAA_SKIP_BROWSER_TESTS = "1"; npm test -w @waa/core
```

All four blocks above are `describe.skipIf(process.env.WAA_SKIP_BROWSER_TESTS === '1')`. Use it for fast inner-loop runs and environments without Playwright browsers; CI and anything touching recording/replay/snapshot/auth code must run the full suite.

## The parity harness

[`e2e/parity/compare-manifests.mjs`](../e2e/parity/compare-manifests.mjs) replays **golden sessions** from `./snapshots/` through the new engine (axe-only, headless, clean browser) into `e2e/parity/.out/` and compares against the legacy artifacts already committed on disk — the legacy engine is never executed; its output *is* the baseline.

```powershell
npm run build          # parity imports packages/{shared,engine}/dist
npm run parity         # every golden session
npm run parity -- session_1755656440621_9w7pfo5ce   # or specific ids
```

Pass criteria per session:

| Check | Asserts |
|---|---|
| **P1** | `result.success === true` and the new manifest validates against `sessionManifestSchema` |
| **P2** | Every recorded action received a replay outcome; **≥ 80% `executed`** (non-executed outcomes are listed with their detail) |
| **P3** | Step-join correctness: every new `stepDetail`'s action matches the recording action with the **same step number** — the regression guard for the legacy `actions[i]`/`snapshots[i]` misalignment bug |
| **P4** | Axe overlap: **≥ 50%** of the legacy session-wide rule-id set is found by the new run (live-site drift makes exact equality unrealistic; missing/extra ids are printed for review) |
| report-only | Snapshot-step set differences are printed but never fail the run — snapshot gating is intentionally sensitive to live-DOM timing |

Requirements:

- **Network access** — most golden sessions were recorded against live public sites (the HBS design-system preview among them), so axe overlap drifts with those sites; a pause for login on any golden session is treated as unexpected and cancelled so the harness fails visibly instead of hanging.
- **`waa_test/` served on port 5500** — several golden sessions were recorded against the repo's own static defect site at `http://127.0.0.1:5500/` (VS Code Live Server's default). Serve it with any static server before the run, e.g. `npx http-server waa_test -p 5500`. These sessions are the strictest signal: identical snapshot steps and 100% axe overlap at the Phase 2e gate.

When to run: after any change to the replayer, selector engine, snapshot gating, manifest builder, or axe integration — and as a gate before large merges (it gated Phase 2 and the cutover).

## The fixture site

[`e2e/fixtures/site/`](../e2e/fixtures/site) is a deterministic, dependency-free static site with **intentional accessibility violations** (do not fix them) and a fake cookie login. Serve standalone with `npm run fixture:serve -- 4310` (the default port 4300 clashes with the Angular dev server; the auth gate spec spawns its own copy on 4310).

| Page | Contents | Intentional violations |
|---|---|---|
| `index.html` | Nav + intro | Image without `alt`; low-contrast text; button with no accessible name |
| `form.html` | Feedback form | Input without a label |
| `login.html` | Username/password form (`data-testid` hooks) | — (it exists for the auth flows) |
| `protected.html` | "Member dashboard" behind a client-side cookie wall | Data table without headers; link with no discernible text |

Login mechanics: any username with password `letmein` sets a 1-hour `waa_session` cookie and redirects to `protected.html`; `protected.html` bounces to `login.html` without the cookie. The server (`serve.mjs`) is stateless — **the cookie is the session**, so login state survives server restarts and storage-state reuse is testable without a backend. Note `/login.html` deliberately does *not* match the `/login` auth path pattern (segment-aware matching), so the gate exercises checkpoint and heuristic pauses rather than URL classification.

## Adding tests per layer

- **`packages/shared`** — for a schema that validates an on-disk format, add fixture tests that parse *real* files from `snapshots/` (the suite already walks them); for API DTOs, cover defaults and rejection cases (remember: zod defaults absorb absent keys only, and `.refine()` cannot see unknown keys).
- **`packages/engine`** — default to browser-free: inject `launch`/`clock`/`timers`/`axeRunner` fakes through `RecorderDeps`/`AnalyzerDeps` and drive the narrow `*Like` structural interfaces. Add to a real-browser smoke only when the behaviour genuinely lives in Playwright (and guard it with the `WAA_SKIP_BROWSER_TESTS` skip).
- **`apps/api`** — extend `apps/api/test/`: build a testing module via the shared `configureApp` wiring, override the `ENGINE` token with a fake implementing `EngineFacade`, assert with supertest against the HTTP surface (status, envelope, SSE frames). Never launch a browser here — engine behaviour is the engine suite's job.
- **`apps/web`** — stores first: provide fake `FETCH` / `EVENT_SOURCE_FACTORY` tokens and assert signal transitions per SSE event. Component tests should assert the accessibility contract (roles, accessible names, live-region announcements, focus trap/restore), not markup details.
- **Cross-cutting engine behaviour** (recording→replay→auth) belongs in the auth-v2 gate spec's style: real chromium against the fixture site, driving the engine through its public API (`createRecorder`, `runAnalysis`) with a held page reference.
