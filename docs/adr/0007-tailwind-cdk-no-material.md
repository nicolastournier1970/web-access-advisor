# ADR 0007: Tailwind CSS + Angular CDK, no component library

- **Status**: Accepted (2026-07-07)

## Context

Web Access Advisor is an accessibility-testing tool; its own UI should be exemplary. Options considered: Angular Material (+Tailwind), PrimeNG, or Tailwind with Angular CDK primitives only.

## Decision

Build the UI with **Tailwind CSS** and hand-rolled components on **Angular CDK** primitives: `@angular/cdk/dialog` (focus trap, ESC handling, focus restore), `@angular/cdk/a11y` (`LiveAnnouncer`, `FocusMonitor`), `@angular/cdk/overlay` (toasts, popovers). No Material, no PrimeNG.

The v1 "Blueberry" design tokens (`src/styles/design-system.css`) are ported into the Tailwind theme (`apps/web/src/styles/theme.css`) so the visual identity carries over.

## Rationale

- Full control over markup and ARIA semantics — the app's own accessibility is a test target (component tests assert roles/names/live-region behaviour; `vitest-axe` smoke checks).
- CDK provides the hard, easy-to-get-wrong primitives (focus management, overlays, announcements) as first-party, rigorously maintained code, without imposing Material's visual language.
- Keeps the existing Tailwind-based visual identity and avoids a large component-library dependency for a small surface (~5 pages).

## Consequences

- More hand-written component code than with Material/PrimeNG; mitigated by a small shared UI kit (`apps/web/src/app/shared/ui/`).
- Every phase transition is announced via `LiveAnnouncer`; dialogs, the action feed (`role="log"`, `aria-live="polite"`), and progress indicators follow documented ARIA patterns.
