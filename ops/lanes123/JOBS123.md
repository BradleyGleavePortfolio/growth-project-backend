# JOBS123 — agent 123 wave 1 (18:35 PDT 10-05). Read /home/user/workspace/ops/lanes123/_COMMON_123.md first, then ONLY your entry.
b = growth-project-backend, m = growth-project-mobile. Heads verified by the operator 18:30 PDT. Background: tgp-agent-context
handoffs/op-122/HANDOFF.md and handoffs/op-122/ops/JOBS122.md (the entries named below); reports in /home/user/workspace/ops/reports/.
Lens comment first line, exact: `AUDIT Claude Opus 5.5 — growth-project-<repo>#<n> @ <full sha> — VERDICT: APPROVE | REQUEST CHANGES`
(or `AUDIT GPT-6.1 Sol — ...`). Every lens job below is a queue: post each verdict as soon as that PR is done, then go to the next item.
Verify the head right before posting. Freeze + ruthless scope (_COMMON_123 items 6-7) bind every verdict.

## Lens pair W1A (Opus AUD-OPUS-W1A-123, Sol AUD-SOL-W1A-123) — flags + lockout allow-list (T4). Time box 45 minutes total.
(1) MF2 = JOBS122 entry "AUD-OPUS-MF2-122 / AUD-SOL-MF2-122" word for word: b#737 f743dc73cf1571527b3059a448a576857e010d65 and m#382
    695460e76671afcc86a7827e2a0ed311269d83af. Update: the owner created the GitHub secret MWB_AUTOSAVE_LOCK_TOKEN_SECRET on
    growth-project-backend at 18:02 (the "merge only after the owner confirms the secret" condition is met). One verdict per PR. 20 min.
(2) LA1 = JOBS122 entry "AUD-OPUS-LA1-122 / AUD-SOL-LA1-122" word for word: b#725 b3caa5b18baa20ecca125efa2d51326f37dc5ee2 (delta
    1dbc59b6..b3caa5b1; report ops/reports/B-725R-122.md). One verdict. 20 min.

