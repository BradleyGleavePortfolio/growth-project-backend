# Redesign Spec — `coach/AIMealPlanDraftScreen.tsx`

_Target file: [src/screens/coach/AIMealPlanDraftScreen.tsx](../../repos/growth-project-mobile/src/screens/coach/AIMealPlanDraftScreen.tsx). Current audit score: **1.7/5 overall** (2 Premium, 2 Rewarding, 1 CogSimple). Tied for worst in the audit. Spec only._

---

## Current state (prose)

The coach lands on this screen after an AI agent has generated a draft meal plan for one of their clients. The current screen ([source](../../repos/growth-project-mobile/src/screens/coach/AIMealPlanDraftScreen.tsx)) renders the entire `MealPlanPayload` as a fully editable nested structure: 7 days × ~4 meals/day × ~3 items/meal = roughly **85 editable text fields visible inside one ScrollView**, plus a Save button, an Approve button, a Reject button, and three modal dialogs (reject reason modal, save-conflict modal, approve-confirm modal) layered on top.

The audit's verdict: "AI meal draft editor exposes too much structure at once; needs summary-first approval flow" ([audit row](../../audits/ux_review_report.md#L110), [Worst-10 #5](../../audits/ux_review_report.md#L254)). Top-20 fix #2 also calls this out explicitly: "Ship summary-first approval: show 'what changed,' risk flags, and one Approve CTA; expand week/day/meal edits only on demand" ([audit Top-20 fix #2](../../audits/ux_review_report.md#L290)).

