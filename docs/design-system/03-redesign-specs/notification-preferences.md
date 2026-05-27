# Redesign Spec — `notifications/NotificationPreferencesScreen.tsx`

_Target file: [src/screens/notifications/NotificationPreferencesScreen.tsx](../../repos/growth-project-mobile/src/screens/notifications/NotificationPreferencesScreen.tsx). Current audit score: **2.0/5 overall** (3 Premium, 1 Rewarding, 2 CogSimple). Duplicate of the settings/NotificationPreferencesScreen.tsx pattern. Spec only._

---

## Current state (prose)

The screen renders a **full kind × channel matrix**: 8 notification kinds (coach, milestone, check_in, message, build_week, system, reminder, tip) × 3 channels (email, push, in-app) = **24 toggles in one grid**, plus a mute-all override toggle and two quiet-hour time pickers (start, end, with 30-minute step buttons). Each kind row has a one-sentence description. Section headers are uppercase eyebrow caps in `textMuted` ([NotificationPreferencesScreen.tsx lines 36–95](../../repos/growth-project-mobile/src/screens/notifications/NotificationPreferencesScreen.tsx#L36-L95)).

The audit's verdict: "Many channels/types/quiet-hours controls on one screen; needs preset-first progressive disclosure" ([audit row](../../audits/ux_review_report.md#L193)). Top-20 fix #3: "Replace channel/type matrices with 3 presets plus Advanced accordions" ([audit Top-20 #3](../../audits/ux_review_report.md#L291)).

A near-duplicate matrix exists at `settings/NotificationPreferencesScreen.tsx` (also 2.0/5, [audit row](../../audits/ux_review_report.md#L214)). This spec applies to both; the implementation should consolidate to a single shared component used in both routes.

---

## Problem statement

The screen presents the user with **24 simultaneous decisions before knowing what the user actually wants**. This is the canonical "matrix-of-toggles" anti-pattern — it abdicates design judgment by exposing every dimension instead of providing sensible defaults and a path to refinement. It violates:

- **Principle 1** (Premium is what you take AWAY): no curation; everything is visible.
- **Principle 4** (Decisions are sequenced, not stacked): 24 decisions in one paint.
- **Principle 7** (Lifestyle voice): "Build week gates," "Platform updates," "Habit reminders" are engineering taxonomy, not lifestyle vocabulary.

Doctrine: Hick's Law's smart-default principle ([Mobile Doc §4.4](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1180-L1236)) and progressive disclosure ([Mobile Doc §4.5](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1237-L1300)). The audit's prescription matches: preset-first.

---

## Target state (prose mock — top to bottom)

The redesigned screen offers **three named presets** at the top, a quiet-hours block in the middle, and a single "Advanced" disclosure at the bottom. Most users complete the screen in one tap.

Scrolling top to bottom:

1. **Header.** Cormorant h1: "How we reach you." Subhead in `body`, color `textMuted`: "Pick a starting point. You can tune the details later."

2. **The three presets** — three full-width cards, stacked vertically (not horizontally — comparison clarity beats fold compression), each with title in Cormorant h3, body in `bodySmall`, and a single radio indicator on the right. The currently selected preset shows a `forest` hairline-rule on the left edge. Selecting a preset fires `confirm` haptic + 200ms `morph` on the rule slide.

   - **Quiet** (default for new accounts)
     - Title: "Quiet"
     - Body: "We'll text you only when it really matters: a coach reply, a missed check-in, or a payment hiccup. Everything else stays in the app."
     - What this configures, in code: `mute_all = false`; `coach.push = true, .email = true, .in_app = true`; `check_in.push = true, others = false`; `system.email = true, others = false`; everything else off.

   - **Steady** (recommended for active members)
     - Title: "Steady"
     - Body: "A morning prompt, a coach update when one comes in, and a quiet weekly summary. No mid-day pings."
     - What this configures: as Quiet, plus `reminder.push = true` (morning only — gated by the quiet-hours block below), `milestone.push = true`, weekly `tip.email = true`.

   - **Full** (for the user who wants to hear everything)
     - Title: "Full"
     - Body: "Everything on. Use this if you've gone quiet and want the app to nudge you back."
     - What this configures: all kinds × all channels = true.

3. **Quiet hours** — a single inline block, hairline-ruled above and below.
   - Title in `eyebrow`: "Quiet hours"
   - Body in `bodySmall`: "We won't push or vibrate between {{startTime}} and {{endTime}}." (the times themselves are tappable to open a single-control time-picker sub-screen, one decision each)
   - Toggle on the right to disable quiet hours entirely. Default ON, 9pm → 7am.
   - This block applies regardless of preset; presets do not override quiet hours.

4. **A single "Advanced" disclosure row** at the bottom, with a right-chevron and the label "Channel-by-channel control." Tapping it pushes a sub-screen — the existing matrix, lightly retitled and with lifestyle-voice copy. This is where power users still find everything; the matrix isn't deleted, it's demoted.

5. **Below the Advanced row, a quiet footnote** in `caption`, color `stone`: "Changes save automatically." No save button anywhere on the screen.

The redesigned `NotificationPreferencesScreen` becomes a **one-tap screen for ~80% of users**, while preserving full power for the rest behind a single disclosure. This is the apply/page.tsx pattern ([audit](../../audits/ux_review_report.md#L225)) applied to settings.

---

## The 3 presets in tone-of-voice terms

The three presets are not "Off / Some / All." They are **named emotional postures** — what the user is asking the product to be in their life.

- **Quiet** = "Be here when I need you, silent when I don't." This is the Calm/Headspace voice — the app as a quiet companion that earns its interruptions. Default for new accounts because it sets expectations downward and lets engagement be discovered rather than imposed.

- **Steady** = "Keep me on track without nagging." This is the daily-rhythm voice — one morning touch, one weekly recap, surprises only when something needs the user's attention. Recommended for users 30+ days into their program.

- **Full** = "Speak up. I'm not paying attention on my own right now." This is the catch-me voice — explicitly the right choice for a user who has been quiet and wants the product's help to come back. The copy treats this as a legitimate self-care choice, not a "spam yourself" toggle.

The presets map directly onto the streak-architecture doctrine: streaks must motivate, not imprison ([Mobile Doc §3.4 streak trap](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L821-L873)). Same for notifications — the user picks the relationship they want, the app doesn't impose one.

---

## Component breakdown — primitives used

| Primitive | Where it fires |
|---|---|
| `useSpring('enter')` | The three preset cards, staggered 80ms on mount |
| `useSpring('morph')` | The forest rule sliding to the newly selected preset; quiet-hours toggle state |
| `useSpring('breath')` | The selected preset card's left rule pulses faintly so the user can confirm at a glance which one is active |
| `useHaptic('tap')` | Quiet-hours time pickers, Advanced disclosure |
| `useHaptic('confirm')` | Preset selection, quiet-hours toggle, time-picker submit, Advanced matrix toggle |
| `<CompletionMoment variant="quiet">` | Fires on Advanced sub-screen save only, not on preset change (preset change is its own visual confirmation via the rule morph) |
| `<CalmError>` | All API failure paths from the existing `saveNotificationPreferences` call |
| `<QuietSkeleton>` | Mount-time skeleton of three preset cards while initial preferences load |

The Stillwater Path block:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     Settings → "How we reach you" or Notifications tab overflow.
 * HERE:     Pick a preset that names the relationship you want.
 * NEXT:     Back to Settings; or Advanced sub-screen for power tuning.
 * CLOSURE:  Saves are silent — the preset's morph IS the confirmation.
 *           Advanced sub-screen uses a quiet CompletionMoment on dismiss.
 *
 * Primitives: useSpring(enter, morph, breath), useHaptic(tap, confirm),
 *             CompletionMoment(quiet), CalmError, QuietSkeleton
 */
export const stillwater = {
  primaryDecision: 'Choose the kind of presence the app should have in your life',
  primaryActionLabel: 'Steady', // the recommended preset's title; not literally a CTA
  expectedExit: 'dismiss',
} as const;
```

---

## Copy patches — before / after

| Element | Before | After |
|---|---|---|
| Screen title | "Notification Preferences" | "How we reach you." |
| Section header: "Channels" | "CHANNELS" (uppercase eyebrow) | _(deleted from main screen — only appears in Advanced sub-screen)_ |
| Section header: "Quiet Hours" | "QUIET HOURS" | "Quiet hours" (sentence case, inline label) |
| Kind label: "Coach messages" | "Coach messages" | "When your coach writes" (Advanced sub-screen only) |
| Kind label: "Milestones" | "Milestones" | "When you hit a marker" |
| Kind label: "Check-in reminders" | "Check-in reminders" | "Daily check-in nudge" |
| Kind label: "Direct messages" | "Direct messages" | "Inbox replies" |
| Kind label: "Build week gates" | "Build week gates" | "When your next week unlocks" |
| Kind label: "Platform updates" | "Platform updates" | "Account and policy" |
| Kind label: "Habit reminders" | "Habit reminders" | "When a habit hasn't been logged" |
| Kind label: "Coaching tips" | "Coaching tips" | "Occasional notes from the team" |
| Mute-all toggle | "Mute all notifications" | "Pause everything for now" |
| Quiet-hours body | (just the time range) | "We won't push or vibrate between {{start}} and {{end}}." |
| Time-picker error | (raw error if save fails) | `<CalmError title="That didn't save." recovery={...} />` |
| Save indicator | (none — silent today, which is fine) | A 200ms ink → forest tint on the changed preset card border, no toast |
| Advanced disclosure label | (the matrix is the only view) | "Channel-by-channel control" |
| Footnote | (none) | "Changes save automatically." |

The kind-label transformation is the largest copy win. Every existing label is reframed from "what notification class is this" to "what trigger in your life produces this." This makes the Advanced screen readable as a conversation about the user's life, not as a config matrix.

---

## Haptic / motion spec — when does what fire

| Event | Haptic | Motion |
|---|---|---|
| Screen mount | none | `enter` staggered on preset cards; `breath` begins on selected card's rule |
| Preset tap (changing) | `confirm` | `morph` of the forest rule from old card to new card (one continuous motion, not two cuts); `breath` re-targets |
| Preset tap (already selected) | `tap` only | tiny opacity dip on the card |
| Quiet-hours toggle | `confirm` | `morph` on the switch knob; the time-row fades to/from disabled |
| Time picker tap | `tap` | push transition to the time sub-screen |
| Time picker confirm | `confirm` | pop transition; the new time slides in on the main screen with `morph` |
| Advanced disclosure tap | `tap` | push transition to Advanced sub-screen |
| Advanced toggle change | `confirm` | 200ms ink → forest tint on the toggle row |
| Advanced sub-screen dismiss (back) | none | `quiet` CompletionMoment if any changes were made |
| Save API success | none (no UI indication — the morph already confirmed) | none additional |
| Save API failure | `error` | `<CalmError>` inline at the top of the screen |

---

## Success criteria

1. **Audit score moves from 2.0/5 to ≥3.7/5.** CogSimple climbs from 2 to ≥4 (preset-first solves the matrix problem). Premium from 3 to ≥4. Rewarding from 1 to ≥3 thanks to morph confirmation + `CompletionMoment` on Advanced.
2. **80%+ of users choose a preset and never open Advanced.** Measured via analytics: `notification_preset_chosen` fires ≥0.8 × user-count, `notification_advanced_opened` fires ≤0.2 × user-count, over the first 30 days post-launch.
3. **Decision count drops from 24 to 1** on first paint, with Advanced as the optional escape hatch. Direct test of Cognitive Budget compliance ([`02-screen-grammar.md` §3](../02-screen-grammar.md)).
4. **No regression in user-reported missed-notification incidents.** The presets are calibrated to ensure that every preset still receives coach messages and payment hiccups via at least one channel; the only thing the presets vary is volume.
5. **Both NotificationPreferencesScreen.tsx files** ([notifications/](../../repos/growth-project-mobile/src/screens/notifications/NotificationPreferencesScreen.tsx) and [settings/](../../repos/growth-project-mobile/src/screens/settings/NotificationPreferencesScreen.tsx)) consolidate to a single shared component. The audit explicitly flagged the duplicate ([audit settings/NotificationPreferencesScreen](../../audits/ux_review_report.md#L214)).
6. **Voice audit clean.** Zero instances of "build week gates," "platform updates," "channel × kind matrix" in user-visible copy. Every kind label reads as a moment in the user's life.

---

_End of `notification-preferences.md`._