## Lens pair W1B (Opus AUD-OPUS-W1B-123, Sol AUD-SOL-W1B-123) — payment sheet refresh + tax CSV (T4 money). Time box 50 minutes total.
(1) SHD1 — m#342 5acdf5ca204689dfca604339be9fd1b347f3b5d8 (draft; the operator marks it ready at merge). It is ONE merge commit: parent 1
    4c79b67cbd211146abd76bd03349a4dd6e6de7c6 (the collapsed payment-sheet train #344 -> #343 -> #342, tree = the dual-APPROVED train top,
    10-04) and parent 2 mobile main 7083b7a1. Review ONLY the merge resolution: `git show --remerge-diff 5acdf5ca` (hunks 1-5; hunk 5
    planTerms weekly -> 'week' is the only line not in B-SHEET7-122's earlier resolution). Builder comment 6007311469; report
    tgp-agent-context/handoffs/op-122/ops/B-SHEET7B-122.md. Story: a client taps a recurring package, the payment sheet opens, she pays
    and gets access at the price and interval the coach set (weekly stays weekly); a client locked for non-payment still sees the lockout
    handling; a coach's package save/publish path from main (m#345 / m#321) is unchanged. Required checks green at the head. One verdict. 20 min.
(2) m#340 tax CSV — 62794564f340020b7b562911e8a531f065612576, base main. Diff vs main 6 files +645 -55 (src/lib/money/csvFile.ts + test,
    src/screens/coach/money/MoneyScreen.tsx + test, package.json + 1 lock line: expo-file-system ~56.0.8, already in main's lock). Comment
    6007482247 (MAIN REFRESH, B-340-122). Never audited at this code: Sol RC 10-03 (find it on #340) then FIX ROUND 1 (B-COACH-5) at 2e77dcb6.
    Full review of the diff vs main. Story: a coach taps "Export tax CSV" and gets a real .csv file in the share sheet (save to Files / attach
    to email); amounts are right (minor units shown as currency, fees and refunds as on the money screen), only that coach's own sales, and
    where file sharing is unavailable the CSV goes as text and the screen says so truthfully. Check main's money-screen copy and behaviour
    are unchanged apart from the export path, and that the new dependency needs nothing beyond the 10-07 store build (no config plugin
    change missing). One verdict. 30 min.

## Lens pair W1C (Opus AUD-OPUS-W1C-123, Sol AUD-SOL-W1C-123) — AI crisis routing + Roman live turns (T4 safety). Time box 45 minutes.
(1) b#736 58a31e6fb959947920e99abc0facc8b34cfdb4c0 — FIX ROUND 1 (B-AIG2-122; comment 6007481786; report ops/reports/B-AIG2-122.md).
    Delta f2dd87ad..58a31e6f (src/ai/ai-crisis-router.ts + 2 specs). Your own prior verdict: Sol 6006699712 / Opus 6006734594 (reports
    ops/reports/AUD-SOL-AIG1-122.md / AUD-OPUS-AIG1-122.md: read only your own). Check the five Bs: "I took a whole bottle of Tylenol" ->
    911; "I am going to hang myself" -> 988; "overdose on cardio", "can you overdose on creatine?", "I hurt myself deadlifting, can I train?"
    get a normal answer; controls "kill this workout", "I'm dying after leg day", "took 2 Tylenol for my headache" stay normal; the crisis
    check still runs before consent, the daily limit and the model. Builder Cs (C-736-3/4/5) stay C unless you give a normal-user story.
    One verdict. 20 min.
(2) Roman b#669 31573c83c8aeff3536db840ceaa2e0788249dfe1 (FIX ROUND 2, B-RMNC3-122; comment 6007481946) and b#670
    30f097477f1ab7ba54dec43fe048bab57972e715 (RESTACK, merge-only; comment 6007482100). Delta ef71cb9c..31573c83 (2 files, +39 -7). Prior:
    Opus APPROVE #669 6006753337, Sol RC #669 6006755911 (B-669-1: "your meals add up to 450 kcal" after breakfast 330 + lunch 450 passed
    with one meal's number instead of 780); #670 dual APPROVE at dc159eaf. Sol: B-669-1 closed for an ordinary reply, correct single-meal
    replies still pass. Opus: the delta breaks nothing in what you approved. Both: #670 is merge-only (diff dc159eaf..30f09747 == the #669
    delta). One verdict per PR. 20 min.

## Builder B-TR12-123 (Claude Opus 5.5) — trials b#671 main refresh + R75 test-cast fix (T4 money/access; lock ops/lanes123/locks/trials)
Time box 60 minutes. b#671 4315136a (base main; the whole trials train #672 -> #673 -> #706 -> #707 already landed into #671's branch, tree =
the audited TD1 top; branch agent115/trials-split-1-model-rules; grandfathered split train landed as one, A5 rule 11). Background: JOBS122
"B-TR11-122" and "AUD-*-TD1-122"; reports ops/reports/B-TR11-122.md, AUD-OPUS-TD1-122.md, AUD-SOL-TD1-122.md (TD1 verdicts on GitHub at
#671-#707). Main is now 0521b393 (dunning D1-D4, coachless, invite codes, programs, broadcasts split 1, booking options, approve-to-adjust).
Work: (1) merge origin/main into #671's branch ONCE; conflicts today: src/checkout/checkout-webhook-handler.service.ts and
src/checkout/checkout.module.ts (money: keep BOTH sides' behaviour: main's dunning/dispute handling and the trials webhook handling; nothing
dropped); also check auto-merged schema.prisma, account-deletion manifest, ci.yml, .env.example compose. (2) R75 gate is red at 4315136a
from test-only casts in test/b-trials-trial-ending-push-prefs.spec.ts and test/b-trials-4-fix-round.spec.ts: remove every new `as any` /
`as unknown as` / `as never` (typed helpers instead). (3) Migration timestamps in the train must be newer than production's latest applied
migration (main's newest is 20270318122000_coach_booking_options): if any trials migration is older, say so and rename only if `prisma
migrate deploy` would refuse or misorder it (prove with a CI lane). (4) Evidence: one backend CI lane (full tsc + trials specs + checkout
webhook specs + dunning specs) then #671 PR CI all required checks green. (5) Comment `MAIN REFRESH (B-TR12-123, agent 123) —
growth-project-backend#671 @ <sha>` listing every conflict hunk and its resolution, the cast fixes, migration order, lane + PR CI links,
ending READY FOR AUDIT; write ops/lanes123/notify/trials.txt with the head. Freeze rules: no new behaviour, no edge hardening.

## Builder B-339R-123 (Claude Opus 5.5) — m#339 refresh, then m#338 refresh (T3 copy / T4 trial setting). Time box 50 minutes.
(1) m#339 = JOBS122 entry "B-339R-122" word for word, with agent 123 / B-339R-123 in comments (head 0b0de03d, dual APPROVE VC1). Main is
    7083b7a1. (2) Then m#338 48b5e6b5434fc5db207dcb14d97e5208a3d4b16f (trial setting: coach sets a free trial of 0-30 days; dual APPROVE at
    this head; conflicts with main in src/api/packagesApi.ts and src/screens/coach/payments/CoachPackageEditScreen.tsx because main's
    m#345 / m#321 package editor landed). Merge origin/main once; keep main's editor and save/publish behaviour and the $19.99-minimum-or-
    free rule, and keep #338's trial-days field and its API field exactly as the backend trials train sends/accepts them (check b#671's
    DTO names). Both sides' tests pass. Mobile CI lane + PR CI green. Comment `MAIN REFRESH (B-339R-123, agent 123) —
    growth-project-mobile#338 @ <sha>` listing each hunk, ending READY FOR AUDIT. Write ops/lanes123/notify/m339.txt and m338.txt with heads.

## Wave 1 add-on (18:38) — lens delta AV3 on m#381 (both W1A lenses, after their W1A queue). Time box 20 minutes.
m#381 5c13f14428c9d541996287f5869a92c72834e4c4 (coach booking options editor; FIX ROUND 2 comment on #381 by operator 123). Prior: both lenses
RC at feab0c3b (Opus 6006808729, Sol 6006810212) for the same B-381-1 (a coach who saves 14+ days of minimum notice leaves every client
with "no open times in the next two weeks"; operator ruling: the editor refuses 14+ days with a plain sentence and the inputs stop under 14
days). Review feab0c3b..5c13f144: eab75ece (the fix + tests), 413974bd (clean main merge: verify CoachNavigator.tsx and SettingsScreen.tsx
compose: main's money row and #381's booking options row both present), 5c13f144 (test-only stub in main's coachSettingsMoneyRow test).
Backend b#735 (booking options API) is deployed (deploy 6, 18:33). Story: a coach opens Settings > Booking options, sets 2 days notice and a
30-day window, saves, and a client then sees bookable times; trying 14 days gets the sentence instead of a dead end. Required checks green.
Background: JOBS122 entries "AUD-OPUS-AV2-122 / AUD-SOL-AV2-122" and "M-AVAIL2-122". One verdict.

## Builder B-AIG3-123 (Claude Opus 5.5) — b#736 FIX ROUND 2 (AI guide crisis routing; T4 safety). Time box 25 minutes. (18:42)
b#736 58a31e6fb959947920e99abc0facc8b34cfdb4c0 (branch agent122/ai-guide-crisis-before-limit). Both lenses REQUEST CHANGES at this head
(Sol 6007539676, Opus 6007542496; reports ops/reports/AUD-SOL-W1C-123.md and AUD-OPUS-W1C-123.md: read both, and their saved probes in
ops/aud-123/AUD-SOL-W1C-123/ and ops/aud-123/AUD-OPUS-W1C-123/). The B-AIG2 round broke two crisis cases that worked before:
- Opus B-736-3: "I want to overdose tonight" / "I am going to overdose" (intent, first person) must get the 988 reply (it now gets the daily
  limit reply at cap). The person-reported/past-tense rule from last round must not drop stated intent.
- Opus B-736-4 = Sol B-736-3: "I cannot breathe after my workout. I need help now.", "I can't breathe during my workout. Please help me.",
  "my chest hurts and I can't breathe after my run" must get 911. Narrow the activity exclusion in src/ai/ai-crisis-router.ts (~60-61) so
  an explicit inability to breathe / help-now / chest pain report always routes to 911; keep the ordinary controls normal: "breathing
  during heavy squats", "breathe through my nose when I run", "out of breath on long runs".
Use the lenses' one-line regex suggestions where they hold. Keep every previous case (the 30 B-AIG2 cases + controls "kill this workout",
"I'm dying after leg day", "took 2 Tylenol for my headache", "overdose on cardio", "can you overdose on creatine?", "I hurt myself
deadlifting, can I train?"). Tests: add the five sentences above to test/ai.service.spec.ts (at cap -> crisis reply, no quota/model) and
the router table; each new test fails on 58a31e6f. Use the lenses' saved spec assertions. One push. Backend CI lane (both AI specs) + PR CI
green. Comment `FIX ROUND 2 (B-AIG3-123, agent 123) — growth-project-backend#736 @ <sha>` ending READY FOR AUDIT. No other changes (Cs stay).

## Lens delta RD1 (re-uses both W1C lenses) — Roman train main merge on b#667 (T4 AI/safety). Time box 20 minutes. (18:49)
b#667 af32412c87042f77ed3b62a3dbd6e7aa4263120e (base main). Operator MAIN REFRESH comment 6007638575. The Roman stack (#670 -> #669 -> #668
-> #666 -> #665) landed top-down into #667's branch (bottom 9b525546, tree = audited #670 tree b8bfedac, EQUAL); then ONE merge of main
76a59216. Review ONLY that merge (`git show --remerge-diff af32412c` + the auto-merged files both sides touched: .env.example,
src/audit/audit.service.ts, src/checkout/dunning-v2/dunning-lockout.guard.ts, src/common/env-validation.ts; and .github/workflows/ci.yml
union of two live-spec steps). Story: a client chats with Roman after launch; a locked (non-paying) client is handled by main's lockout
guard exactly as main does; Roman's env vars validate at boot with main's new vars too. Nothing dropped from either side. Required checks
green at af32412c (wait/poll up to 15 minutes; say which are still running if not done). One verdict on #667.

## Lens LS1 (re-uses both W1A lenses) — b#738 proxy-addr 2.0.8 lockfile bump (required audit check blocker). Time box 15 minutes. (18:52)
b#738 9c2343126889f2fbcb2210ca6b6511bde40e3d1f (branch op123/proxy-addr-2.0.8, base main 76a59216; operator PR). The required check "npm
audit (high+critical, whole graph)" is red on main since 74706577 because of the critical GHSA-jqcg-44mw-7w3h (proxy-addr < 2.0.8).
Check: the diff is package-lock.json only; only node_modules/proxy-addr moved 2.0.7 -> 2.0.8 with the registry's integrity (npm view
proxy-addr@2.0.8 dist.integrity); express 5.2.1's range accepts it; nothing else changed. Required checks at the exact head green
(especially "npm audit (high+critical, whole graph)", build-and-test). Poll up to 15 minutes. One verdict.

## Lens deltas MR1 + MR2 (re-use both W1B lenses) — m#339 then m#338 main refreshes. Time box 30 minutes total. (18:54)
Builder B-339R-123 (report ops/reports/B-339R-123.md) merged mobile main 7083b7a1 into both with conflict resolution (rule 12 does not
apply). Review only each merge commit (`git show --remerge-diff <head>`) plus anything main changed in the same files.
- MR1: m#339 bab905f243d47396e60a7188230986df5c37b6c3 (MAIN REFRESH 6007629011). CoachEarningsScreen.tsx stays deleted as in main;
  CoachPackageEditScreen.tsx archive message = main's code with this PR's wording. Story: a coach archives a package and sees a plain
  sentence if it fails; nothing main added to the package editor is lost.
- MR2: m#338 2d0288ca654ae18f7a071817441b73f1ccd75270 (MAIN REFRESH 6007681845). Main's editor, save/publish flow and $19.99-or-free rule
  kept; the PR's trial_days input + its 3 server error codes restored (must equal b#671's backend fields; b#671 is being refreshed by
  B-TR12-123, read its head on GitHub); a typed trial counts as unsaved so "Make live" waits for a save; 5 tests adjusted (check none was
  weakened). Story: a coach adds a 7-day trial to a package, saves, makes it live; a buyer preview shows the trial. Note m#338 merges only
  after the backend trials train is deployed (operator gate) — do not block on that, review the code.
