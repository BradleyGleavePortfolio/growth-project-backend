# Redesign Spec — `client/HomeScreen.tsx`

_Target file: [src/screens/client/HomeScreen.tsx](../../repos/growth-project-mobile/src/screens/client/HomeScreen.tsx). Current audit score: **4.3/5 overall** (5 Premium, 3 Rewarding, 5 CogSimple). Best surface in the app. Spec only._

---

## Current state (prose)

HomeScreen today is the canonical Stillwater-aligned surface. Its header comment explicitly names it as a "luxury hero rewrite — one thought, not eleven" ([HomeScreen.tsx header](../../repos/growth-project-mobile/src/screens/client/HomeScreen.tsx#L1-L14)), and the audit notes it as "Best Apple de-load example: 'one thought, not eleven,' strong tokens, generous whitespace, one clear next action" ([audit HomeScreen row](../../audits/ux_review_report.md#L77)). It removed the streak banner, calorie ring, macro bar, day selector, community win, trust cue row, identity badge, milestone tiles, weekly volume card, habits section, and quick-access grid.

What's currently on screen:
1. Bone background, no header chrome.
2. Editorial serif date headline (Cormorant Garamond, e.g. "Tuesday, the twenty-eighth.") — `buildDateAsPoetry`.
3. A charcoal one-line progress sentence ("Two meals logged. One workout to go." / "A clean slate.") — `buildProgressLine`.
4. A single ink-fill CONTINUE CTA (rendered conditionally on whether a workout exists).
5. Hairline rule.
6. A 2×2 number grid below the fold (meals, water, etc.).
7. The cross-pillar `HolisticInsightsTile` and `CoachIntroductionBanner` if applicable.

The screen scores 5/5 on Premium and 5/5 on CogSimple. It scores 3/5 on Rewarding because the screen is calm and clear but does not yet have a `CompletionMoment`, a `breath` motion, or any tactile peak when the user lands on it the first time each day. The audit's own note: "add tactile/animated payoff to reach 5 reward" ([audit Day1Win](../../audits/ux_review_report.md#L69), applied by analogy to HomeScreen).

---

## Problem statement

HomeScreen violates none of the Stillwater principles; it earned a 4.3 by living all of them already. The gap from 4.3 to 5.0 is specifically Principle 2 (Every completion is a peak moment) and Principle 3 (The screen breathes between actions) — both currently under-applied. Right now the screen is **calm but inert**. The first tap of the day produces no tactile acknowledgment that the day has begun, and the idle state has no perceptible heartbeat. This costs us the "the product is alive and here with me" signal Phantom and Duolingo both spend heavily to produce ([Mobile Doc §2.2 Phantom ghost bob](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L363-L370), [Mobile Doc §2.1 Duolingo owl breath, referenced throughout](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L133-L324)).

---

## Target state (prose mock — top to bottom)

When the user opens the app for the first time today and lands on HomeScreen, here is exactly what they see and feel, in order:

1. **The screen breathes in.** Background bone, no chrome. Three lines fade in with the `enter` motion preset, staggered 60ms — date headline first, progress line second, primary CTA third. Total reveal duration ~800ms. The whole effect is slow and deliberate; nothing snaps.

2. **The date headline sits in its own quiet.** "Tuesday, the twenty-eighth." Cormorant Garamond 32pt (h1), color `textPrimary`. No icon. No badge. No streak number. Just the date, written like a journal entry. Underneath it, in `body` Inter, the progress sentence: "A clean slate." or "Two meals logged. One workout to go." Color `textMuted`.

3. **The primary surface breathes.** The CONTINUE button (ink fill, `radius.sm = 0`, `bodyMd` Inter, the word "Continue" not "CONTINUE") sits at a comfortable thumb height. The button's opacity gently pulses 1.0 → 0.985 → 1.0 over 4 seconds in a loop — the `breath` motion preset. The pulse amplitude is so small that a user who doesn't notice it consciously will still feel the screen is alive. (Reduced-motion accessibility setting disables the pulse entirely.)

4. **First tap of the day fires a contextual peak moment.** When the user presses CONTINUE for the first time on a given calendar date, the `tap` haptic fires (as for any button press) and then, immediately after, a `quiet` variant `CompletionMoment` flashes underneath the button for ~600ms: a hairline-thin strip in `forest`, with a single line in `bodySmall`: "Begun." The strip fades out as the next screen pushes in. This is the day's quiet opening — a tactile acknowledgement that today has started, before any actual workout or check-in.

5. **The fold-and-below stays the same.** The 2×2 number grid, the holistic insights tile, the coach introduction banner — all preserved. The audit gives HomeScreen 5/5 on CogSimple; we don't add anything below the fold.

6. **Pull-to-refresh stays.** Existing `RefreshControl` behavior preserved.

The aggregate change is: nothing visible got added. Nothing visible got removed. The screen now **moves**, in two very specific places, in ways that take the score from 4.3 to 5.0.

---

## Component breakdown — primitives used

| Primitive (from `01-tactile-primitives.md`) | Where it fires on HomeScreen |
|---|---|
| `useSpring('enter')` | The three top-of-screen elements (date, progress line, CTA) on initial mount, staggered 60ms |
| `useSpring('breath')` | The Continue button's idle pulse, continuously while screen focused |
| `useHaptic('tap')` | On CONTINUE press (already wired conceptually; standardize the call) |
| `<CompletionMoment variant="quiet">` | First tap of the day only — gated by `AsyncStorage` key `last_home_continue_date` matching today |
| No `<QuietSkeleton>` | HomeScreen data is fast enough that the existing `SkeletonScreen` import suffices for the cold-load path |

The full Stillwater Path block this redesign installs:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     App launch, tab tap, or notification → root.
 * HERE:     Read one date-line and one progress line. Tap Continue to
 *           enter today's open loop (workout or check-in).
 * NEXT:     ActiveWorkout | CheckIn | Plan — one route, determined by
 *           today's primary open loop.
 * CLOSURE:  Quiet — first tap of the day fires a CompletionMoment
 *           variant 'quiet' acknowledging that today has begun.
 *
 * Primitives: useSpring(enter, breath), useHaptic(tap), CompletionMoment(quiet)
 */
export const stillwater = {
  primaryDecision: "Begin today's open loop",
  primaryActionLabel: 'Continue',
  expectedExit: 'navigate',
} as const;
```

---

## Copy patches — before / after

| Element | Before (current) | After (Stillwater) |
|---|---|---|
| Primary CTA label | "CONTINUE" (all-caps) | "Continue" (title case, `bodyMd`) |
| Progress line, zero-state | "A clean slate." | "A clean slate." (preserved — already on standard) |
| Progress line, workout done | "Workout complete." | "Today's movement: done." |
| Number cell label, meals | "MEALS" (eyebrow caps) | "Meals" (still eyebrow but in mixed case — keep `eyebrow` type token, just the string changes if any) |
| First-tap-of-day moment | (none) | "Begun." (lifestyle voice, lowercase first letter for consistency with mid-sentence reading) |

The all-caps "CONTINUE" violates the lifestyle-voice rule in the manifesto (no shouting). All other copy on the screen is already on standard.

---

## Haptic / motion spec — when does what fire

| Event | Haptic | Motion |
|---|---|---|
| Screen mount (cold) | none | `enter` staggered on three top elements; `breath` begins on CTA |
| Screen focus (warm, navigated back) | none | `breath` resumes; no `enter` to avoid re-revealing |
| Pull to refresh | `tap` on release | RefreshControl native animation; `breath` paused while refreshing |
| CONTINUE press, any day after the first tap | `tap` | 120ms opacity dip 1 → 0.85 → 1 on CTA, then nav transition |
| CONTINUE press, **first tap of the day** | `tap`, then 200ms later a `confirm` underneath | 600ms `quiet` CompletionMoment strip fades in/out; CTA dip as normal |
| Number cell tap | `tap` | 120ms opacity dip |
| Background → foreground transition | none | `breath` resumes if it had paused |

---

## Success criteria

We know the redesign worked when:

1. **Audit score moves from 4.3/5 to ≥4.7/5.** Specifically: Rewarding climbs from 3 to ≥4. Premium and CogSimple stay at 5.
2. **`completion_moment_shown` analytics shows `{variant: 'quiet', surface: 'HomeScreen'}` firing exactly once per user per day** during the 14-day post-launch window. If it fires more than once, the AsyncStorage key gating is broken. If it fires less than ~90% of days a user opens the app, the trigger is buried.
3. **No regression on time-to-Continue.** The current cold-mount-to-CTA-render is ≤500ms; the 800ms staggered `enter` must not push that over the same threshold for actually pressing the CTA (the user can press it during the entry animation, the press still works, the animation completes).
4. **Reduced-motion users see no visual regression.** Manual accessibility audit: enable Reduce Motion → all elements appear instantly, breath disabled, quiet CompletionMoment renders as static text strip without animation, haptics still fire.
5. **Lint passes the De-Load Checklist.** All ten items from `02-screen-grammar.md §5` green on this file.
6. **Qualitative read.** When a non-employee opens the screen and is asked "what do you feel?", the answer should be in the family of "calm," "noticed," "still," "alive but quiet." If the answer is "boring" or "static" we've gone too far on the reduction side; if it's "busy" or "anxious" something leaked back in.

---

_End of `client-homescreen.md`._
