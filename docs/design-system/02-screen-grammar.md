# 02 — Screen Grammar

_The universal grammar every Stillwater screen must follow. Spec only._

A "screen" here means any navigable destination — a React Navigation screen, a full-page modal, a webview wrapper, or a platform-site route. Components, bottom sheets shorter than ½ viewport, and inline overlays are not screens and are governed by their parent.

The audit found that the average product surface scores 2.75–2.93 overall ([audit per-section heatmap](audits/ux_review_report.md#L23-L38)) while the best-scoring ones (`apply/page.tsx` at 4.7, `HomeScreen.tsx` at 4.3, `Day1WinScreen.tsx` at 4.3) all share the same five structural properties. This file codifies those properties as enforceable rules.

---

## 1. The One Decision Rule

> Every screen names its single primary decision in code, and only ever has one button styled as primary.

**Implementation contract:**

```ts
// Spec only — every screen module must export a Stillwater meta object.
export const stillwater = {
  primaryDecision: string;        // human-readable, e.g. "Approve this week's plan"
  primaryActionLabel: string;     // exact button label, e.g. "Approve"
  expectedExit: 'navigate' | 'dismiss' | 'complete';
} as const;
```

The `primaryDecision` field is required for every screen and is what the lint rule reads to enforce one-primary-button-per-screen. If a screen genuinely has two decisions ("Approve or Reject"), one is primary (ink fill) and the other is secondary (text link or hairline-outline button); they are never both `variant="primary"`.

**Why:** The audit's #1 cross-cutting weakness on coach AI draft editors is "approve/reject/save controls overload working memory" ([audit AIMealPlanDraftScreen](audits/ux_review_report.md#L110)). Hick's Law: make the default path irresistible ([Mobile Doc §4.4](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1180-L1236)). The CTA-as-conversion-architecture principle from the website doctrine ([Website Doc §4.3](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L512-L565)) applies in-app too.

**Lint rules CI must enforce:**
- Every screen file exports a `stillwater` const with the three required fields.
- No more than one `<Button variant="primary">` in a screen's render tree at a given navigation state.
- Above-the-fold (first 100% viewport on mount) contains exactly one primary CTA.

---

## 2. The Path Spec

> Every screen explicitly answers four questions in its header comment.

Every screen file begins with a Stillwater Path block. These are not optional. The path block is the contract between this screen and the screens on either side of it.

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     <what screen / what user state arrives here>
 * HERE:     <the one thing the user does on this screen>
 * NEXT:     <the screen / state the user goes to on success>
 * CLOSURE:  <what completion feels like — quiet | standard | peak>
 */
```

Worked example for the redesigned `HomeScreen.tsx`:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     App launch, tab tap, or notification → root.
 * HERE:     Read one date-line and one current-state line. Tap CONTINUE
 *           to enter today's primary action (workout or check-in,
 *           whichever is the open loop).
 * NEXT:     ActiveWorkout, CheckIn, or Plan — exactly one route,
 *           determined by today's open loop.
 * CLOSURE:  Peak — first tap of the day fires a quiet CompletionMoment
 *           that marks the day as begun.
 */
```

**Why:** The audit's strongest surfaces are explicit about closure (Day1Win at 4.3, ReadyScreen at 4.0); the worst are not (SettingsScreen at 1.7, NotificationPreferences at 2.0). The Path block makes closure a design requirement, not an afterthought. Mobile doctrine §5.1 step 7 — design the peak moment and the end state ([Mobile Doc §5.1](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1494-L1498)).

---

## 3. The Cognitive Budget

> Max 7 visible primary surfaces. Max 3 simultaneous decisions. Max 1 modal depth.

The three hard ceilings, each grounded in cognitive-load doctrine.

### Ceiling A — 7 visible primary surfaces
- "Primary surface" = a card, a list row, a CTA, a chart, or a labeled chunk. Hairline rules, headers, and breath elements don't count.
- 7 is the conservative read of Miller's Law ([Mobile Doc §4.3](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1120-L1178)) — working memory of 7±2, design for the lower bound.
- If a screen needs more than 7 surfaces, they must be grouped under accordion headers, paginated, or moved behind progressive disclosure.

### Ceiling B — 3 simultaneous decisions
- A decision is an action the user must choose between. Choosing one of 6 chips counts as 1 decision (one decision-point with 6 options); typing into a name field is not a decision.
- Coach AI draft editors today have ~7 simultaneous decisions visible (approve, reject, save, edit week 1, edit week 2…). That's why they score 1.7/5 ([audit](audits/ux_review_report.md#L110)).
- 3 is enforced as the spec because Hick's Law's logarithmic time penalty becomes prohibitive past 3 ([Mobile Doc §4.4](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1180-L1236)).

### Ceiling C — 1 modal depth
- A modal cannot present another modal. A bottom sheet inside a modal is banned.
- If a flow appears to need modal-on-modal, that flow must be a multi-step screen sequence instead. The `apply/page.tsx` one-question-at-a-time pattern is the reference ([audit](audits/ux_review_report.md#L225)).
- Confirmation dialogs ("Are you sure?") count as modal depth. To confirm a destructive action inside a modal, dismiss the modal first and reuse the screen-level confirmation.

**Why:** Cognitive load is the binding constraint on premium feel. Apple's de-load doctrine — complexity is never eliminated, only redistributed — is the governing principle ([Mobile Doc §4.1](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1026-L1063)).

---

## 4. The Breath Spec

> Minimum whitespace ratios, no card-on-card, mandatory padding tokens.

Stillwater enforces breathing room as a numeric ratio, not a judgment call.

### Ratio rules

- **Outer padding minimum:** every screen has at least `spacing.xl` (24px) horizontal padding and `spacing.2xl` (32px) top padding. Borrowed from the platform-site's premium-page convention.
- **Section gap minimum:** between any two adjacent primary surfaces, at least `spacing.2xl` (32px) vertical gap. The audit explicitly calls out "card-dense" surfaces ([HomeScreen note](audits/ux_review_report.md#L77), [PlanScreen note](audits/ux_review_report.md#L86)) — Stillwater's section gap is the fix.
- **Whitespace-to-content ratio:** above the fold, at least 40% of pixels are background (no text, no element, no icon). The website doctrine's premium-value-via-whitespace finding ([Website Doc §3.1](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L235-L277)) applies directly.

### Composition rules

- **No card-on-card.** A `bgSurface` cannot contain another `bgSurface`. If you find yourself wanting to nest cards, use a hairline rule and inset padding instead, on a single surface.
- **No inset shadow on inset shadow.** `shadows.md` is for elevation off the screen background, never off a card.
- **Mandatory padding tokens.** All padding values come from `spacing.*` only. No arbitrary integer paddings. CI lint should flag literal numeric paddings ≥ 4 inside style objects.

### Token references

All numeric specs above resolve to existing tokens in [tokens.ts](../repos/growth-project-mobile/src/theme/tokens.ts#L219-L228):
- `spacing.lg` = 16, `spacing.xl` = 24, `spacing.2xl` = 32, `spacing.3xl` = 48, `spacing.4xl` = 64.

---

## 5. The De-Load Checklist — 10 items every screen must pass before ship

This is the gate. PR review explicitly checks each item. CI enforces the ones that can be automated.

1. **One primary decision named.** `stillwater.primaryDecision` exists, is a complete sentence, and matches what the screen actually does. (Lint: required export.)
2. **One primary CTA above the fold.** Exactly one `<Button variant="primary">` visible without scrolling. (Lint: count primaries.)
3. **Path block present.** FROM / HERE / NEXT / CLOSURE all filled in the header comment. (Lint: regex.)
4. **Cognitive Budget respected.** ≤7 primary surfaces, ≤3 decisions, ≤1 modal depth. (Manual review + storybook count.)
5. **Tokens only.** No hardcoded hex outside [tokens.ts](../repos/growth-project-mobile/src/theme/tokens.ts), no literal paddings ≥4. (Lint: AST scan for `#[0-9a-f]{6}`, numeric `padding`/`margin`.)
6. **CompletionMoment present where appropriate.** Every meaningful save / submit / approve uses `<CompletionMoment>` not `Alert.alert`. (Lint: flag `Alert.alert` calls on success paths.)
7. **Breath running.** At least one element on the primary surface uses the `breath` motion preset. (Manual review.)
8. **Empty / loading / error use Stillwater primitives.** No raw spinners >800ms, no raw red toasts, no "No data." (Lint: flag `<ActivityIndicator>` in main render, banned strings.)
9. **Voice audit clean.** No banned vocabulary ("crush," "smash," "destroy," "beast mode"), no exclamation-point CTAs, no all-caps shouting (eyebrow caption is the only all-caps surface). (Lint: string scan against blacklist.)
10. **Accessibility green.** AA contrast for all visible text, all touch targets ≥44pt, `prefersReducedMotion` honored on every preset that has motion. (Manual + automated a11y test.)

These ten items are the operational expression of the rubric's three ideals (Premium / Rewarding / CogSimple) from [ux_review_rubric.md](audits/ux_review_rubric.md#L12-L42). A screen that passes all ten is at minimum an audit "B" (10–12 overall) and typically lands as "A" (13–15) once `CompletionMoment` is wired ([rubric verdict scale](audits/ux_review_rubric.md#L38-L42)).

---

## 6. Naming convention for new screen files

To make the screen grammar visible at the file system level, new screen modules adopt a header in the standard order:

```tsx
/**
 * <ScreenName> — <one-sentence purpose, lifestyle voice>
 *
 * Stillwater Path
 * ───────────────
 * FROM:     ...
 * HERE:     ...
 * NEXT:     ...
 * CLOSURE:  quiet | standard | peak
 *
 * Primitives used: useHaptic, useSpring(enter), CompletionMoment(standard)
 */
export const stillwater = { primaryDecision: '...', primaryActionLabel: '...', expectedExit: '...' } as const;
```

When the CI lint sees this header on every new screen, the design system becomes self-documenting — anyone can `grep stillwater.primaryDecision` and read the entire app's spine in one screen of output.

---

_End of `02-screen-grammar.md`. See `03-redesign-specs/` for five worked examples that apply this grammar to specific surfaces._