Required checks green at each exact head. One verdict per PR.

## Lens delta RD2 (W1C lenses) — b#667 test-only fix + lockfile merge. Time box 15 minutes. (19:03)
b#667 c5c86cb46bfe3f6ea425e255536a9ae091686580, operator FIX ROUND 1 comment on #667. Review ec12f3a9 (test only: R75 casts replaced by
typed builders; stale Roman PII-log exception removed — check no test was weakened, the PII scan still runs with the same strictness) and
confirm c5c86cb4 is a clean main merge that changes only package-lock.json (proxy-addr 2.0.8 from b#738). Required checks at the exact head
must be green (poll up to 15 minutes; all 11 incl. npm audit, R75, build-and-test). One verdict. Then b#736 FIX ROUND 2 when it is posted.

## Lens delta AIG3 (W1C lenses) — b#736 FIX ROUND 2 (T4 safety). Time box 20 minutes. (19:07)
b#736 384314a88d2a29ed198358f9e8ea60c4ccbaea8d. Review 58a31e6f..78ce5db8 (builder B-AIG3-123, comment 6007796311, report
ops/reports/B-AIG3-123.md); 384314a8 is a clean main merge (operator MERGE-ONLY TREE CHECK; rule 12). Your own B-736-3 / B-736-4 (Opus) and
B-736-3 (Sol) must be closed: "I want to overdose tonight", "I am going to overdose" -> 988 at the daily limit; "I cannot breathe after my
workout. I need help now.", "I can't breathe during my workout. Please help me.", "my chest hurts and I can't breathe after my run" -> 911.
Controls stay normal ("breathe through my nose when I run", "out of breath on long runs", "breathing during heavy squats", "overdose on
cardio/carbs", "can you overdose on creatine?", "kill this workout", "I'm dying after leg day", "took 2 Tylenol for my headache"). Rerun
your saved probes. The builder notes "I can't breathe after my run" alone now gets 911 (as at f2dd87ad): acceptable (errs to safety) unless
it breaks a control above. Required checks green at 384314a8 (poll up to 15 minutes). One verdict.

## Lens delta TR13 (re-use both W1B lenses) — trials train b#671 main refresh (T3 money). Time box 25 minutes. (19:15)
b#671 fca4018be43d57805c5c06c5a18c359800a1a22b (base main; the whole trials train #671-#673/#706/#707 folded into it, last dual APPROVE at
6bf110fb). Builder B-TR12-123 (report ops/reports/B-TR12-123.md, comment 6007958655): push 1 2a6dfd98 = merge of main 0521b393 with three
resolved hunks (checkout.module.ts imports; applyInvoicePaid: main's dispute-pause rule + trials naming, trials return after main's
dunning step) + rename of the trials `listOpenInvoices` -> `listOpenInvoicePage` (2 callers, 1 mock; both sides had added a method with
that name) + R75 typed helpers in test/b-trials-trial-ending-push-prefs.spec.ts and test/b-trials-4-fix-round.spec.ts; push 2 fca4018b =
clean merge of main d5177b31. Review only these (`git show --remerge-diff` on both merges, the rename, the two test files). Story: a coach
offers a 7-day trial; a client starts it, is not charged until day 8, gets the trial-ending push; a client whose card fails after the trial
goes into main's dunning flow exactly as main does, and a disputed invoice still pauses as on main. Migrations: the two trials migrations
are older than main's newest; confirm `prisma migrate deploy` applies them (builder lane proved order). Required checks green. One verdict.

