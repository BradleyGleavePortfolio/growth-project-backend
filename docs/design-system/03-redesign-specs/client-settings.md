# Redesign Spec — `client/SettingsScreen.tsx`

_Target file: [src/screens/client/SettingsScreen.tsx](../../repos/growth-project-mobile/src/screens/client/SettingsScreen.tsx). Current audit score: **1.7/5 overall** (2 Premium, 1 Rewarding, 2 CogSimple). The worst client-side surface. Spec only._

---

## Current state (prose)

The screen is a single 792-line scroll of seven inline section blocks: Account, Nutrition Preferences, Notifications, App Preferences, Security, Personalization, Support, Data & Privacy ([SettingsScreen.tsx lines 170–434](../../repos/growth-project-mobile/src/screens/client/SettingsScreen.tsx#L170-L434)). Every toggle, every segmented control, every stepper, every drill-down row is visible simultaneously. The screen mixes:

- Identity rows (Name, Email, Change Password)
- Domain configuration (Units, Meals per day, Water goal, Calorie display)
- Notification preferences (four reminder toggles + Check-in time row that itself opens a modal)
- App preferences (Appearance radio group, Haptics toggle)
- Security (biometric unlock setting)
- Personalization disclosure (links to advanced notification preferences)
- Support (contact)
- Data & privacy (Trust Center, Blocked Users, plus sign-out and delete-account)

The audit's verdict: "Long settings/control surface; too many visible actions and little emotional return" ([audit SettingsScreen row](../../audits/ux_review_report.md#L97)). The recommended fix from the audit: "Convert flat controls into 5–7 grouped drill-down rows with a single primary task per sub-screen" ([audit Worst-10 #4](../../audits/ux_review_report.md#L253)).

---

## Problem statement

SettingsScreen violates **four** Stillwater principles simultaneously:

- **Principle 1 (Premium is what you take AWAY).** Nothing has been taken away. Every preference is visible at the same depth, regardless of frequency of use.
- **Principle 3 (The screen breathes between actions).** Card-on-card density, no whitespace ratio respected, no breath motion anywhere.
- **Principle 4 (Decisions are sequenced, not stacked).** ~25 simultaneous decisions on first paint. The Cognitive Budget ceiling is 7 primary surfaces and 3 simultaneous decisions ([`02-screen-grammar.md` §3](../02-screen-grammar.md)); this screen exceeds both by ~3×.
- **Principle 7 (Lifestyle voice, not coach voice).** Title-Case Section Headers ("App Preferences," "Nutrition Preferences," "Data & Privacy") read as bureaucratic. Toggle labels ("Meals Per Day," "Calorie Display") read as configuration, not care.

Doctrine: Miller's Law ([Mobile Doc §4.3](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1120-L1178)), Hick's Law ([Mobile Doc §4.4](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1180-L1236)), Progressive Disclosure ([Mobile Doc §4.5](../../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1237-L1300)).

---

## Target state (prose mock — top to bottom)

The redesigned Settings is **a single screen with six rows, a search field, and nothing else**. Each row is a navigation target. Every actual control lives on its own sub-screen, where it is the single primary decision.

What the user sees on the redesigned `SettingsScreen`, scrolling top to bottom:

1. **Header:** Cormorant Garamond h1, color `textPrimary`. The word "Settings." — with the period, lowercase elsewhere on the screen. No back chevron, no overflow menu, no edit button.

2. **Search field:** Inter `body`, hairline-ruled, full-width, the placeholder "Find a setting." Search filters across all sub-screen titles and known synonyms ("haptics," "vibration," "buzz" all resolve to the same row). Tap → focus → soft keyboard, no modal.

3. **Six grouped drill-down rows**, each row a left-aligned label and a right-aligned chevron, ~64px tall, separated by hairline rules in `border`. Section divisions are achieved by spacing (`spacing.2xl` between groups), not by colored headers.

   - **You** — name, email, password, biometric unlock, sign-out.
   - **How you eat** — units, meals per day, water goal, calorie display.
   - **How we reach you** — notification presets and quiet hours (drills into the redesigned `NotificationPreferencesScreen`, see [notification-preferences.md](notification-preferences.md)).
   - **How the app looks and feels** — appearance (light/dark/auto), haptics.
   - **Privacy and your data** — trust center, blocked users, data export, delete account.
   - **Help** — contact support.

4. **Below the fold, near the bottom**, a single quiet line: "Signed in as {{email}}." in `textMuted` `caption`. No button. No action. Just a confirmation of identity.

5. **Footer:** version string, build number, "Made with care." in `micro`. Center-aligned. Color `stone`. Subtle.

Every existing control still exists; none get deleted. They are simply each one step deeper. Each sub-screen has **one decision visible at a time** (per the One Decision Rule, [`02-screen-grammar.md` §1](../02-screen-grammar.md)).

### Worked example sub-screen — "How you eat"

When the user taps "How you eat," they land on a sub-screen that contains four rows, in the same drill-down pattern:

- Units → opens a sub-sub-screen with two large segmented options: "Imperial" / "Metric." Select one, `confirm` haptic fires, the change saves silently, the user backs out.
- Meals per day → opens a sub-sub-screen with a centered stepper "3" and the line "Most members find three meals plus a snack works." Increment/decrement → `tap` haptic; save → silent.
- Water goal → opens a sub-sub-screen with the stepper and the line "Sixty-four ounces is a comfortable baseline."
- Calorie display → opens a sub-sub-screen with two large segmented options.

Each sub-sub-screen is one decision. No save button, no cancel button — decisions persist on selection, and the back chevron is "Done." Premium drill-down architecture, learned from iOS Settings and reinforced by the audit's recommendation ([audit](../../audits/ux_review_report.md#L253)).

### Worked example sub-screen — "Privacy and your data"

The `Privacy and your data` sub-screen is where the screen earns trust. It contains:

- Trust Center → drills into existing `TrustCenterScreen` (4/2/4 → 3.3 in audit, preserved with no changes).
- Blocked users → drills into existing `BlockedUsersScreen`.
- Data export → drills into existing `DataExportScreen` (currently 3.3, preserved).
- Delete account → drills into existing `DeleteAccountScreen`. This row uses `semantic.danger.fg` text color only; the row chrome remains the same as every other row (no red background, no warning icon — danger is in the destination, not the doorway).

---

## Component breakdown — primitives used

| Primitive | Where it fires |
|---|---|
| `useSpring('enter')` | The six rows on initial mount, staggered 40ms |
| `useSpring('breath')` | The header period (`Settings.`) — yes, the period itself breathes |
| `useHaptic('tap')` | On any row press |
| `useHaptic('confirm')` | On any toggle/segmented-control change inside a sub-sub-screen |
| `useHaptic('success')` | On password change (the one explicit save action — see below) |
| `<CompletionMoment variant="quiet">` | On password successfully changed; on data export request submitted |
| `<CompletionMoment variant="standard">` | On account-delete confirmed (peak inappropriate; standard is the right calibration for an intentionally somber moment) |
| `<CalmError>` | All error states from the existing password/save flows |

The Stillwater Path block:

```tsx
/**
 * Stillwater Path
 * ───────────────
 * FROM:     Profile tab, Settings drawer, or deep link.
 * HERE:     Find one setting via search or drill-down rows.
 * NEXT:     One of six sub-screens — each its own single-decision flow.
 * CLOSURE:  Sub-screens close on selection (no save button); root
 *           Settings is the persistent home and itself has no closure
 *           moment beyond the breath on the header.
 *
 * Primitives: useSpring(enter, breath), useHaptic(tap), CalmError
 */
export const stillwater = {
  primaryDecision: 'Find and adjust one setting',
  primaryActionLabel: 'Find a setting', // search field; no button CTA
  expectedExit: 'navigate',
} as const;
```

Note that this screen is the rare case where the "primary action" is a search field, not a button — that's intentional and matches iOS Settings, Linear command-K, and the audit's drill-down recommendation.

---

## Copy patches — before / after

| Element | Before | After |
|---|---|---|
| Screen title | "Settings" | "Settings." |
| Section: "Account" | "Account" (as header) | "You" (as row label) |
| Section: "Nutrition Preferences" | "Nutrition Preferences" | "How you eat" |
| Section: "Notifications" | "Notifications" | "How we reach you" |
| Section: "App Preferences" | "App Preferences" | "How the app looks and feels" |
| Section: "Security" | "Security" | (merged into "You") |
| Section: "Data & Privacy" | "Data & Privacy" | "Privacy and your data" |
| Section: "Support" | "Support" | "Help" |
| Row label: "Meals Per Day" | "Meals Per Day" | "Meals per day" |
| Row label: "Water Goal (fl oz)" | "Water Goal (fl oz)" | "Water goal" |
| Row label: "Calorie Display" | "Calorie Display" | "How calories show up" |
| Row label: "Haptics enabled" | "Haptics enabled" | "Haptics" |
| Row label: "Daily Check-in" | "Daily Check-in" | "Daily check-in reminder" |
| Search placeholder | (none — no search today) | "Find a setting." |
| Bottom identity line | (signed-out button only) | "Signed in as {{email}}." |
| Sub-screen back chevron text | "Back" | "Done" |
| Password success message | `Alert.alert('Success', 'Password updated.')` | `<CompletionMoment variant="quiet" title="Password updated." />` |
| Password error | `Alert.alert('Error', err.message)` | `<CalmError title="That didn't go through." recovery={{label: 'Try again', onPress: retry}} />` |

The voice transformation is the largest deliverable here. The before-list reads like a config screen; the after-list reads like a quiet conversation about preferences.

---

## Haptic / motion spec — when does what fire

| Event | Haptic | Motion |
|---|---|---|
| Root Settings mount | none | `enter` staggered on rows; `breath` on header |
| Row tap | `tap` | 120ms opacity dip, then nav transition |
| Search field focus | none | Soft keyboard rise (native) |
| Sub-screen → sub-sub-screen tap | `tap` | nav transition |
| Toggle change | `confirm` | 200ms ink → forest tint on the toggle |
| Segmented-control select | `confirm` | `morph` on the segmented background |
| Password change submit success | `success` | `quiet` CompletionMoment |
| Password change submit error | `error` | `CalmError` inline; element shake 4px |
| Sign-out tap | `caution` | Bottom-sheet confirmation slides up (one decision: "Sign out" / "Stay") |
| Delete-account confirm | `caution` once, then `success` once delete completes | `standard` CompletionMoment with copy "Account closed. Thank you for the time you spent here." |

---

## Success criteria

We know the redesign worked when:

1. **Audit score moves from 1.7/5 to ≥3.3/5** (a "C+" → "B-" jump). Premium climbs from 2 to ≥4. CogSimple climbs from 2 to ≥4. Rewarding climbs from 1 to ≥3 (the absence of celebration in settings is appropriate; we earn the third point with `CalmError` + `CompletionMoment` on the few legitimate completion events).
2. **Time-to-find-a-setting test:** Internal users asked "change your check-in time" should complete the task in ≤4 taps from cold launch (Tab → Settings → How we reach you → Quiet hours). Current state requires ~3 taps but has 25× the noise; we trade flat-and-noisy for slightly-deeper-and-quiet.
3. **Above-the-fold count drops from ~25 simultaneous decisions to ≤7 (the six rows + the search field).** Direct test of Cognitive Budget compliance.
4. **No `Alert.alert(...)` survives in this file.** All success/error paths use Stillwater primitives.
5. **Voice audit:** zero instances of banned vocabulary; all section labels in sentence case, lifestyle voice.
6. **Drill-down feels native.** Internal qualitative read: "feels like iOS Settings, not like a fitness app's hamburger menu." If users describe the redesign as "a list of more taps," we've lost; if users describe it as "calm" or "easy to find things," we've won.

---

_End of `client-settings.md`._
