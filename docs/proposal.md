# Web Access Advisor
### Accessibility testing for the parts of your product users actually reach

---

## The problem

Most accessibility tools test the wrong thing: a single, logged-out page load.

Real accessibility failures live **after** the first screen — inside modals, multi-step forms, single-page-app transitions, dynamic menus, and, above all, **behind a login**. These are the states your customers spend most of their time in, and they are exactly the states that conventional automated scanners either skip or cannot reach.

Closing that gap today means one of two things:

- **Manual auditing** — accurate, but slow and expensive to repeat.
- **Hand-written browser automation** — free tooling (e.g. Lighthouse user flows) can audit interactive states, but only if a developer writes and maintains a custom script for every flow, handles the login themselves, and decides in advance exactly which states to capture. There is no recorder, no automatic state detection, and no built-in analysis of the results.

The result: authenticated, interactive parts of the product — where risk is highest — get tested the least.

---

## The solution

**Web Access Advisor records a real user session and automatically audits every meaningful state along the way — including states behind authentication — then uses AI to help your team triage the findings.**

A tester simply uses the application as a user would. The tool captures the session, replays it in a real browser, and runs an industry-standard accessibility engine (axe-core) at each interactive state — with no scripting required.

### How it works

1. **Record** — A real browser opens and captures every click, input, and navigation. No code, no selectors to maintain.
2. **Replay & capture** — The session is replayed step by step. At each point where the page meaningfully changes, the tool captures the HTML, a screenshot, and a full accessibility scan. Redundant states are automatically skipped.
3. **Analyze** — Accessibility violations are merged with AI-generated findings and remediation suggestions, presented per state, with screenshots and exportable reports (CSV, print).

---

## What makes it different

| Capability | Conventional scanners | Hand-scripted flows (e.g. Lighthouse) | **Web Access Advisor** |
|---|---|---|---|
| Tests interactive states (modals, SPA views, forms) | Rarely | Yes, if you script each one | **Yes, automatically from a recording** |
| Requires writing/maintaining automation code | — | Yes | **No** |
| Automatically captures every changed state | No | No (manual capture points) | **Yes (change-gated capture)** |
| Works behind a login | Poorly | Only if you script the login | **Yes — first-class auth handling** |
| AI-assisted triage of findings | No | No | **Yes** |

**Three differentiators worth emphasizing:**

- **First-class authentication.** The tool pauses for you to sign in, then securely reuses that session to test the authenticated experience. Credentials are never stored in recordings, and saved login state is encrypted at rest. Most automated scanners cannot get past a login wall at all.
- **Zero-scripting interactive coverage.** Coverage of post-interaction states comes from *using* the product, not from writing and maintaining test code — dramatically lowering the effort to test the flows that matter.
- **AI-assisted analysis of a full flow.** Findings are triaged with plain-language explanations and suggested fixes, mapped to each state in the journey — turning raw violations into actionable next steps.

---

## Honest scope

We believe credibility matters more than hype:

- The underlying detection uses **axe-core**, the same trusted open-source engine used across the industry. Our value is in *reaching and capturing the right states automatically*, handling authentication, and layering AI triage on top — not in reinventing rule detection.
- **Automated testing catches a portion of accessibility issues, not all of them.** This tool substantially widens coverage into interactive and authenticated states, but it complements — rather than replaces — expert manual and assistive-technology testing for full WCAG conformance.
- AI suggestions are a triage aid; the axe-core results remain the authoritative baseline.

---

## Who it's for

- **Product & QA teams** who need to test authenticated, interactive flows without building and maintaining custom automation.
- **Accessibility specialists** who want to reach deep application states quickly and focus manual effort where it counts.
- **Engineering teams** who want actionable, per-state findings with remediation guidance built in.

---

## Conclusion

Accessibility risk concentrates in the interactive, logged-in experiences that conventional tools test least. Web Access Advisor makes those states testable by anyone who can use the product — recording real sessions, auditing every meaningful state including those behind a login, and using AI to turn the results into a clear remediation plan. It doesn't replace expert review; it ensures expert review starts with far better coverage.

**Next step:** a short guided walkthrough on one of your own authenticated flows, so you can see the interactive-state coverage on your real product.
