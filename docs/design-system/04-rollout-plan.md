# 04 — Rollout Plan

_Sequencing the Stillwater Standard from spec to shipped product. Tier 1 / Tier 2 / Tier 3, with effort sizing (S/M/L), dependency map, and journey-aligned sequencing rationale. Spec only._

---

## Sizing legend

- **S** — Small. ≤2 engineering days, ≤1 design day. No new external dependencies.
- **M** — Medium. 3–8 engineering days. Touches multiple screens or introduces a shared primitive.
- **L** — Large. 2–4 weeks. Multi-screen redesign or platform-level shift.

All sizes are in single-engineer/single-designer days and assume the implementation subagent has full repo context.

---

## Tier 1 — Ship now (low effort, high impact)

These are the items the audit calls out as ≥10× return on hours invested. They unblock everything else by introducing the primitives that the redesigns reference.

| # | Deliverable | Effort | Why first |
|---|---|---|---|
| T1.1 | **Ship `CompletionMoment` primitive** with all three variants (`quiet` / `standard` / `peak`), incl. reduced-motion fallback and `completion_moment_shown` analytics. | M | Every other Tier 1/2 item references it. Audit Top-20 fix #1 ([audit](../audits/ux_review_report.md#L289)). |
| T1.2 | **Ship `useHaptic()` hook** with the six named patterns (`tap`/`confirm`/`success`/`peak`/`caution`/`error`). Wraps the existing `mediumTap`/`warningTap`/`successTap` ([referenced from SettingsScreen](../repos/growth-project-mobile/src/screens/client/SettingsScreen.tsx#L25)). | S | Pure consolidation of an existing pattern under a typed API. |
| T1.3 | **Ship `useSpring()` preset hook** with `enter` / `exit` / `morph` / `peak` / `breath`. Maps onto existing motion tokens, no new tokens added ([tokens motion](../repos/growth-project-mobile/src/theme/tokens.ts#L270-L286)). | M | The five motion presets used everywhere downstream. |
| T1.4 | **Ship `<QuietSkeleton>` standardization.** Audit existing skeleton usage; standardize the pulse timing to 1600ms; ensure stagger on reveal. Existing component lives at [Skeleton.tsx](../repos/growth-project-mobile/src/ui/skeletons/Skeleton.tsx). | S | Audit Top-20 fix #16 ([audit](../audits/ux_review_report.md#L304)). |
| T1.5 | **Ship `<CalmError>` primitive** and migrate the top 10 `Alert.alert('Error', …)` call sites identified by grep. | M | Audit Top-20 fix #13 ([audit](../audits/ux_review_report.md#L301)). |
| T1.6 | **HomeScreen polish** — add `breath` to CTA, `enter` staggered cascade, first-tap-of-day quiet CompletionMoment. Spec at [client-homescreen.md](03-redesign-specs/client-homescreen.md). | S | Highest-traffic surface in the app; the simplest demonstration of the primitives stack. Already 4.3/5 — pushing it to 5 also gives the team a visible template for what "Stillwater-polished" feels like. |
| T1.7 | **Homepage hero reduction** on `tgp-platform-site/app/page.tsx`. Cut above-fold to one headline, one two-line subhead, one primary CTA, one trust anchor, one visual. Audit Top-20 fix #10 ([audit](../audits/ux_review_report.md#L298)). | S | Pure copy + JSX reduction, no new primitives needed. |
| T1.8 | **Banned-vocabulary lint** — CI rule that fails build on user-visible strings containing "crush," "smash," "destroy," "beast mode," "let's go," "you got this." | S | Cheap; prevents regression while other Tier 1 ships. |
| T1.9 | **Token-discipline lint** — CI rule that fails on hardcoded `#[0-9a-f]{6}` outside `tokens.ts`; flags numeric padding/margin ≥4 outside `spacing.*`. Audit Top-20 fix #9 ([audit](../audits/ux_review_report.md#L297)). | S | Same reason. |
| T1.10 | **Stillwater meta export lint** — CI rule that every screen file exports a `stillwater` const ([`02-screen-grammar.md` §1](02-screen-grammar.md)). Initially soft-warn; flips to hard-fail at end of Tier 2. | S | Makes Tier 2/3 redesigns enforceable. |

**Tier 1 total:** ~15 engineering days, 5 design days. All ten items can ship inside one sprint with one designer + two engineers.

**What Tier 1 buys us:** Every primitive and every guardrail. After Tier 1, no new screen can regress, and every Tier 2/3 redesign is a composition of primitives that already exist and have been used in production.

---

## Tier 2 — Next sprint

These are the highest-leverage redesigns from `03-redesign-specs/`, plus the supporting work to make them safe to ship.

| # | Deliverable | Effort | Why second |
|---|---|---|---|
| T2.1 | **Notification Preferences redesign** (both copies) — consolidate to one shared component; ship the 3-preset surface + Advanced disclosure. Spec at [notification-preferences.md](03-redesign-specs/notification-preferences.md). | M | High user-touch (every user configures these once), low novel primitive load. Also closes the duplicate-screen liability ([audit](../audits/ux_review_report.md#L214)). |
| T2.2 | **Branded Checkout choreography** — pre-load trust checklist, webview skeleton, peak success moment, error-class-keyed `<CalmError>`. Spec at [branded-checkout-webview.md](03-redesign-specs/branded-checkout-webview.md). | M | Highest-stakes single screen; highest revenue leverage. Tier 2 because it depends on `CompletionMoment` (T1.1), `useHaptic` (T1.2), `useSpring` (T1.3), `QuietSkeleton` (T1.4), and `CalmError` (T1.5) all being live. |
| T2.3 | **Client Settings redesign** — six grouped drill-down rows + search + per-sub-screen single decision. Spec at [client-settings.md](03-redesign-specs/client-settings.md). | L | Largest surface area (792 lines → multiple smaller files). High user-touch but lower revenue leverage than checkout. Worth doing second because the drill-down pattern from this work becomes the template for `coach/SettingsScreen.tsx` and `client/PreferencesScreen.tsx`. |
| T2.4 | **Coach AI Meal Plan Draft redesign** — three-screen summary-first approval flow. Spec at [coach-ai-mealplan-draft.md](03-redesign-specs/coach-ai-mealplan-draft.md). | L | The single biggest coach-side experience improvement. Tier 2 not Tier 1 because the value lands on coaches not clients, and the audit shows client-side is closer to ship-quality than coach-side ([audit cross-cutting](../audits/ux_review_report.md#L277)). Pairs naturally with T2.5. |
| T2.5 | **Coach AI Workout Draft redesign** — apply the same three-screen pattern from T2.4 to `coach/AIWorkoutDraftScreen.tsx` (1.7/5, [audit](../audits/ux_review_report.md#L111)). | M | Direct template application; the design work is done in T2.4, only the data model differs (day/exercise/set vs day/meal/item). |
| T2.6 | **Migrate the worst 5 remaining `Alert.alert` clusters** — coach settings, client edit profile, package edit, bulk invite, leaderboard settings. Each gets `<CalmError>` / `<CompletionMoment>` replacements. | M | Continues the Tier 1 migration; closes the most visible "this is a 2015 React Native app" tells. |
| T2.7 | **Auth flow sequencing** — split `CreateAccountScreen` (currently 2.3, "invite/identity/credential/phone/SSO all on one screen" per [audit](../audits/ux_review_report.md#L49)) into a 3-step sequence using the LeanQ pattern. Audit Top-20 fix #4 ([audit](../audits/ux_review_report.md#L292)). | M | First-session impression is disproportionate; this matches Mobile Doc §5.2 onboarding sequence ([Mobile Doc §5.2](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1500-L1545)). |
| T2.8 | **Empty-state migration to `<NextPrompt>`** — sweep the top 15 empty states across client + coach surfaces. | M | Audit Top-20 fix #14 ([audit](../audits/ux_review_report.md#L302)). |

**Tier 2 total:** ~6 weeks, 1 designer + 2 engineers.

---

## Tier 3 — Quarter

The remaining redesigns from the Top-20 fixes list, plus the cross-cutting cleanup that turns the standard from "applied to specific surfaces" into "applied to the whole product."

| # | Deliverable | Effort | Why third |
|---|---|---|---|
| T3.1 | **Coach Settings drill-down redesign** — apply the T2.3 template to `coach/SettingsScreen.tsx` (1.7/5). | M | Direct template; smaller surface than client settings. |
| T3.2 | **Client Edit Profile redesign** — section-cards with inline-edit pattern, replacing the flat 30-field form (2.0/5, [audit](../audits/ux_review_report.md#L70)). Audit Top-20 fix #8 ([audit](../audits/ux_review_report.md#L257)). | M | High-friction but low-frequency; users hit it ≤3x. |
| T3.3 | **Coach package + billing redesigns** — `CoachPackageEditScreen` (2.0/5), `CoachPackagesScreen` (2.0/5), `CoachBillingScreen` (2.3/5). Apply wizard / grouped-drill-down pattern. Audit Top-20 fix #5 ([audit](../audits/ux_review_report.md#L293)). | L | Coach-side admin density; lower user-touch frequency justifies later position. |
| T3.4 | **Risk Board + Earnings tactile data viz** — animate rings/bars/counters, scrub feedback, ordinary-vs-exceptional differentiation. Audit Top-20 fix #8 ([audit](../audits/ux_review_report.md#L296)). | L | Coach-side data surfaces; introduces new motion primitives for charts that aren't covered in `01-tactile-primitives.md`. Spec extension would happen as part of this work. |
| T3.5 | **Coach Invite + Bulk-Invite wizard** — `CoachInvitesScreen` (2.0/5) and `BulkInviteScreen` (2.0/5) become a 4-step send flow. Audit Top-20 fix #17 ([audit](../audits/ux_review_report.md#L305)). | M | Coach-side ops surface; low user-touch. |
| T3.6 | **Trust + Data Export + Delete Account choreography** — apply Phantom CALM framing across the three trust-sensitive screens. Audit Top-20 fix #18 ([audit](../audits/ux_review_report.md#L306)). | M | High-stakes but low-frequency; can wait until the primitives are battle-tested. |
| T3.7 | **Coach Home + Risk Board "one thought" rule** — apply the HomeScreen pattern to coach dashboards. Audit Top-20 fix #7 ([audit](../audits/ux_review_report.md#L295)). | L | Touches multiple coach surfaces; depends on T1.6 having been long enough in production that the pattern is settled. |
| T3.8 | **Share Card extension** — generalize `ShareCardScreen` (4.0/5, [audit](../audits/ux_review_report.md#L217)) as a closure template for post-workout, post-check-in, post-streak. Audit Top-20 fix #15 ([audit](../audits/ux_review_report.md#L303)). | M | Earns Reward dimension across many surfaces with one shared component. |
| T3.9 | **Onboarding + Day 1 peak polish** — apply `<CompletionMoment variant="peak">` to `OnboardingResults`, `Day1WinScreen`, `ReadyScreen`. All already 4.0+ on the audit; the polish takes them to 4.7+. | S | Pure primitives invocation; low risk; ships when there's spare capacity. |
| T3.10 | **Stillwater Path block backfill** — every existing screen gets its FROM/HERE/NEXT/CLOSURE header. Soft-required at end of Tier 2 (T1.10); hard-required end of Tier 3. | M | Long-tail cleanup; can be parallelized as a "10 screens per engineer per week" sweep. |

**Tier 3 total:** ~10 weeks, 1 designer + 2 engineers, can be parallelized across multiple feature initiatives.

---

## Sequencing rationale — journey-aligned

The tiers are not arbitrary; they follow the user journey:

1. **Onboarding → Home → Daily loop** ships first (Tier 1 + early Tier 2). The audit shows the client-side, new-user-side already scores best ([audit cross-cutting](../audits/ux_review_report.md#L277)); we lift it from "very good" to "decacorn+" first because it carries the strongest brand-perception leverage and the lowest implementation risk (the surfaces are simpler).

2. **Daily transactions (checkout, notifications)** ship second (mid Tier 2). These are the moments where the user's emotional state crosses a threshold — committing money, configuring their relationship with the app. They benefit most from polish-as-trust ([Mobile Doc §2.2](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L391-L407)) and they have the highest revenue + retention leverage per redesigned screen.

3. **Coach-side flows** ship third (late Tier 2 + early Tier 3). The audit confirms coach surfaces lag client surfaces ([audit cross-cutting](../audits/ux_review_report.md#L277)). Coach satisfaction matters but on a slower cycle — a coach who tolerates a clunky AI draft editor today will not churn tomorrow over it, but a client confronted with a clunky checkout will.

4. **Settings, admin, edge cases** ship last (Tier 3). These are necessary-but-rare surfaces; their audit scores are low but the user-touch frequency is also low, so the per-user-impact of each fix is lower than the journey-critical surfaces.

The fundamental sequencing principle: **ship the redesign that the largest number of users will see, most often, first.** This is the website doctrine's hero-first principle applied to mobile prioritization ([Website Doc §4.1](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L425-L464)).

---

## Dependency map

Which deliverables block which.

```
T1.1 CompletionMoment ──┬─→ T1.6 HomeScreen polish
                        ├─→ T2.1 Notification Preferences
                        ├─→ T2.2 Branded Checkout
                        ├─→ T2.3 Client Settings (for password/export success states)
                        ├─→ T2.4 Coach AI Meal Plan
                        ├─→ T2.5 Coach AI Workout
                        └─→ T3.8 Share Card extension

T1.2 useHaptic ─────────┴─→ (consumed by everything that fires a haptic — all redesigns)

T1.3 useSpring ─────────┬─→ T1.6 HomeScreen polish
                        ├─→ T2.1 Notification Preferences (morph)
                        ├─→ T2.2 Branded Checkout (enter, exit, peak, breath)
                        ├─→ T2.4 Coach AI Meal Plan (enter, morph, peak)
                        └─→ T3.4 Risk Board + Earnings (introduces new chart motions)

T1.4 QuietSkeleton ─────┬─→ T2.2 Branded Checkout (pre-load skeleton)
                        ├─→ T2.4 Coach AI Meal Plan (load skeleton)
                        └─→ T2.8 Empty-state migration

T1.5 CalmError ─────────┬─→ T2.1 Notification Preferences
                        ├─→ T2.2 Branded Checkout (error-class-keyed)
                        ├─→ T2.3 Client Settings (password change errors)
                        ├─→ T2.4 Coach AI Meal Plan (load/save/approve errors)
                        ├─→ T2.6 Worst-5 Alert.alert migration
                        └─→ T3.6 Trust/Export/Delete

T1.8 Banned-vocab lint ─→ Prevents regression on all subsequent copy work.
T1.9 Token-discipline lint ─→ Prevents regression on all subsequent visual work.
T1.10 Stillwater meta lint ─→ Enforces 02-screen-grammar.md compliance on all subsequent new screens.

T2.3 Client Settings drill-down pattern ─→ T3.1 Coach Settings drill-down
T2.4 Coach AI Meal Plan summary-first ──→ T2.5 Coach AI Workout summary-first
T1.6 HomeScreen polish ───────────────────→ T3.7 Coach Home + Risk Board "one thought"
T3.8 Share Card extension ────────────────→ post-workout/post-checkin/post-streak closure
```

**The critical path** is Tier 1 → T2.2 (Checkout) and Tier 1 → T2.4 (AI Meal Plan). Everything else can parallelize once Tier 1 lands.

---

## Risk + mitigation

- **Risk: the peak motion preset feels cheesy in production.** Mitigation: ship `peak` first on HomeScreen first-tap-of-day at variant `quiet`, then on checkout success (Tier 2). Two real-world calibrations before we trust the preset for the AI Meal Plan approval moment (highest-stakes use).
- **Risk: the breath motion at 1.5% scale is visually imperceptible on small phones.** Mitigation: A/B test breath amplitude (1.5% vs 2.5%) on HomeScreen during Tier 1. Lock the winner before Tier 2.
- **Risk: drill-down settings adds taps and feels slower.** Mitigation: implement search field (T2.3) before drill-down rows fully ship. Most users will find settings via search, not via row taps.
- **Risk: the three-screen AI draft flow doubles time-to-approve.** Mitigation: instrument time-to-approve before and after. If it doubles, flatten the flow by collapsing Screen B and Screen C into one slide-stack.

---

_End of `04-rollout-plan.md`._