## Scout FLAGS-D1-123 (Claude Opus 5.5, READ-ONLY) — day-1 flag matrix before the 10-07 Expo build. Time box 35 minutes. (19:26)
Why: day 1 (SoT A6.1, owner 10-05) = launch path + push notifications + community (coachless sign-up and featured coach, invite codes,
broadcasts, unified inbox/messaging) + Roman day-1 upgrades (live chat, approve-to-adjust, "your conversations", daily-cap pop-up) + all
scheduling. Mobile EXPO_PUBLIC_FF_* flags are baked in at build time, so any day-1 mobile flag must be in eas.json's production profile
(and clinic where SoT says) BEFORE the Wednesday 10-07 build; backend flags go through .github/... fly env desired-state manifest (Fly Env
Sync) and can flip any time but must be on before the build reaches users.
Do (read-only; no pushes, no PRs, no comments):
1. For every day-1 feature above: the backend flag(s) (FEATURE_*, read in src/), state in production (manifest on backend main
   e6f9a5ec + the latest Fly Env Sync plan log, run 37400579222), the mobile flag(s) (EXPO_PUBLIC_FF_* or server-driven capability) and
   their eas.json production/clinic values on mobile main, and whether ALL code is merged on both mains (cite PR numbers).
2. Known gates: Opus C-337 (raising sets shows a negative "% less volume" on the coach suggestion card; fix before FEATURE_ROMAN_ADJUST_ENABLED);
   SoT says confirm the Anthropic key is present in production for Roman (names only via the env plan; never print values); community
   flags need FEATURE_COMMUNITY_API=true first (env-sync precondition); SoT line "EXPO_PUBLIC_FF_ROMAN_CHAT stays off in the clinic
   profile"; FEATURE_DUNNING_V2 is off (launch step 4 "done, flag off") — report what turning it on needs, do not recommend unless SoT says.
   Find any other gate in SoT Part C1 / A2 / A8.9 for these flags (grep the flag names in tgp-agent-context/TGP_SOURCE_OF_TRUTH.md).
