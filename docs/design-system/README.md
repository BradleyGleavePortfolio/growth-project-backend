# Stillwater Standard

> *Working name. Provisional. Subject to change once the team reacts.*

A design standard for a habit-forming, lifestyle-grade fitness coaching product. Not gym voice — lifestyle voice. Not gamification — identity. Not "Stripe-grade" — **the design becomes the moat.**

This directory is the **specification**. It is intentionally code-free. Every principle and redesign decision cites the [mobile design intelligence doc](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md), the [website design intelligence doc](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md), and the [UX review report](../audits/ux_review_report.md) that scored 203 surfaces on Premium / Rewarding / Cognitive-Simplicity.

---

## How to read this directory

Read in numbered order. Each document is a precondition for the next.

| # | File | One-line description |
|---|------|----------------------|
| 00 | [`00-stillwater-standard.md`](./00-stillwater-standard.md) | The manifesto — vision, seven principles, lifestyle voice with do/don't pairs, and the anti-patterns list every screen must avoid. |
| 01 | [`01-tactile-primitives.md`](./01-tactile-primitives.md) | The shared building blocks — `useHaptic()`, `useSpring()`, the `CompletionMoment` contract, and the quiet skeleton / calm error / next prompt primitives that make every screen feel like one product. |
| 02 | [`02-screen-grammar.md`](./02-screen-grammar.md) | The rules every screen obeys — One Decision Rule, Path Spec (FROM → HERE → NEXT → CLOSURE), Cognitive Budget (≤7 surfaces, ≤3 decisions, ≤1 modal depth), Breath Spec, and the 10-item De-Load checklist. |
| 03 | [`03-redesign-specs/`](./03-redesign-specs/) | Five concrete redesigns — the worst-rated and most strategic screens, reworked against the standard. (See breakdown below.) |
| 04 | [`04-rollout-plan.md`](./04-rollout-plan.md) | The sequencing — Tier 1 (primitives + HomeScreen polish, ~15 days), Tier 2 (high-leverage rebuilds, ~6 weeks), Tier 3 (the long tail, ~10 weeks), with S/M/L sizing, dependency map, and journey-aligned rationale. |

### The five redesigns (file 03)

| File | Target screen | Current score | Goal |
|------|---------------|---------------|------|
| [`client-homescreen.md`](./03-redesign-specs/client-homescreen.md) | Client HomeScreen | 4.3 / 5 | Push 4.3 → 5.0. Polish the already-strong surface into the *peak moment* of the day. |
| [`client-settings.md`](./03-redesign-specs/client-settings.md) | Client SettingsScreen | 1.7 / 5 | Replace the 25-row flat list with six grouped drill-downs + search. One decision per sub-screen. |
| [`coach-ai-mealplan-draft.md`](./03-redesign-specs/coach-ai-mealplan-draft.md) | Coach AI Meal-Plan Draft | 1.7 / 5 | Replace the 85-field giant editor with a three-screen summary-first approval: Summary → Day Walker → Item Edit. |
| [`branded-checkout-webview.md`](./03-redesign-specs/branded-checkout-webview.md) | Branded Checkout WebView | 1.7 / 5 | Four-phase trust choreography around the payment webview — pre-load checklist → webview → peak resolution → warm closure. |
| [`notification-preferences.md`](./03-redesign-specs/notification-preferences.md) | Notification Preferences | 2.0 / 5 | Replace the 24-toggle matrix with three named presets — *Quiet / Steady / Full* — plus an Advanced disclosure. |

---

## What this is not

- **Not code.** No TSX is modified. No `tokens.ts` is touched. The spec is grounded in current code (read-only) so the rebuild is honest, but the rebuild itself is engineering's call.
- **Not a brand book.** Colors and type live in [`tokens.ts`](../repos/growth-project-mobile/src/theme/tokens.ts). This document tells you how to *use* them.
- **Not exhaustive.** Five redesigns of 203 surfaces. The rest follow the grammar in file 02 and the rollout in file 04.

## What this is

A standard. If we follow it for one quarter, the product stops feeling like a fitness app and starts feeling like a place clients want to be at 6am. That is the moat.

---

*Stillwater is the working name. Rename freely. The principles travel.*
