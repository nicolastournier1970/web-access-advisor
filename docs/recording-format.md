# recording.json format

Specification of the versioned recording file at `snapshots/<sessionId>/recording.json`, plus the surrounding on-disk session layout.

Sources of truth (this document describes them; on any conflict the code wins):

- Schemas: [`packages/shared/src/recording/recording.schema.ts`](../packages/shared/src/recording/recording.schema.ts)
- Loader / writer / upgrade: [`packages/engine/src/storage/recording-format.ts`](../packages/engine/src/storage/recording-format.ts)
- Path conventions: [`packages/engine/src/storage/session-files.ts`](../packages/engine/src/storage/session-files.ts)
- Decision record: [ADR 0005 — recording.json v2](./adr/0005-recording-format-v2-auth-checkpoints.md)

## Versioning policy

Two formats exist on disk. The discriminator is the top-level integer `formatVersion`:

| On disk | Meaning |
|---|---|
| `formatVersion: 2` | v2 file, written by the rewrite. Validated against `recordingV2Schema` as-is. |
| No `formatVersion` key | v1 file, written by the legacy recorder. Validated against `recordingV1Schema` and **upgraded in memory** (see [v1 → v2 upgrade](#v1--v2-in-memory-upgrade)). |
| Any other `formatVersion` (including `1`) | Rejected with an error. v1 is defined by the *absence* of the key, never by `formatVersion: 1`. |

Rules:

- **v1 files are never rewritten.** There is no on-disk migration; every existing session under `./snapshots/` stays loadable forever, byte-identical.
- The v2 writer (`saveRecording`) always emits `formatVersion: 2`, validates the recording against `recordingV2Schema` before writing (refusing to persist an invalid in-memory state), and writes pretty-printed 2-space JSON. Because it writes the *parsed* value, schema defaults are materialized: every action carries an explicit `redacted`, and `authCheckpoints` is always present (possibly `[]`).
- Do not confuse `formatVersion` with `metadata.version`: v1 files carry a meaningless `metadata.version: "2.0.0"` string.

## Format v2 — field reference

### `RecordingV2` (top level)

| Field | Type | Required | Description |
|---|---|---|---|
| `formatVersion` | literal `2` | yes | Format discriminator. |
| `sessionId` | string | yes | Session identifier; matches the directory name under `snapshots/`. |
| `sessionName` | string | no | Human-readable name. |
| `url` | string | yes | Start URL the recording was launched against. |
| `startTime` | string (ISO 8601) | yes | Recording start. |
| `endTime` | string (ISO 8601) | no | Recording stop. |
| `duration` | number (ms) | no | `endTime − startTime`. |
| `actionCount` | integer ≥ 0 | no | Convenience count. Equals `actions.length` in files written by the v2 recorder, but the schema does not enforce the equality (which is what allows abbreviated examples like the v1 one below to remain schema-valid). |
| `actions` | `ActionV2[]` | yes | Recorded actions, in step order. |
| `authCheckpoints` | `AuthCheckpoint[]` | yes (defaults to `[]` on parse) | Login-segment markers. See below. |
| `browserType` | `"chromium" \| "firefox" \| "webkit"` | no | Playwright engine used. |
| `browserName` | string | no | Specific installed browser, e.g. `"Microsoft Edge"`. |
| `useProfile` | boolean | no | Whether a real user profile was used for the launch. |
| `metadata` | object (free-form) | no | Not interpreted by the engine. |

### `ActionV2`

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"navigate" \| "click" \| "fill" \| "select" \| "scroll" \| "hover" \| "key"` | yes | Action kind. |
| `step` | integer ≥ 1 | yes | Monotonic step number (see [step numbering](#step-numbering)). |
| `timestamp` | string (ISO 8601) | yes | When the action was recorded. |
| `url` | string | no | Navigation target for `navigate`; the page URL for other types. |
| `target` | `ActionTarget` | no | Ranked locator candidates for element-directed actions (`click`, `fill`, `select`, `hover`). Absent for `navigate`/`scroll`/`key`. |
| `selector` | string | no | Legacy mirror of the best CSS-like candidate. Kept for tooling continuity; the only locator a v1 file has. |
| `value` | string | no | Fill/select value, key name for `key`, clicked text for `click`. The literal `"[REDACTED]"` when masked. |
| `redacted` | boolean (default `false`) | no on parse, always materialized on write | `true` when the recorded value was masked (password/OTP/sensitive input). |
| `metadata` | object (free-form) | no | Recorder annotations, e.g. `{ "actionType": "user_click" }`. |

`ActionTarget`:

| Field | Type | Required | Description |
|---|---|---|---|
| `candidates` | `TargetCandidate[]`, min 1 | yes | Ordered by replay preference. |
| `description` | string | no | Human-readable, e.g. `"Item 1 breadcrumb link"`. |

#### Step numbering

Steps are assigned by the recorder as `last step + 1` (`packages/engine/src/recording/recorder-state.ts`):

- Actions performed **during an auth segment are never assigned a step** — they are discarded entirely, so numbering stays contiguous across a segment.
- A **retroactive** segment start (`fromStep`) discards every already-recorded action with `step > fromStep`; surviving actions are never renumbered, and the next recorded action continues from the last surviving step + 1. Numbering therefore stays collision-free and contiguous.

#### Redaction

Sensitive inputs (password, OTP and similar) **never emit their value**: the injected recorder script masks them at the source, so the recorder receives `value: "[REDACTED]"` (`REDACTED_VALUE` in `@waa/shared`) with `redacted: true`. This is enforcement, not post-processing — the plaintext never reaches the Node process.

At replay, a `fill` whose `redacted` is true **or** whose value is the literal `"[REDACTED]"` is skipped with outcome `skipped` / detail `redacted-credential`: credentials are never re-typed; the saved `storageState.json` carries the authentication instead.

Note that a redacted action only appears at all when a sensitive field is filled *outside* a marked login segment (defense in depth for unmarked logins). It looks like this:

```json
{
  "type": "fill",
  "step": 7,
  "timestamp": "2026-07-08T01:18:20.000Z",
  "url": "https://portal.example.com/profile",
  "target": {
    "candidates": [{ "strategy": "id", "value": "current-password" }],
    "description": "Current password"
  },
  "selector": "#current-password",
  "value": "[REDACTED]",
  "redacted": true
}
```

Inside a marked segment even this marker is absent — the action is discarded outright (see `AuthCheckpoint`).

### `TargetCandidate`

A discriminated union on `strategy`. Candidates are generated by the selector engine in this preference order and tried by the replayer in array order.

| `strategy` | Other fields | Recorded when | Replayed as |
|---|---|---|---|
| `testid` | `attribute` (string), `value` (string) | Element carries a test hook (`data-testid` / `data-test` / `data-qa`); `attribute` names which one | `page.locator('[<attribute>="<value>"]')` — the attribute name is validated (`/^[A-Za-z_][\w-]*$/`) and the value attribute-escaped |
| `id` | `value` (string) | Element has an `#id` that does not look auto-generated | `page.locator('#<CSS-escaped id>')` |
| `role` | `role` (string), `name` (string), `exact?` (boolean) | ARIA role + accessible name are computable | `page.getByRole(role, { name, exact: exact ?? false })` |
| `text` | `value` (string), `tag?` (string) | Exact visible text (links/buttons) | `page.getByText(value, { exact: true })`, intersected with `page.locator(tag)` when `tag` is present |
| `css` | `value` (string) | A stable CSS selector exists (utility/hashed classes rejected at generation time) | `page.locator(value)` |
| `nth-path` | `value` (string) | Last resort: structural `nth-child` path (mirrors the v1 selector behaviour) | `page.locator(value)` |

Replay resolution (`packages/engine/src/replay/replayer.ts`): candidates are tried in order, each with a short per-candidate timeout during which `locator.count()` is polled.

- Exactly one match → that locator is used; the winning strategy is reported as `resolvedBy`.
- More than one match → `locator.first()` is used and the outcome carries detail `ambiguous`.
- Zero matches, or the candidate cannot be built → next candidate.
- No candidate resolves → the action's outcome is `failed` with detail `target-not-resolved` (which can contribute to login-wall detection during replay).
- An action with no `target` falls back to a single `css` candidate built from the legacy `selector`; with neither, the action is `skipped` (`no-target`).

Per-action outcomes (`executed | skipped | failed`) are persisted to the manifest (`stepDetails[].actionOutcome`), never silently swallowed.

### `AuthCheckpoint`

A login segment. Actions performed during the segment are **not recorded** — only this marker persists, and `storageState.json` is saved when the segment ends. During replay, the pause-for-login machine pauses at `afterStep` when no validated storage state covers the target origin (see `docs/sse-events.md` and rewrite-plan §6).

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Checkpoint id, unique within the session. The current recorder emits `acp_<n>` (1-based), but the schema only requires a string — treat the shape as informative, not normative. |
| `afterStep` | integer ≥ 0 | yes | The checkpoint sits after this recorded step; `0` = before the first action. |
| `reason` | `"user-marked" \| "auto-detected"` | yes | `user-marked`: the user toggled "I'm logging in". `auto-detected`: the user confirmed a `recording.auth_suspected` prompt (segment started retroactively). |
| `loginUrl` | string | no | Main-frame URL when the segment opened. |
| `postLoginUrl` | string | no | URL when the segment closed — the live page URL, else the last navigation seen during the segment. |
| `storageStateSaved` | boolean | yes | `true` only after the `storageState.json` write actually succeeded. |
| `startedAt` | string (ISO 8601) | yes | Segment open time. |
| `completedAt` | string (ISO 8601) | no | Segment close time; absent if the recording stopped with the segment still open. |

## Annotated v2 example

A realistic session against a login-protected claims portal. What happened, in order:

1. The user started recording at `https://portal.example.com/dashboard` (**step 1**, `navigate`).
2. The server redirected to the identity provider. That redirect was recorded as step 2 (`navigate` to `https://id.example.com/login?...`), and the recorder emitted a `recording.auth_suspected` SSE event (`auth-domain-navigation`).
3. The user confirmed the prompt. The API started a **retroactive** auth segment from step 1, which **discarded the step-2 navigation** and created checkpoint `acp_1` with `afterStep: 1`.
4. The user typed a username and password and clicked "Sign in". **None of this appears below** — segment actions are discarded outright. In particular there is no `fill` with `value: "[REDACTED]"` for the password: redacted placeholders only exist for sensitive fills *outside* a segment. Inside a segment, nothing is recorded at all; only the checkpoint marker survives, and `storageState.json` was saved when the segment ended.
5. Back on the dashboard the user ended the segment, then clicked the "Claims" nav link (**step 2** — numbering continues from the last surviving step), which navigated to `/claims` (**step 3**), typed `physio` into the claim search box (**step 4**, an ordinary non-sensitive fill, so its value is present in plaintext), and clicked "Search" (**step 5**).

```json
{
  "formatVersion": 2,
  "sessionId": "session_1783502100000_k3n9x2m4p",
  "sessionName": "Claims portal walkthrough",
  "url": "https://portal.example.com/dashboard",
  "startTime": "2026-07-08T01:15:00.000Z",
  "endTime": "2026-07-08T01:17:42.500Z",
  "duration": 162500,
  "actionCount": 5,
  "actions": [
    {
      "type": "navigate",
      "step": 1,
      "timestamp": "2026-07-08T01:15:00.400Z",
      "url": "https://portal.example.com/dashboard",
      "redacted": false,
      "metadata": { "actionType": "navigation" }
    },
    {
      "type": "click",
      "step": 2,
      "timestamp": "2026-07-08T01:16:35.120Z",
      "url": "https://portal.example.com/dashboard",
      "target": {
        "candidates": [
          { "strategy": "role", "role": "link", "name": "Claims" },
          { "strategy": "css", "value": ".nav__link--claims" },
          { "strategy": "nth-path", "value": "nav > ul > li:nth-child(2) > a" }
        ],
        "description": "Claims navigation link"
      },
      "selector": ".nav__link--claims",
      "value": "Claims",
      "redacted": false,
      "metadata": { "actionType": "user_click" }
    },
    {
      "type": "navigate",
      "step": 3,
      "timestamp": "2026-07-08T01:16:35.480Z",
      "url": "https://portal.example.com/claims",
      "redacted": false,
      "metadata": { "actionType": "navigation" }
    },
    {
      "type": "fill",
      "step": 4,
      "timestamp": "2026-07-08T01:17:02.310Z",
      "url": "https://portal.example.com/claims",
      "target": {
        "candidates": [
          { "strategy": "testid", "attribute": "data-testid", "value": "claim-search" },
          { "strategy": "id", "value": "claim-search-input" },
          { "strategy": "css", "value": "#claim-search-input" }
        ],
        "description": "Search claims text box"
      },
      "selector": "#claim-search-input",
      "value": "physio",
      "redacted": false,
      "metadata": { "actionType": "form_input" }
    },
    {
      "type": "click",
      "step": 5,
      "timestamp": "2026-07-08T01:17:03.050Z",
      "url": "https://portal.example.com/claims",
      "target": {
        "candidates": [
          { "strategy": "role", "role": "button", "name": "Search" },
          { "strategy": "text", "value": "Search", "tag": "button" },
          { "strategy": "css", "value": "form.claim-search button[type=\"submit\"]" }
        ],
        "description": "Search submit button"
      },
      "selector": "form.claim-search button[type=\"submit\"]",
      "value": "Search",
      "redacted": false,
      "metadata": { "actionType": "user_click" }
    }
  ],
  "authCheckpoints": [
    {
      "id": "acp_1",
      "afterStep": 1,
      "reason": "auto-detected",
      "loginUrl": "https://id.example.com/login?returnTo=%2Fdashboard",
      "postLoginUrl": "https://portal.example.com/dashboard",
      "storageStateSaved": true,
      "startedAt": "2026-07-08T01:15:04.220Z",
      "completedAt": "2026-07-08T01:16:28.900Z"
    }
  ],
  "browserType": "chromium",
  "browserName": "Microsoft Edge",
  "useProfile": false,
  "metadata": { "createdBy": "Web Access Advisor" }
}
```

Points worth noting against the field reference:

- The checkpoint sits at `afterStep: 1`; the next recorded action is step 2 — numbering is contiguous because segment actions never consume step numbers, and the discarded step-2 navigation's number was reused by the first post-login action.
- `storageStateSaved: true` means `snapshots/session_.../storageState.json` exists and covers `portal.example.com`; replay will only pause at this checkpoint if that state is missing or fails validation.
- Every action carries an explicit `redacted` and the file carries `authCheckpoints` even when empty — `saveRecording` writes the schema-parsed value, so defaults are materialized.

## Format v1 (legacy)

v1 files were written by the legacy recorder (`main` branch / pre-rewrite). Shape differences from v2:

| Aspect | v1 |
|---|---|
| Discriminator | **No `formatVersion` key.** (`metadata.version: "2.0.0"` appears in real files and is meaningless.) |
| Locators | Single crude CSS `selector` per action (`#id` → first class → `nth-child`). No `target.candidates`. |
| Credentials | Recorded **in plaintext** into `value` — the defect that motivated v2 (ADR 0005). No `redacted` flag. |
| Auth | No `authCheckpoints`. |
| `browserType` | Free string, not an enum. |

`ActionV1`: `type`, `step`, `timestamp` (required); `selector`, `value`, `url`, `metadata` (optional). Top level is otherwise the same field set as v2 minus `formatVersion` and `authCheckpoints`.

### Real example (abbreviated)

From `snapshots/session_1755656440621_9w7pfo5ce/recording.json`; three of the six actions elided for brevity (the schema does not cross-check `actionCount` against `actions.length`, so this abbreviation is still schema-valid):

```json
{
  "sessionId": "session_1755656440621_9w7pfo5ce",
  "sessionName": "Recording 8/20/2025, 12:20:41 PM",
  "url": "https://healthgovau.github.io/hbs-design-system/components/preview/breadcrumb--light.html",
  "startTime": "2025-08-20T02:20:41.024Z",
  "endTime": "2025-08-20T02:20:58.740Z",
  "duration": 17716,
  "actionCount": 6,
  "actions": [
    {
      "type": "navigate",
      "url": "https://healthgovau.github.io/hbs-design-system/components/preview/breadcrumb--light.html",
      "metadata": { "actionType": "navigation" },
      "step": 1,
      "timestamp": "2025-08-20T02:20:41.398Z"
    },
    {
      "type": "click",
      "selector": ".c_breadcrumb__link",
      "value": "Item 1",
      "metadata": { "actionType": "user_click" },
      "step": 4,
      "timestamp": "2025-08-20T02:20:53.342Z"
    },
    {
      "type": "navigate",
      "url": "https://healthgovau.github.io/",
      "metadata": { "actionType": "navigation" },
      "step": 5,
      "timestamp": "2025-08-20T02:20:53.565Z"
    }
  ],
  "metadata": {
    "version": "2.0.0",
    "createdBy": "Web Access Advisor",
    "description": "Automated accessibility recording for https://healthgovau.github.io/hbs-design-system/components/preview/breadcrumb--light.html"
  }
}
```

### v1 → v2 in-memory upgrade

`loadRecording()` in `packages/engine/src/storage/recording-format.ts` dispatches on `formatVersion` (see [Versioning policy](#versioning-policy)) and upgrades schema-valid v1 files with these exact rules:

Per action:

1. `type`, `step`, `timestamp` are copied.
2. `url`, `value`, `metadata` are copied when present (note: `value` is copied **as-is** — including any plaintext credentials a legacy recording captured; the upgrade does not redact).
3. If `selector` is present, it is kept as `selector` **and** becomes the single target candidate: `target: { candidates: [{ "strategy": "css", "value": <selector> }] }`. If absent, the upgraded action has no `target`.
4. `redacted` is set to `false` (v1 recorded values in plaintext; there is nothing to mark).

Top level:

5. `formatVersion: 2` is set.
6. `authCheckpoints` is set to `[]` (v1 had no login segments).
7. `browserType` (a free string in v1) is parsed against the `chromium | firefox | webkit` enum; an invalid value is **dropped**, not preserved.
8. All other top-level fields (`sessionId`, `sessionName`, `url`, `startTime`, `endTime`, `duration`, `actionCount`, `browserName`, `useProfile`, `metadata`) are copied when present.
9. The result is re-validated against `recordingV2Schema` so an upgrade bug surfaces at load time, not deep in the replayer.

The upgrade is purely in memory: the v1 file on disk is never touched. `saveRecording` only ever writes v2, so a v1 file can only be superseded by deliberately writing a new v2 file — which the engine does not do for legacy sessions.

## On-disk session layout

Path conventions are unchanged from the legacy server (`packages/engine/src/storage/session-files.ts`), so existing snapshot directories keep working:

```
snapshots/
├─ index.json                  # disk-backed session index (survives API restarts)
└─ <sessionId>/
   ├─ recording.json           # this document (v1 or v2 on disk; always v2 in memory)
   ├─ storageState.json        # Playwright storage state (cookies/localStorage) — credentials-equivalent
   ├─ manifest.json            # replay manifest, written by the analyzer (manifest.schema.ts)
   ├─ analysis.json            # axe + LLM analysis result (analysis.schema.ts)
   ├─ session.json             # session metadata (name, url, timestamps)
   └─ step_NNN/                # one directory per captured step, zero-padded
      ├─ snapshot.html         # rendered DOM capture (scrubbed — see security notes)
      ├─ axe_results.json      # raw axe-core scan output
      ├─ axe_context.json      # context/metadata for the axe scan
      └─ screenshot.png        # full-page screenshot
```

- Step directories are zero-padded to a minimum of three digits (`1` → `step_001`, `1234` → `step_1234`) and are created lazily by the capture code — only steps whose DOM change was significant enough to snapshot get a directory, so gaps in `step_NNN` are normal.
- `recording.json` and `storageState.json` are written at recording time; `manifest.json`, `analysis.json`, and the `step_NNN/` captures are written at analysis (replay) time; `session.json` and `index.json` are maintained by the API's session store.
- Consumers must obtain these paths via `sessionPaths()` and never re-derive filenames by hand.

## Security notes

What is **never written** to `recording.json`:

- **Credential values.** Two independent mechanisms: (1) actions performed during a marked login segment are discarded entirely — not redacted, *absent* — with only the `AuthCheckpoint` marker persisting; (2) sensitive inputs outside a segment are masked at the source by the injected recorder script (`value: "[REDACTED]"`, `redacted: true`), so plaintext never reaches the recorder process.
- Replay never re-types credentials: redacted fills are skipped (`redacted-credential`) and authentication is carried by `storageState.json` (or by pause-for-login when no valid state exists).

Adjacent files:

- **`storageState.json` is credentials-equivalent** (live cookies / local storage). It is stored unencrypted; never log its contents, and treat the `snapshots/` directory as sensitive.
- **Snapshot HTML is scrubbed before disk and before the LLM** (`packages/engine/src/snapshot/html-scrub.ts`): `scrubSensitiveValues` empties user-typed `value` attributes and textarea content (keeping only page-markup values such as `hidden`/`submit` inputs and option labels), and `scrubHtmlForAnalysis` strips scripts/styles/comments. The scrubbers are regex-based, best-effort by design, and never throw.

Legacy caveat: **v1 recordings may contain plaintext credentials** captured by the old recorder. The in-memory upgrade does not redact them (`redacted: false`, `value` copied as-is), so a legacy plaintext value — unlike a v2 redacted one — *will* be re-typed at replay. Treat legacy `recording.json` files as sensitive; deleting the session directory is the only way to remove captured values.