3. Output /home/user/workspace/ops/reports/FLAGS-D1-123.md: a table (feature | backend flag(s) now -> proposed | mobile flag(s) now ->
   proposed | code merged? (PRs) | gate/blocker | owner decision needed?), then the exact proposed diffs for (a) the backend manifest and
   (b) mobile eas.json (production + clinic), keeping every flag whose feature is not fully merged OFF. Plain words. End with ## HANDOFF.
Use bash with api_credentials=["github"]; clones at /home/user/workspace/growth-project-{backend,mobile} (git fetch only; read with git show
origin/main:<path>; never change their checkout). gh api for GitHub reads; never `gh run view` / `gh pr checks`.

# WAVE 2 (19:50) — day-1 flags + missing day-1 mobile screens. Read ops/reports/FLAGS-D1-123.md first (the matrix every job uses).
Operator rulings for this wave (owner day-1 scope A6.1 + C1 10-01 11:32 "all of that ... live on day 1", 10-02 16:34 "Live free-form
Roman chat in v1.0: yes", 10-05 09:57 Roman flags "flip after the stacks land and pass", 10-05 09:46 annex "ALL DAY 1 NECESSARY"): Roman
chat ON in production AND clinic profiles; community core ON incl. the Community tab/Hall/cohorts in the production binary (voice notes,
DM and other extras stay off); messaging v2 ON; approve-to-adjust ON only after the C-337 fix is merged; dunning v2 NOT in these PRs.
Every PR: Conventional Commits title, tier header in the body, under 1,500 changed lines, no new `as any` / `as unknown as` / `as never`,
no empty `.catch(() => undefined)`, plain-words copy (no "we/our/us" voice), tests that fail before the change where code changes.
Push once per PR (fix rounds later). Post `FIX ROUND 1 (OPENING, <JOB>, agent 123) — growth-project-<repo>#<n> @ <full sha>` ending
READY FOR AUDIT when PR CI is green. Write ops/lanes123/notify/<JOB>.txt with PR numbers + heads. Never merge, never deploy, never run
Fly workflows. Deps: /home/user/workspace/deps/{backend,mobile} (READY) via ops/link_deps.sh; heavy work via ops/heavy.sh; CI lanes via
ops/ci-lane/ci_lane.sh. Report ops/reports/<JOB>.md ending with ## HANDOFF.

## B-FLAGS-123 (Claude Opus 5.5) — three small PRs from FLAGS-D1-123. Time box 45 minutes.
1. Backend (T4) branch agent123/day1-flags, title "chore(flags): day-1 community core, messaging v2 and Roman chat on": exactly diff
   (a) items 1-5 of ops/reports/FLAGS-D1-123.md (manifest flags + excluded line removed + gates text + env-validation.ts closed sets for
   FEATURE_ROMAN_CHAT_ENABLED / FEATURE_ROMAN_ADJUST_ENABLED + regenerated docs/runbooks/launch-flags.md). FEATURE_ROMAN_ADJUST_ENABLED
   stays "unset" here. Run test/ci/fly-env-manifest.spec.ts and the env-validation specs. Body says b#650 is superseded by it.
2. Mobile (T3) branch agent123/day1-flags, title "chore(flags): Roman chat and community on in the store builds": eas.json production
   adds EXPO_PUBLIC_FF_ROMAN_CHAT, EXPO_PUBLIC_FF_COMMUNITY_TAB, EXPO_PUBLIC_FF_COMMUNITY_HALL, EXPO_PUBLIC_FF_COMMUNITY_COHORTS = "true";
   clinic adds EXPO_PUBLIC_FF_ROMAN_CHAT = "true". Run scripts/__tests__/expectedEnv.test.js and any eas.json test.
3. Mobile (T3) branch agent123/c337-volume-copy, title "fix(roman): say more volume when an adjustment raises sets": Opus C-337 in
   src/components/roman/adjust/romanAdjustCopy.ts changeSummary (diff in the report) + tests for a cut, a raise and no change; check
   every other caller/string that formats volume_pct the same way.

## B-AIG4-123 (Claude Opus 5.5) — C-736-8 AI guide crisis gaps (T4 safety). Time box 30 minutes.
Story: a client types "I want to take all my pills" or "I'm going to OD" to the AI guide and must get the 988 reply (both lenses left it
C-736-8 on b#736; with live Roman and the AI guide both on day 1 the operator promotes it). In src/ai/ai-crisis-router.ts (main e6f9a5ec)
route intent to take all/many pills/meds, "going to OD"/"gonna OD"/"want to OD" to 988; keep controls normal ("take my pills with
food?", "I took all my vitamins", "OD on carbs", "overdose on cardio", "can you overdose on creatine?"). Then check Roman's
src/roman/guardrails/safety-router.ts for the same sentences: if Roman misses them, fix it in the same PR (same rule). Tests at cap
(crisis reply, no quota/model) for each new sentence; each fails on main. One backend PR, branch agent123/crisis-pills-od, title
"fix(ai): route stated intent to take all my pills or OD to 988".

## M-INV-123 (Claude Opus 5.5) — mobile coach Codes screen on /coach/codes (T3/T4 linking). Time box 80 minutes.
Spec: SoT entry "M-INV-120" + ops/reports/B-INV2-120.md "Mobile gaps" + B-INV4-122.md; backend contract on main (src/coach-codes or
wherever b#658 put it; FEATURE_COACH_CODE_TOOLS gates it, 404 coach_code_tools_disabled when off -> hide the screen/row). Build: api
client (Idempotency-Key UUID on create, reused on retry; expected_code on rotate; grace picker), Codes screen (list, create, rotate,
revoke, share as text + QR using a library that works in Expo managed builds — prefer react-native-qrcode-svg on react-native-svg;
justify any new dependency), today's signup count per code with unusual_today, truthful day-one pairing errors per code state
(src/screens/day-one/api.ts + CoachPairingScreen.tsx + src/lib/inviteAttachOutcome.ts: revoked/expired/used-up get their own sentence).
Keep the legacy InviteCodesScreen working where the server flag is off. Split into two PRs if over 1,500 lines (api + day-one errors,
then the screen). Story: a coach whose code leaked revokes it, makes a new one, shares the QR; a client with the old code sees "This code
was turned off by your coach" instead of "not recognized".

## M-COACHLESS-123 (Claude Opus 5.5) — mobile coachless Home + featured coach + scripted Roman card (T3/T4). Time box 80 minutes.
Spec: ops/reports/B-SPLIT-COACHLESS-121.md "Mobile" section (file paths, routes, every error code), SoT 4352-4362 (owner words for the
banner and the Roman pitch: "Sir/Ma'am, just so your aware, TGP's top coach has available slots. Enter code GP-XXXX and join for
$49/mo. Interested?" -> fix only the spelling "you're"; the code and price come from the server offer), backend src/coachless/* on main.
Build: 'coachless_home' in SERVER_FEATURE_FLAG_KEYS (src/api/featureFlagsApi.ts) gating everything; client Home banner for a client with
no coach; code sheet (POST /coachless/coach-code/check live validation, /redeem with an Idempotency-Key UUID reused on retry), welcome
moment from the redeem response, hand-off to the existing Day 1 checkout with next.featured_package / packages_available; scripted Roman
card on Home (POST /coachless/roman-card/seen and /not-now; shown only while the server says the featured coach accepts clients); copy for
every refusal code. No owner admin screen. Split if over 1,500 lines. Story: a person signs up without a code, sees the banner, enters
GP-XXXX, is attached to the coach and lands on checkout for the featured package.

## M-BCAST-123 (Claude Opus 5.5) — mobile coach broadcasts composer (T3/T4 member content). Time box 80 minutes.
Spec: ops/reports/B-SPLIT-BCAST-121.md (mobile gaps) + backend src/broadcasts/* (b#726-#730 on main; FEATURE_COACH_BROADCASTS gates,
404 when off -> hide the entry). Build the core a coach needs on day 1: broadcasts list (sent / scheduled / recurring), composer (text,
pick a segment: all clients / tag / package as the API offers, send now or schedule, recurring rule if the API supports it), cancel a
scheduled one, saved replies picker if cheap. Clients receive broadcasts in their normal coach thread (check how the backend delivers;
if it needs a client-side render for a card type, include it). Split if over 1,500 lines (api + list, then composer). Story: a coach
sends "Gym closed Monday, do the home plan" to all clients now and schedules a weekly Sunday check-in; clients see it in their thread.

## Lens pair W2A (Claude Opus 5.5 + GPT-6.1 Sol) — day-1 flags + C-337 (+ AIG4 when posted). Time box 40 minutes. (20:01)
Background: ops/reports/FLAGS-D1-123.md (matrix + operator rulings in the "# WAVE 2" preamble above) and ops/reports/B-FLAGS-123.md.
1. FL1 b#740 7e3ff31b1b28758a5ebaa6081e6ca090742fb6b3 (T4): manifest sets FEATURE_COMMUNITY_API/_POSTS/_MESSAGES/_PUSH/_REALTIME,
   FEATURE_MESSAGING_CORE_V2, FEATURE_ROMAN_CHAT_ENABLED true; FEATURE_ROMAN_ADJUST_ENABLED unset; closed value sets in env-validation.ts;
   regenerated runbook. Check: every flag set true is read by merged + deployed code (production = e6f9a5ec, deploy 7); the env-sync
   preconditions pass (community surface flags need FEATURE_COMMUNITY_API); kill path = unset works; nothing else turned on (voice notes,
   DM, coachless, code tools, broadcasts, dunning stay off); FEATURE_ROMAN_CHAT_ENABLED with box-2 consent enforced (FEATURE_AI_CONSENT_
   LEDGER_ENABLED=true). Story: after env sync, a client opens Community and posts, chats with Roman (consent asked first), and messages
   her coach in the new inbox; a coach can switch any of these off with one unset.
2. FL2 m#383 d2845013b2a8f279606a8886ff45e25ad7064da8 (T3): eas.json production + clinic flags exactly as the preamble rules; config/
   expected-env.json consistent; no other profile changed. Story: the 10-07 store build shows Roman chat and the Community tab.
3. FL3 m#384 341216276547a1ead980a91f302768c554028237 (T3): C-337 "more volume" copy + tests; any other place formatting volume_pct.
4. AIG4 (b#7xx from builder B-AIG4-123, when its FIX ROUND 1 (OPENING) comment is posted; check ops/lanes123/notify/B-AIG4-123.txt):
   "I want to take all my pills" / "I'm going to OD" -> 988 on the AI guide and Roman; controls normal; tests fail on main.
Required checks green at each exact head. One verdict per PR.

## Lens pair W2B (Claude Opus 5.5 + GPT-6.1 Sol) — new day-1 mobile screens (T4/T3). Time box 45 minutes per PR, queue in order. (20:13)
Each PR is server-gated (its backend flag is OFF in production and stays off until this review + an owner device pass), so the question is:
is it correct and safe when the flag turns on, and invisible while it is off? Backend contracts are on backend main e6f9a5ec (deployed).
1. CL1 m#386 0a1bc0bd7d18348742184a2e5dcac1a1c961748d (M-COACHLESS-123; report ops/reports/M-COACHLESS-123.md; opening comment
   6008505792): coachless Home banner, code sheet (/coachless/coach-code/check + /redeem with Idempotency-Key), welcome, hand-off to the
   Day 1 plan sheet, scripted Roman card (/coachless/roman-card/seen, /not-now), refusal copy, gated by server flag coachless_home.
   Story: a person who signed up without a code sees the banner, enters GP-XXXX, joins the featured coach and picks a plan; with the
   flag off nothing shows. Spec: the entry "M-COACHLESS-123" above + ops/reports/B-SPLIT-COACHLESS-121.md. The builder's deviation (a code
   that already includes a plan never goes to pay) — judge it.
2. INV1 (M-INV-123's PR(s), when ops/lanes123/notify/M-INV-123.txt exists): coach Codes screen + truthful day-one errors. Spec: entry
   "M-INV-123" above.
3. BC1 (M-BCAST-123's PR(s), when ops/lanes123/notify/M-BCAST-123.txt exists): broadcasts list + composer. Spec: entry "M-BCAST-123".
Required checks green at each exact head. One verdict per PR. If a builder's PR is not posted when you reach it, wait up to 15 minutes
polling the notify file, then finish your report and say which were not reviewed.

## Lens FL4 (W2A lenses) — b#741 Roman approve-to-adjust flag on (T4). Time box 15 minutes. (20:12)
b#741 00f9b8b693f409c73104dd17cde043db1b9781fc (operator PR): FEATURE_ROMAN_ADJUST_ENABLED "unset" -> "true" + gate text. Check: b#655
code deployed (production e6f9a5ec), m#337 + m#384 (C-337 fix) merged on mobile main ad05c23c; closed value set from b#740 present;
kill = unset hides the card (404); runbook table unchanged and the manifest spec passes. Required checks green at the exact head (poll up
to 15 minutes). One verdict.

## Lens pair W2C (Claude Opus 5.5 + GPT-6.1 Sol) — takes BC1 from W2B. Time box 45 minutes. (20:25)
BC1 m#388 6ad27c87592fcfca38c7d145643c8deed1fb163f (M-BCAST-123; report ops/reports/M-BCAST-123.md; opening comment 6008675359):
coach broadcasts list + composer behind server flag FEATURE_COACH_BROADCASTS (button hidden while off). Spec: entry "M-BCAST-123" above;
backend src/broadcasts/* on backend main (deployed). Builder pushed twice before the opening comment (accepted: no audit had started).
Story: a coach sends "Gym closed Monday, do the home plan" to all clients now and schedules a weekly Sunday check-in; clients see each in
their coach thread; with the flag off nothing shows; opening Broadcasts never strands the coach without a way back to the client list.
Required checks green at the exact head. One verdict. (W2B lenses: skip BC1.)

## FIX ROUND 2 on m#386 (M-COACHLESS-123, same builder) — two Bs. Time box 30 minutes. (20:29)
m#386 0a1bc0bd. Both lenses REQUEST CHANGES (Sol 6008549315, Opus 6008571221; reports ops/reports/AUD-SOL-W2B-123.md and AUD-OPUS-W2B-123.md):
- Sol B-386-1: after redeeming a code that includes a free/prepaid plan, the screen shows active access but the shared entitlement gate is
  never refreshed, so Workout stays blocked until the app is backgrounded/reopened. Fix: refresh entitlement (the same refresh the app
  uses after checkout) on a successful redeem; integrated regression test (redeem -> Workout unlocked without a restart).
- Opus B-386-1: on iOS "Choose a plan" opens the Stripe plan sheet, which iOS builds hide everywhere else (only the labelled
  "1:1 coaching with <coach>" purchase screen is allowed; EXPO_PUBLIC_FF_IOS_HIDE_NON_P2P_PURCHASES). Fix: on iOS route to that labelled
  screen; Android keeps the sheet. Test both platforms.
One push. PR CI green. Comment `FIX ROUND 2 (M-COACHLESS-123, agent 123) — growth-project-mobile#386 @ <sha>` ending READY FOR AUDIT.
Cs stay. Then notify file update.

## Re-audit CL1 m#386 FIX ROUND 2 (W2B lenses). Time box 20 minutes (delta). (20:45)
m#386 64c5bde0f20f3a39d76961e7eb9838dc515fa2d3 (was 0a1bc0bd); FIX ROUND 2 comment 6008806111. Check only the delta: B-386-SOL-1
(successful redeem refreshes the shared entitlement gate; integrated test fails without the fix) and B-386-OPUS-1 (iOS "Choose a plan"
-> "1:1 coaching with <coach>" screen; Android keeps the sheet; tests both). No new Bs outside the freeze. Required checks green at the
exact head. One verdict.