The same critique applies symmetrically to `AIWorkoutDraftScreen.tsx` (1.7/5, [audit row](../../audits/ux_review_report.md#L111)). This spec is the template; an analog spec for the workout draft is implied.

---

## Problem statement

This screen violates every Stillwater principle except #6 (Identity, not gamification — irrelevant here). The most severe violation is **Principle 4 (Decisions are sequenced, not stacked)**: the screen exposes ~85 fields and three competing decisions (Save / Approve / Reject) in the same field of view. Working memory cannot triage this; the coach defaults to "approve everything because the AI probably got it right," which converts the coach from a reviewer into a rubber stamp — exactly the opposite of the product's premium positioning where the coach's judgment is the value.

Doctrine: Miller's Law ([Mobile Doc §4.3](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1120-L1178)), progressive disclosure ([Mobile Doc §4.5](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1237-L1300)), polish-as-trust in high-stakes ([Mobile Doc §2.2 Phantom](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L391-L407)) — coach approval is high-stakes because it's the moment the coach's reputation attaches to the AI's output.

Secondary violations: Principle 1 (nothing taken away — all 85 fields are present at once); Principle 5 (haptics replace explanation, but here three competing Alert.alert dialogs do the explanation work); Principle 7 (lifestyle voice — "Save edits first?" / "Discard and approve" reads as engineering UI).

---

## Target state (prose mock — top to bottom)

The redesigned flow is **three sequential screens**, not one. The coach experiences review as a guided sequence with a single decision visible at each step.

### Screen A — `AIMealPlanSummary` (the new landing screen)

This is the screen the coach lands on after the AI generates a draft. It is what replaces the giant editor as the first impression.

Scrolling top to bottom:

1. **Header.** Cormorant Garamond h1: "Draft for {{Sarah}}." Single line. Subhead in `body`: "Generated {{2 minutes ago}}." No back chevron action visible until the coach has either approved or saved-for-later.

2. **The summary card.** A single `bgSurface` card, `radius.lg`, generous padding. Contains:
   - **One headline number** in `display` Cormorant: "1,840 cal/day, average."
   - **One context line** in `body`: "Two weeks. Twenty-eight meals. Mediterranean-leaning. Two oversized protein days for training."
   - **One coach-relevant flag row** in `bodySmall`, color `semantic.warning.fg` if any flags present: "Two items reuse last week's lunch. One snack exceeds your protein cap." If no flags: "No flags. Looks ordinary." (lifestyle voice — flag absence is reported as calmness, not as silence.)

3. **The diff view (collapsed by default).** Below the summary, a single row labelled "What's different from last week" with a right-aligned chevron. Tapping expands a hairline-ruled section showing 3–5 bullet items in `bodySmall`: "Adds salmon Wednesday and Friday. Removes the Tuesday pasta. Bumps breakfast portions 15% on Thursday (long-run day)." The diff is generated server-side by comparing this draft to the client's previous approved week. If no previous week exists, the diff row is hidden.

4. **The single primary CTA.** Below the diff: one ink-fill button, `Continue review →`. There is **no Approve button on this screen**. Approval is reachable only after the coach has reviewed at least one section (see Screen B).

5. **One secondary action** as a text link in `textMuted`, below the CTA: "Reject this draft." Tapping opens a single-decision modal with the reject-reason field; on submit, `caution` haptic then `confirm`, back to client detail.

6. **The breath.** The summary card's bottom-right corner contains a hairline-ruled "generated by AI" eyebrow that uses the `breath` motion preset — the only animation on the screen.

### Screen B — `AIMealPlanReview` (the disclosed section walker)

After "Continue review," the coach sees one week-day at a time, in a slide-stack:

1. **Header.** "Monday." Cormorant h1. Subhead: "Day 1 of 14." Stepper dots in `stone` at the top, exactly like the LeanQ onboarding pattern (which scored 4.0 across the board, [audit LeanQ rows](../../audits/ux_review_report.md#L194-L199)).

2. **Day card.** One `bgSurface` card containing the three meals + one snack for Monday, each rendered as a chip-style row: meal name, calorie count, three macro pills. Each row is **tap-to-expand** — not edit-in-place. Tapping a row pushes a sub-screen (Screen C) with that single meal's items as editable fields.

3. **Bottom action bar (sticky, hairline rule above).** Two text links, both in `body`. Left: "Approve this day." Right: "Continue →". The Continue advances to Tuesday; Approve-this-day flags this day as reviewed and advances. The coach can also swipe-left to advance and swipe-right to go back (gesture parity with iOS Pages).

4. **The breath** runs on the dot stepper to indicate "this is your live position."

### Screen C — `AIMealPlanItemEdit` (a single meal's items)

The deepest screen. Only entered if the coach tapped a meal row.

1. **Header.** The meal name in Cormorant h2: "Wednesday lunch."
2. **Items list** — 3–6 items, each with name + grams field. Edit inline. Each edit fires `confirm` haptic.
3. **Single primary CTA** at the bottom: "Done." Tapping it pops back to Screen B with the meal's row showing the updated totals (using the `morph` motion preset).
4. No save button. Edits persist as the coach types (debounced 800ms). No dirty-state warning needed because there is no escape that loses work.

### The final approval

After the coach has stepped through all 14 days (or hit "Approve" early), Screen B's final state shows:

- One ink-fill primary CTA: "Approve and assign."
- One text-link secondary: "Save as draft."

Tapping "Approve and assign" fires `success` haptic, transitions with the `peak` motion preset, and lands the coach back at the client detail with a `<CompletionMoment variant="peak" title="Plan assigned to Sarah." subtitle="She'll see it next time she opens the app." nextAction={{label: "Back to clients", onPress: navClients}} />`.

Tapping "Save as draft" fires `confirm`, transitions with `morph`, lands back at the AI draft inbox with a `<CompletionMoment variant="quiet" title="Saved. Pick it up later." />`.

---

## Component breakdown — primitives used

| Primitive | Where it fires |
|---|---|
| `useSpring('enter')` | Summary card on Screen A; each day card on Screen B; each item row on Screen C, staggered |
| `useSpring('morph')` | Diff view expand/collapse; meal row macro totals update after edit |
| `useSpring('breath')` | "Generated by AI" eyebrow on Screen A; stepper dots on Screen B |
| `useSpring('peak')` | Inside the final peak CompletionMoment only |
| `useHaptic('tap')` | All navigation buttons, all expand toggles |
| `useHaptic('confirm')` | Item edits, swipe-to-advance |
| `useHaptic('success')` | Final "Approve and assign" press |
| `useHaptic('caution')` | "Reject this draft" tap (before the reason modal) |
| `<CompletionMoment variant="peak">` | Approve and assign final completion |
| `<CompletionMoment variant="quiet">` | Save-as-draft completion |
| `<CalmError>` | All API failure paths (load, save, approve, reject) |
| `<QuietSkeleton>` | Initial load of Screen A (summary card silhouette) and Screen B (day card silhouette) |

The Stillwater Path block for Screen A:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     Coach AI draft inbox or client detail meal-plan tab notification.
 * HERE:     Read summary + flags + diff. Decide: continue review, save, or reject.
 * NEXT:     AIMealPlanReview (Screen B) on Continue; ClientDetail on Reject.
 * CLOSURE:  No closure on Screen A itself; closure happens at the end of
 *           Screen B with a peak CompletionMoment.
 *
 * Primitives: useSpring(enter, breath, morph), useHaptic(tap, caution),
 *             CalmError, QuietSkeleton
 */
export const stillwater = {
  primaryDecision: 'Decide whether this draft is worth reviewing in full',
  primaryActionLabel: 'Continue review',
  expectedExit: 'navigate',
} as const;
```

---

## Copy patches — before / after

| Element | Before | After |
|---|---|---|
| Screen title (current) | "AI Meal Plan Draft" | "Draft for {{client name}}." |
| Save success | `Alert.alert('Saved', 'Edits saved to the draft.')` | `<CompletionMoment variant="quiet" title="Saved." />` (Screen C edits don't even need this since they persist silently) |
| Save failed | `Alert.alert('Save failed', 'Try again.')` | `<CalmError title="That didn't save." recovery={{label: 'Try again', onPress: retry}} />` |
| Approve confirm modal title | "Save edits first?" | _(deleted — Screen C makes save-vs-not impossible to confuse)_ |
| Approve confirm options | "Cancel" / "Discard and approve" / "Save and approve" | _(deleted along with the modal)_ |
| Approve success | `Alert.alert('Approved', 'Meal plan assigned to {{name}}.')` | `<CompletionMoment variant="peak" title="Plan assigned to {{name}}." subtitle="She'll see it next time she opens the app." />` |
| Approve failed | `Alert.alert('Approve failed', 'Try again.')` | `<CalmError title="The plan didn't post." recovery={{label: 'Try again', onPress: retry}} />` |
| Reject button label | "Reject" | "Reject this draft" |
| Reject reason field placeholder | "Reason (optional)" | "What about this draft isn't right? (The AI learns from this.)" |
| Reject success | `Alert.alert('Rejected', 'Draft rejected.')` | `<CompletionMoment variant="quiet" title="Sent back. The AI will revise." />` |
| Screen A flag row, none present | (no zero-state currently) | "No flags. Looks ordinary." |
| Screen A flag row, present | "1 warning" | "Two items reuse last week's lunch. One snack exceeds your protein cap." |
| Continue button | "Save" + "Approve & Assign" both visible | "Continue review →" (Screen A only) |

Every `Alert.alert` in the current file is replaced. The two `useState`s tracking modal visibility (`showRejectModal`, `showApproveModal`) reduce to one slim reject sheet.

---

## Haptic / motion spec — when does what fire

| Event | Haptic | Motion |
|---|---|---|
| Screen A mount (after load) | none | `enter` on summary card; `breath` on AI eyebrow |
| Load fails | `error` | `<CalmError>` inline |
| "What's different" expand | `tap` | `morph` on the disclosure |
| Continue review press | `tap` | Stack push transition; Screen B `enter` cascade |
| Reject press | `caution` | Bottom sheet rises |
| Reject submit | `confirm` | Sheet dismisses; `quiet` CompletionMoment back at client detail |
| Screen B day swipe / Continue | `tap` | Slide-stack transition (native) |
| Screen B meal row tap | `tap` | Push Screen C |
| Screen C item edit | `confirm` (on each commit, debounced 800ms) | 200ms ink → forest tint on the changed field |
| Screen C Done | `tap` | Pop back; meal row totals `morph` to new values |
| Final Approve and assign | `success` then `peak` (chained, 200ms apart) | Stack pop; `peak` CompletionMoment overlays |
| Save as draft (final) | `confirm` | Stack pop; `quiet` CompletionMoment |

---

## Success criteria

1. **Audit score moves from 1.7/5 to ≥3.7/5** (a "D" → "B" jump). CogSimple climbs from 1 to ≥4 (this is the primary delta). Premium from 2 to ≥4. Rewarding from 2 to ≥4 thanks to peak completion.
2. **No more than 3 simultaneous decisions ever visible on any sub-screen.** Screen A has 2 (Continue / Reject). Screen B has 3 at most (Approve-this-day / Continue / back). Screen C has 1 (Done).
3. **No `Alert.alert(...)` survives in this file.** All success/error paths use Stillwater primitives.
4. **Coach approval rate of unedited drafts drops.** This is the leading product metric: if the redesign works, coaches will edit ≥1 field on at least 40% of drafts (vs. estimated ~15% today, where the rubber-stamp problem is most acute). Measure via the existing draft-edit telemetry.
5. **Median time-to-approve declines or holds.** The new flow is structurally longer (more screens), but each screen is faster to read. We expect parity ± 20 seconds. If time-to-approve doubles, the flow is over-disclosed and should be flattened.
6. **The peak CompletionMoment is the moment coaches mention in feedback.** Qualitative read: "the approve moment felt like a real thing" or "I noticed when I assigned a plan." If we hear "the approve animation felt cheesy" the calibration is wrong; tune `peak` motion preset down.

---

_End of `coach-ai-mealplan-draft.md`. The analog spec for `coach/AIWorkoutDraftScreen.tsx` (also 1.7/5) follows the same three-screen pattern with day/exercise/set replacing day/meal/item._
