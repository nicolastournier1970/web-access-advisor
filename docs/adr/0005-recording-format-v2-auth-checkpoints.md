# ADR 0005: recording.json v2 — auth checkpoints and target candidates

- **Status**: Accepted (2026-07-07)

## Context

Two confirmed v1 defects motivate a format change:

1. **Credentials on disk.** The v1 recorder captured every input value on blur — including passwords — in plaintext into `recording.json`; replay re-typed them and snapshots of filled forms could reach the cloud LLM. A redaction helper existed but was dead code.
2. **Fragile selectors.** Actions stored a single crude CSS selector (`#id` → first class → `nth-child`), the leading cause of replay failures.

Additionally, login handling needs to be a first-class concept: v1 had no way to know *where* in a recording authentication happened, so replay could not do anything intelligent at a login wall.

## Decision

Introduce **format v2**, discriminated by a top-level integer `formatVersion: 2` (absent → v1):

- Each action gains `target: { candidates: TargetCandidate[], description }` — an ordered list of locator strategies (`testid` → stable `#id` → ARIA role+name → text → stable CSS → nth-child path). The legacy `selector` string is kept as a mirror of the best CSS candidate.
- Sensitive inputs never emit values: `value: "[REDACTED]"`, `redacted: true` (enforced in the injected recorder script, not post-hoc).
- New `authCheckpoints[]`: `{ id, afterStep, reason: "user-marked" | "auto-detected", loginUrl, postLoginUrl, storageStateSaved, startedAt, completedAt }`. During a marked login segment, actions are **discarded entirely** — only the checkpoint marker persists, and `storageState.json` is saved immediately at segment end.

`loadRecording()` upgrades v1 files in memory (single CSS candidate, empty `authCheckpoints`); existing sessions in `./snapshots/` remain loadable forever. No on-disk migration; v1 files are never rewritten.

## Consequences

- Passwords structurally cannot reach disk, replay, or the LLM for v2 recordings made with marked segments; auto-detection prompts the user when a login appears unmarked.
- Replay reliability improves via candidate fallback; per-action outcomes (`executed | skipped | failed`) are recorded rather than silently swallowed.
- Replay's pause-for-login state machine keys off `authCheckpoints` (see `docs/auth-flows.md`).
