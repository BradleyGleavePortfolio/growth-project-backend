# 01 — Tactile Primitives

_Reusable haptic + motion + completion primitives. Spec only. Consumed by every screen described in `02-screen-grammar.md` and every redesign in `03-redesign-specs/`._

The current codebase already exports velvet motion durations (`fast: 120 / base: 400 / slow: 800 / deliberate: 1200`) and expo-out easings ([tokens motion](../repos/growth-project-mobile/src/theme/tokens.ts#L270-L286)), plus haptic helpers (`mediumTap`, `warningTap`, `successTap` referenced from `SettingsScreen` at [SettingsScreen.tsx line 25](../repos/growth-project-mobile/src/screens/client/SettingsScreen.tsx#L25)). The Stillwater primitives **wrap and extend** those tokens rather than replace them — implementers should map every named pattern below onto the existing motion + haptic primitives.

---

## 1. `useHaptic()` — Six Named Patterns

A single hook with six string-named patterns. Each pattern: when to use, exact iOS/Android impulse, duration, and what it must pair with visually. The hook respects the system "Reduce Motion" / "Vibration" accessibility flag and degrades to no-op when the user has it off.

### `tap`
- **When:** Any non-destructive button press that does not change state (open a sheet, toggle disclosure, scrub a chart).
- **Impulse:** `Haptics.selectionAsync()` on iOS; 8ms light vibrate on Android.
- **Duration:** ~10ms.
- **Pairs with:** A 120ms (`motion.duration.fast`) opacity dip from 1.0 → 0.85 → 1.0 on the pressed element. No color change.
- **Required because:** Apple's behavioral satisfaction doctrine — every conscious action gets immediate, precisely calibrated feedback ([Mobile Doc §1.2 behavioral layer](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L74-L88)).

### `confirm`
- **When:** A toggle flips, a chip is selected, a row checkbox ticks. State changed but the action is reversible and non-celebratory.
- **Impulse:** `Haptics.impactAsync(ImpactFeedbackStyle.Light)`.
- **Duration:** ~15ms.
- **Pairs with:** 200ms ink → forest tint on the affected element (the chip fills, the row check inks in), then settles. No screen-level motion.
- **Required because:** The audit's cross-cutting finding — "most actions end in static state, Alert-like utility, or silent success" ([audit cross-cutting reward](audits/ux_review_report.md#L278)). `confirm` closes that gap for the 80% of interactions that don't deserve `success`.

### `success`
- **When:** A meaningful save that the user initiated and waited for (workout finished, check-in submitted, plan approved, password changed). One per screen per session, typically.
- **Impulse:** `Haptics.notificationAsync(NotificationFeedbackType.Success)` — the iOS "two-bump" pattern.
- **Duration:** ~80ms.
- **Pairs with:** A `CompletionMoment` (see §3 below) at variant `standard`. Always pairs — `success` haptic without a CompletionMoment is forbidden because it produces a phantom-feedback feeling (the phone buzzed but nothing visibly happened).
- **Required because:** Mobile doctrine §5.1 step 6 — every meaningful completion gets a dedicated micro-interaction, not a static text change ([Mobile Doc §5.1](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1487-L1492)).

### `peak`
- **When:** Rare exceptional outcomes. Examples: closing all three daily rings, completing the first workout ever, hitting a personal record, finishing a 30-day program. Maximum frequency: ~1 per user-week on average. If it fires more often than that, the trigger is mis-calibrated and should be downgraded to `success`.
- **Impulse:** Sequenced — `impactAsync(Heavy)` → 60ms gap → `impactAsync(Medium)` → 40ms gap → `notificationAsync(Success)`. The "heartbeat → resolution" pattern.
- **Duration:** ~200ms total.
- **Pairs with:** `CompletionMoment` variant `peak`: a 1200ms (`motion.duration.deliberate`) deliberate reveal with personalized copy and the share/next-action hook. Never confetti.
- **Required because:** Variable reward magnitude — exceptional outcomes must be *distinguished* from ordinary ones; same haptic for ordinary and exceptional flattens reward ([Mobile Doc §3.5](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L896-L918)). Also the Apple Watch ring-closure principle: peak moments are deliberately over-engineered ([Mobile Doc §3.6](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L949-L952)).

### `caution`
- **When:** The user is about to do something that has consequences but is recoverable (leave an unsaved draft, decline a coach invite, pause a streak). Pre-action, not post-action.
- **Impulse:** `Haptics.impactAsync(ImpactFeedbackStyle.Medium)` — a single firmer bump.
- **Duration:** ~30ms.
- **Pairs with:** The destination element (modal, sheet, dialog) sliding in with 400ms (`motion.duration.base`) and the warning-triad palette (`semantic.warning`) — never red. Copy is in lifestyle voice: "This isn't saved yet — leave anyway?" not "Unsaved changes! Are you sure?"
- **Required because:** CALM framing — animation modulates the emotional baseline so the user enters the decision in a relaxed state, not a startled one ([Mobile Doc §2.2 Phantom CALM](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L445-L466)).

### `error`
- **When:** Genuine failure. A request errored, a payment was declined, a delete failed. Post-action.
- **Impulse:** `Haptics.notificationAsync(NotificationFeedbackType.Error)` — the iOS three-bump pattern.
- **Duration:** ~100ms.
- **Pairs with:** Inline calm explanation (see §4 below), not a red toast, not a red banner. The affected element gets a 200ms left-right shake of 4px and a hairline shift to `semantic.danger.border`. The recovery action is visible immediately.
- **Required because:** Audit cross-cutting — empty/error states are reward + trust opportunities currently being squandered ([audit cross-cutting](audits/ux_review_report.md#L278), [Top-20 fix #13](audits/ux_review_report.md#L301)).

### Implementation contract

```ts
// Spec only — do not implement in this task.
type StillwaterHaptic = 'tap' | 'confirm' | 'success' | 'peak' | 'caution' | 'error';
function useHaptic(): (pattern: StillwaterHaptic) => void;
```

- The hook reads `AccessibilityInfo.isReduceMotionEnabled()` once on mount and caches it; when true, all visual pairings degrade to opacity-only.
- It also reads a global `Settings.haptics` preference and respects it.
- All six patterns are NO-OPs on web; the visual pair still fires.

---

## 2. `useSpring()` — Motion Presets

The existing token system defines durations and easings but not named motion presets. Stillwater adds five preset names that map onto those tokens. The point of named presets is that no screen should specify durations or easings directly — they always call a named preset, and the preset can be retuned globally.

All presets respect `motion.duration.*` and `motion.easing.decel` (the expo-out curve) from [tokens.ts](../repos/growth-project-mobile/src/theme/tokens.ts#L270-L286). Where damping/mass/stiffness are listed, they are for React Native Reanimated `withSpring`; for `withTiming` use the cubic-bezier easing equivalent.

### `enter`
- **When:** Any element appearing on a new screen or scrolling into view for the first time in this session.
- **Spec:** `withTiming(800ms, ease: motion.easing.decel)` on opacity (0 → 1) and translateY (8px → 0). Staggered 60ms per element for groups of ≤5.
- **Spring equivalent:** `damping: 22, mass: 1, stiffness: 180`.
- **Rationale:** Slow reveal communicates intentionality; the staggered cascade is the same pattern Apple uses on iOS home screen icon entry ([Mobile Doc §1.2 behavioral](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L83-L88)). 800ms aligns with `motion.duration.slow`.

### `exit`
- **When:** An element leaving (sheet dismissed, screen popped, snackbar fading).
- **Spec:** `withTiming(400ms, ease: motion.easing.smooth)` on opacity (1 → 0) and translateY (0 → 8px). No stagger.
- **Spring equivalent:** `damping: 24, mass: 1, stiffness: 220`.
- **Rationale:** Exits are deliberately faster than entries (400ms vs 800ms) so the system feels responsive but not abrupt. This asymmetry — slow in, faster out — is a signature feel of premium iOS apps.

### `morph`
- **When:** An element changing state in place (tab switch, chip toggle, progress ring filling, summary card expanding into detail). Continuous, not discrete.
- **Spec:** `withSpring(damping: 18, mass: 1, stiffness: 200)` on the changing property. ~500ms perceived duration; no fixed cap.
- **Rationale:** Behavioral satisfaction comes from physical-feeling transitions. Apple's spring physics on tab switches and Phantom's wallet balance morphs both use this exact damping range ([Mobile Doc §1.2 behavioral competence](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L88-L100)).

### `peak`
- **When:** Inside `CompletionMoment` variant `peak` only. Never used directly by screen code.
- **Spec:** Multi-phase, total ~1800ms:
  - Phase A (0–300ms): scale 1.0 → 1.04 with `withSpring(damping: 14, mass: 1.2, stiffness: 160)`. Color sweep from `ink` to `forest` on the primary text element.
  - Phase B (300–1200ms): hold. The `breath` motion runs underneath (see below) so the element is alive, not frozen.
  - Phase C (1200–1800ms): scale 1.04 → 1.0 with `withTiming(motion.duration.slow, ease: motion.easing.decel)`. Personalized copy line fades in below.
- **Rationale:** Apple ring closure is "deliberately over-engineered" — sparks, fill, haptic sequence, sound ([Mobile Doc §3.6](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L949-L952)). Our equivalent removes the sparks, keeps the over-engineering in the motion choreography and color sweep. Peak-end rule ([Mobile Doc §5.1 step 7](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1494-L1498)).

### `breath`
- **When:** Idle state of any primary surface element. Always on, always subtle. The "the product is alive" pulse.
- **Spec:** `withRepeat(withTiming(4000ms, ease: motion.easing.smooth), -1, true)` on opacity (1.0 → 0.985 → 1.0) **or** scale (1.0 → 1.005 → 1.0). One or the other per element, never both.
- **Rationale:** Phantom ghost bob, Duolingo owl breath ([Mobile Doc §2.2 Phantom mascot animation](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L363-L370)). The amplitude is intentionally smaller than either of those because our brand is quieter — 1.5% scale variation reads as "calm presence," 5% would read as "anxious." Disabled when `prefersReducedMotion === true`.

### Implementation contract

```ts
// Spec only.
type StillwaterMotion = 'enter' | 'exit' | 'morph' | 'peak' | 'breath';
function useSpring(preset: StillwaterMotion, deps?: unknown[]): {
  animatedStyle: AnimatedStyle;
  start: () => void;
  reset: () => void;
};
```

---

## 3. `CompletionMoment` — Component Contract

The single most important primitive Stillwater introduces. It is the answer to the audit's cross-cutting finding that "reward is the weakest dimension" ([audit](audits/ux_review_report.md#L278)) and to Top-20 fix #1 ([audit](audits/ux_review_report.md#L289)).

### Props

```ts
type CompletionMomentProps = {
  /** Three intensity levels. Default 'standard'. */
  variant?: 'quiet' | 'standard' | 'peak';

  /** What was completed, in lifestyle voice. e.g. "Today's check-in, saved." */
  title: string;

  /** Optional second line of personal context. e.g. "Seven mornings in a row."
   *  Only rendered for 'standard' and 'peak'. */
  subtitle?: string;

  /** Optional next-action hook. e.g. { label: "Open the week", onPress } */
  nextAction?: { label: string; onPress: () => void };

  /** Optional share hook — only meaningful for 'peak'. */
  shareAction?: { label: string; onPress: () => void };

  /** Anchor element to attach to. If omitted, renders as bottom sheet for
   *  'peak' and as inline strip for 'quiet'/'standard'. */
  anchorRef?: React.RefObject<View>;

  /** Reduce-motion fallback override. If true, motion is suppressed even
   *  when system flag is off (used by E2E tests). */
  forceReducedMotion?: boolean;

  /** Fires when the moment finishes its animation cycle. */
  onComplete?: () => void;
};
```

### Variants

| Variant | Haptic | Motion | Visual | Copy density |
|---|---|---|---|---|
| `quiet` | `confirm` | 200ms ink → forest tint on anchor element | Inline, in place | Title only |
| `standard` | `success` | `morph` + 800ms color sweep on anchor | Inline strip, 64px tall | Title + subtitle |
| `peak` | `peak` | `peak` preset (full 1800ms choreography) | Bottom sheet, full-width, dismissible | Title + subtitle + next + optional share |

### Behavior

- The component is **idempotent per key** — re-mounting with the same `key` prop within 5 seconds does not re-fire the haptic or motion. This prevents double-fires from React StrictMode or rapid re-renders.
- `peak` variant is dismissible by swipe-down or by the `nextAction` button. Auto-dismiss after 8 seconds if neither.
- `quiet` and `standard` variants auto-dismiss after their animation; they do not block.
- Accessibility: announces title to screen readers via `AccessibilityInfo.announceForAccessibility`. Reduced-motion users get the haptic + the copy with no animation.
- Analytics: each fire emits `completion_moment_shown` with `{ variant, title }` so we can audit calibration (peak frequency should average ≤1/user/week as specified in §1 above).

### Example invocations — five contexts

These are the five contexts the audit + doctrine most reward. The example shows the call site (illustrative) and the variant choice rationale.

**Context 1 — Workout finished.**
```tsx
<CompletionMoment
  variant="standard"
  title="Done. Saved."
  subtitle={`That's ${weekCount} sessions this week.`}
  nextAction={{ label: "Open the plan", onPress: () => nav.navigate('Plan') }}
/>
```
Standard because finishing a workout is the daily peak of the workout flow but not the rarest event. Sourced from the workout completion drive principle ([Mobile Doc §3.6 ring closure](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L920-L972)).

**Context 2 — Check-in saved.**
```tsx
<CompletionMoment
  variant="quiet"
  title="Saved."
/>
```
Quiet because daily check-ins are routine; over-celebrating them flattens the curve. The audit's "every action ends in static state" finding ([audit cross-cutting](audits/ux_review_report.md#L278)) is the trigger — silent success is replaced with a quiet completion, not a celebratory one.

**Context 3 — Streak day +1.**
```tsx
<CompletionMoment
  variant="standard"
  title="Seven mornings in a row."
  subtitle="That's the version of you that sticks."
/>
```
Standard for milestone days (3, 7, 14, 30, 60, 100); quiet for in-between days; peak reserved for first-ever 30-day completion. Variable reward magnitude ([Mobile Doc §3.5](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L912-L918)).

**Context 4 — Plan approved by coach.**
```tsx
<CompletionMoment
  variant="peak"
  title="Your week is ready."
  subtitle="Approved by Sam. Read when there's a quiet minute."
  nextAction={{ label: "Open the week", onPress: openPlan }}
/>
```
Peak because (a) this is the meaningful payoff of the coach pairing relationship, and (b) it happens roughly weekly per client — within the peak-frequency budget. This is also the canonical use case for the AI meal plan redesign (see `03-redesign-specs/coach-ai-mealplan-draft.md`).

**Context 5 — Payment recovered (failed → succeeded).**
```tsx
<CompletionMoment
  variant="standard"
  title="Payment went through."
  subtitle="No interruption to your plan."
  nextAction={{ label: "Continue", onPress: closeCheckout }}
/>
```
Standard, never peak — payment recovery is a relief moment, not a celebration moment. Over-celebrating a recovered payment reads as condescending. CALM framing applied to financial high-stakes ([Mobile Doc §2.2 Phantom CALM](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L445-L466)).

---

## 4. Empty / Loading / Error Primitives

Three primitives that replace the three weakest patterns in the current product.

### `<QuietSkeleton>` — replaces spinners

- **Replaces:** All loading spinners except sub-800ms waits (where a spinner is correct).
- **Behavior:** A bone-colored block with a 1600ms `withRepeat` opacity pulse from 1.0 → 0.94 → 1.0 (slower than `breath`, more visible as "loading"). Shape matches the eventual content silhouette — for a list, render 3–5 row silhouettes; for a card, render the card outline with hairline rule placeholders for the text.
- **Reveal:** When data arrives, fade skeleton out over 400ms (`exit` preset) and stagger the real content in with `enter` preset at 60ms intervals.
- **Spec for the existing `SkeletonScreen` component:** It already exists at [growth-project-mobile/src/ui/skeletons/Skeleton.tsx](../repos/growth-project-mobile/src/ui/skeletons/Skeleton.tsx) and is imported by `HomeScreen` ([line 17](../repos/growth-project-mobile/src/screens/client/HomeScreen.tsx#L17)). The Stillwater spec is: standardize the pulse timing to 1600ms across all skeleton variants, ensure stagger on reveal, and audit every spinner usage in the codebase against the "is this <800ms?" rule ([audit Top-20 fix #16](audits/ux_review_report.md#L304)).

### `<CalmError>` — replaces error toasts

- **Replaces:** Red banner toasts, `Alert.alert(...)` error popups, the generic "Something went wrong."
- **Props:** `{ title: string; recovery: { label: string; onPress: () => void }; helpHref?: string; }`
- **Layout:** Inline within the affected surface, never a global toast. Hairline rule above and below in `semantic.warning.border`. 16px (`spacing.lg`) padding. Icon left (an `Ionicons` quiet pictogram, not a red ⚠), title in `bodyMd`, recovery action as a `tap`-haptic text link in `forest`.
- **Copy template:** First sentence names what didn't happen in plain language. Second sentence (optional, shorter) offers the recovery action by name. Examples:
  - Before: "Error: Network request failed (status 500)."
  - After title: "We couldn't reach your plan just now."
  - After recovery label: "Try again"
- **Haptic:** `error` fires once when the component mounts (not on every re-render).
- **Rationale:** Phantom's error-as-trust-building principle ([Mobile Doc §2.2 error states](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L498-L502)).

### `<NextPrompt>` — replaces "No data" / empty states

- **Replaces:** "No data," "Nothing here yet," generic empty illustrations.
- **Props:** `{ title: string; prompt: string; primaryAction: { label: string; onPress: () => void }; secondaryAction?: { label: string; onPress: () => void }; }`
- **Layout:** Centered in the empty container, generous vertical breathing (96px top padding minimum). Title in `h2` Cormorant. Prompt below in `body`, max 2 lines. Single primary CTA in ink. Optional secondary as a calm text link.
- **Copy template:** Reframe absence as readiness, not lack. Examples:
  - Before: "No workouts yet."
  - After title: "Your week is open."
  - After prompt: "When your coach drafts a plan, it'll arrive here."
  - After primary: "See sample weeks"
- **Rationale:** Audit Top-20 fix #13 — empty states are reward + trust opportunities, not punishments ([audit](audits/ux_review_report.md#L301)). Onboarding doctrine — motion before commitment ([Mobile Doc §5.2](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1509-L1512)).

---

## 5. Token alignment table

For implementers: every primitive above maps onto an existing token. No new design tokens are introduced. The mapping:

| Primitive concept | Existing token reference |
|---|---|
| `tap` / `confirm` motion duration (10–200ms) | `motion.duration.fast` = 120ms |
| `enter` / `breath` / sweep duration | `motion.duration.slow` = 800ms |
| `peak` total choreography duration | `motion.duration.deliberate` = 1200ms (extended to 1800ms in `CompletionMoment`) |
| All easings | `motion.easing.decel` for entries, `motion.easing.smooth` for exits |
| Forest tint on sweeps | `colors.forest` = #2C4A36 |
| Warning chrome on `caution` / `CalmError` | `semantic.warning.{bg, border, fg}` |
| Danger chrome on true-destructive only | `semantic.danger.{bg, border, fg}` |
| Inline-strip height for `standard` CompletionMoment | 64px = `spacing.4xl` |
| Bottom-sheet shadow on `peak` CompletionMoment | `shadows.lg` |

All values from [tokens.ts](../repos/growth-project-mobile/src/theme/tokens.ts).

---

_End of `01-tactile-primitives.md`. See `02-screen-grammar.md` for the rules every screen must follow when composing these primitives._
