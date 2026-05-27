# The Stillwater Standard

_A UX/UI manifesto for The Growth Project mobile + platform-site product. Spec only. The working name "Stillwater" is provisional — leave it in place so the user can react._

---

## Vision

The Stillwater Standard is what comes after "decacorn-grade." It is the explicit decision that **our coaching product feels less like a gym and more like a lifestyle**: calm, premium, mindful, de-loading, habit-rewarding. The aesthetic ancestors are Apple's iOS de-load doctrine, Phantom's CALM framing for high-stakes moments, Headspace/Calm's quiet voice, and Hermès-style digital restraint — not Whoop, not Gymshark, not "Crush Your Day." Every screen exists to reduce the felt weight of the next action, not to amplify it. We win not by being more energetic than the bro-gym category, but by being the only product in the category that lets users **exhale**. The design becomes the moat. The product compounds because users come back to a feeling they can't get anywhere else ([Mobile Doc §1.1 real edge in design](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L17-L51), [Mobile Doc §1.2 visceral/behavioral/reflective](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L52-L129), [Mobile Doc §6.1 feeling is function](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1714-L1740), [tokens.ts palette](../repos/growth-project-mobile/src/theme/tokens.ts#L30-L62)).

---

## The Seven Principles

### 1. Premium is what you take AWAY, not add

A decacorn ships features. Stillwater ships subtraction. Every screen ships with a removal log: what came off this surface to make the remaining elements feel chosen rather than crowded. The client `HomeScreen` is the canonical reference — it explicitly removed streak banner, calorie ring, macro bar, day selector, community win, trust cue row, identity badge, milestone tiles, weekly volume card, habits section, and quick-access grid ([HomeScreen.tsx header comment](../repos/growth-project-mobile/src/screens/client/HomeScreen.tsx#L1-L14)) and is the strongest surface in the audit at 4.3/5 ([audit row HomeScreen](audits/ux_review_report.md#L77)). Generous whitespace is the most powerful signal of premium value, ahead of typography and ahead of color ([Website Doc §3.1 white space](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L235-L277)).

### 2. Every completion is a peak moment

A confirmation that resolves to static text is an emotional vacuum — and we have too many of them ([Mobile Doc §5.5 anti-pattern 4](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1679-L1685), [audit cross-cutting "reward is weakest dimension"](audits/ux_review_report.md#L278)). Every meaningful completion in Stillwater fires a `CompletionMoment` with proportional intensity: quiet for routine saves, standard for daily wins, peak for the rare exceptional outcome. The peak case must be visibly distinct from the ordinary case — that distinction is what makes ordinary feel ordinary and exceptional feel exceptional ([Mobile Doc §3.5 variable reward magnitude](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L896-L918)). No confetti. No starbursts. The peak is a slow color sweep, a held haptic, a single line of personal copy.

### 3. The screen breathes between actions

Idle is not the absence of motion. Idle is a slow, organic micro-pulse — what Phantom does with the ghost mascot's gentle bob and Duolingo does with the owl's breath ([Mobile Doc §2.2 Phantom ghost bob](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L363-L370)). Every primary surface in Stillwater carries a `breath` motion token: a 4-second sinusoidal opacity or scale of ~1.5% on its primary element. The user reads "the product is here with me, calmly," not "the product is broken and frozen."

### 4. Decisions are sequenced, not stacked

We never display two primary choices simultaneously. Coach AI draft editors today violate this ([audit AIMealPlanDraftScreen 1.7/5](audits/ux_review_report.md#L110)) by exposing nested editable weeks/days/exercises plus Approve, Reject, and Save in the same field of view. Stillwater follows the `apply/page.tsx` standard (4.7/5, the highest-scoring surface in the audit at [audit apply/page.tsx](audits/ux_review_report.md#L225)) — one question at a time, visible progress, final review, explicit closure ([Website Doc §7.3 form protocol](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L971-L1009), [Mobile Doc §4.5 progressive disclosure](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1237-L1300)).

### 5. Haptics replace explanation

When the user does the right thing, the phone confirms it before our copy does. A successful save is a `success` haptic + 300ms ink-to-forest tint sweep on the affected element; we delete the green checkmark toast that said "Saved." Animation and haptic together absorb the explanation that text used to carry, and the screen stays calmer ([Mobile Doc §5.1 emotional confirmation](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1487-L1492), [Website Doc §7.1 micro-interactions](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L876-L932)). Polish *is* the trust signal in high-stakes domains ([Mobile Doc §2.2 Phantom polish-as-trust](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L391-L407)).

### 6. Identity, not gamification

Badge theater measures engagement with the app. Competence feedback measures skill growth in the actual domain ([Mobile Doc §3.7 badge theater vs competence](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L973-L992)). Stillwater never says "30-day streak unlocked" with a glittering badge. Stillwater says "You've shown up for 30 of the last 31 mornings — that's the version of you that sticks." We frame progress as identity development, not point accumulation. Streaks ship with forgiveness ([Mobile Doc §3.4 streak trap](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L821-L873)); leaderboards either go local-and-winnable or get removed entirely ([Mobile Doc §3.2 Strava local model](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L730-L776)). The current `LeaderboardSettingsScreen` at 1.7/5 ([audit](audits/ux_review_report.md#L79)) is a candidate for deletion, not redesign.

### 7. Lifestyle voice, not coach voice

Read aloud, our copy sounds like Calm or Headspace, never like a hype clip on Instagram Reels. We don't say "Crush your workout." We say "Today's movement, when you're ready." We don't say "Time to dominate." We say "Open when you're back." The voice is **un-urgent on purpose**, because urgency in a wellness product is a stress signal masquerading as motivation. The system stays quiet so the user can hear themselves.

---

## Tone of Voice — 10 Do / Don't Pairs

These are concrete copy patches. The "before" column is what we currently say or what a generic decacorn would say. The "after" column is Stillwater.

| # | Don't say (bro-gym / generic) | Do say (Stillwater) |
|---|---|---|
| 1 | "Crush your workout!" | "Today's movement, when you're ready." |
| 2 | "🔥 You're on fire! 7-day streak unlocked!" | "Seven mornings in a row. That's the version of you that sticks." |
| 3 | "Time to dominate your goals." | "Open when you're back." |
| 4 | "Don't break your streak!" (loss aversion) | "Yesterday counted. Today's still open." (present-tense pull) |
| 5 | "Workout complete! +50 XP!" | "Done. Saved. Rest a moment." |
| 6 | "Error: Failed to save. Please try again." | "That didn't go through. Mind retrying?" |
| 7 | "Your meal plan is ready! Tap to view!" | "Your week is drafted. Read when there's a quiet minute." |
| 8 | "PROCESSING PAYMENT…" | "Holding for one second while your bank confirms." |
| 9 | "Welcome back, champion!" | "Welcome back." |
| 10 | "You smashed it today! 100% complete!" | "All three closed. Today's done." |

The pattern: lowercase by default, declarative, second-person but reserved, never exclamation points except in dialogue from another human (a coach message, a referral). Numbers prefer to be written ("seven mornings") when they evoke and as digits ("$129") when they price. Verbs are concrete ("open," "rest," "saved") not aspirational ("dominate," "transform," "unleash"). This voice is grounded in Phantom's "warm, flowing feedback" language model ([Mobile Doc §2.2 interaction language](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L382-L390)) and in the website doctrine's headline-as-emotional-architecture guidance ([Website Doc §4.2](../Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md#L466-L511)).

---

## Anti-Patterns — Things Stillwater Will Never Ship

These are explicit prohibitions. CI/lint should enforce the ones that can be enforced; the rest are review-gate items.

1. **Red banner alerts for non-emergencies.** Red is reserved for true destruction risk (delete account, cancel paid plan, lose unsaved work). A network retry is not red. A non-blocking permission is not red. Sentry warnings inside the product UI are not red. We have an `error: #B91C1C` token and a `warning` triad; default to warning unless the action is genuinely irreversible ([tokens semantic.warning/danger](../repos/growth-project-mobile/src/theme/tokens.ts#L98-L109)).
2. **Leaderboards-as-shame.** Global rankings against arbitrary peers. If competition isn't local and winnable, it's not in the product ([Mobile Doc §3.2 Strava local](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L730-L776)).
3. **Confetti, starbursts, fireworks.** Visual hype that decacorn fitness apps use to mask thin reward design. Replace with a held haptic, a slow color sweep, and a single line of voice.
4. **Exclamation point CTAs.** "Save!" "Continue!" "Get Started!" — none ship. CTAs are calm verbs in title case: "Save," "Continue," "Get started."
5. **Gradient buttons.** Our radius is 0 for primary CTAs ([tokens radius.sm = 0](../repos/growth-project-mobile/src/theme/tokens.ts#L232)); fills are solid ink or forest, never gradient. Gradients on buttons read as 2014-era fitness apps.
6. **Multiple primary buttons on one screen.** The rubric flags this; CI should fail a screen with more than one `variant="primary"` button visible at once ([audit Top-20 fix #20](audits/ux_review_report.md#L308)).
7. **Permission-front onboarding.** No notification, location, or contacts prompt before the user has experienced value ([Mobile Doc §5.5 anti-pattern 1](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1657-L1663)).
8. **Generic "Something went wrong."** Every error is an opportunity to demonstrate competence — name what happened in plain language, name the recovery action ([Mobile Doc §2.2 Phantom error treatment](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L498-L502)).
9. **Empty confirmations.** Major achievements that resolve to static text. Banned by Anti-Pattern 4 of the mobile doctrine ([Mobile Doc §5.5](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1679-L1685)).
10. **Feature dumps.** First-session screens that show all product capabilities at once. Features get introduced at the moment they become relevant ([Mobile Doc §5.5 anti-pattern 2](../Mobile-App-Design-Intelligence-Exhaustive-Agent-Training-1.md#L1665-L1670)).
11. **Spinners over 800ms.** Spinners are reserved for sub-second waits. Anything longer is a skeleton + slow reveal ([audit Top-20 fix #16](audits/ux_review_report.md#L304)).
12. **Hardcoded hex outside tokens.** No `#2D6A4F`, no Tailwind amber-500. Token cleanup is a standing CI requirement ([audit Top-20 fix #9](audits/ux_review_report.md#L297), [tokens.ts source-of-truth comment](../repos/growth-project-mobile/src/theme/tokens.ts#L1-L6)).
13. **Card-on-card.** Two surfaces of `bgSurface` stacked inside one another. Use spacing and hairline rules instead.
14. **Radius greater than 4 on primary surfaces.** Tokens cap radius at `lg: 4` for cards; `xl` and `2xl` are remapped to 4 for back-compat ([tokens radius scale](../repos/growth-project-mobile/src/theme/tokens.ts#L231-L240)).
15. **"Crush," "smash," "destroy," "beast mode," "let's go," "you got this," 💪 emoji.** Vocabulary blacklist. CI lint can catch the literal strings.
16. **Modal-on-modal.** Maximum modal depth is 1. A bottom sheet inside a modal inside another modal is banned by the Cognitive Budget rule (see `02-screen-grammar.md`).

These prohibitions are not aesthetic preferences. Each one is a specific failure mode the audit or the doctrine has documented — they would, if shipped, cost us premium perception faster than any single feature would earn it back.

---

_End of `00-stillwater-standard.md`. See `01-tactile-primitives.md` for the haptic, motion, and `CompletionMoment` contracts that operationalize Principle 2 and Principle 5._
