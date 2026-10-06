# JOBS122 — agent 122 (backend lane). Read _COMMON_122.md first, then ONLY your entry.
Heads verified by the operator on GitHub at 15:12 PDT 10-05. b = growth-project-backend. Backend main cb986a4c (deploy 4 done 15:0x;
production = cb986a4c). Up-to-date requirement is OFF on main. Reports from earlier agents: /home/user/workspace/ops/reports/.

## Wave 1 (15:1x PDT)

### B-DUNR3-122 — dunning train: main merge, restack, move D3-D5 onto D2d, fix Opus B-689-5 (T4 money/access; stack lock: dunning)
Builder: Claude Opus 5.5. Time box 75 minutes (READY by about 16:35 PDT). Take lock ops/lanes122/locks/dunning.
Train (lands as one, A5 rule 11), current heads:
- D1 #687 d86b31a67e1d89352c3e92dde674cb4d45a25a1a, base main, DIRTY vs main cb986a4c: one conflict in
  src/notifications/emitters/coach-alert.emitter.ts (prisma/schema.prisma, .env.example, test/privacy/no-pii-in-logs.spec.ts auto-merge).
- D2a #688 2662d01a82c267f00af27566e3984d58fb0996d1 (base #687), D2b #704 764af2e1df66612c503427016f83c3d1776cfdc0 (base #688),
  D2c #705 2a03d7dd1d39e2553df10f4d7e10ecdb025807aa (base #704), D2d #724 e77a8d360f7a7ad02cf465b525eeed648a3a7825 (base #705).
- D3 #689 bb992fedf0095446f916f3261742bd262c3d94da (base = #688's branch agent115/dunning-split-2-dunning-service at an OLD head from
  10-04), D4 #690 06307883100ec142aa2818fc30ee276cab26c1ec (base #689), D5 #691 e0afe6780e5954b20e88cfaefd63f12cd31d218d (base #690,
  tests). `git merge-tree` of #724 into #689 is clean at these heads.
Background: ops/reports/B-DUND2D-121.md (D2d design, HANDOFF), B-DUNR2-120.md, B-DUNMR-120.md, AUD-OPUS-D6-120.md,
AUD-SOL-D6-120.md; SoT A9.2 "B-DUNB-120" (rulings: D3 adopts main's Stripe method signatures; the dispute-pause check runs whether or not
FEATURE_DUNNING_V2 is on; D2c does not set `disputed` when it pauses; dispute event time is closedAt in D4).
Work, in order (one push per PR):
1. #687: `git merge origin/main` once; resolve coach-alert.emitter.ts keeping main's behaviour (push alerts go through the push sender
   from b#692 only, no second sender) plus #687's additions; list every resolved hunk in the comment. Verify migrations of the whole
   train sort and apply after main's (main added scheduling 20270222000000, push 20270307000000, messaging and coach-payout migrations;
   production applied all of them at 14:5x and 15:0x): no timestamp collision, the foundation-fixes migration-order test and Schema
   parity pass, `prisma migrate deploy` applies the train's migrations on top of main's (Migration Dry-Run check on #687 proves it).
2. Merge-only restack #688 <- new #687, #704 <- #688, #705 <- #704, #724 <- #705 (one merge commit each, tree == `git merge-tree`
   result, no content edits; if a merge conflicts, resolve and list the hunk).
3. Move D3-D5 onto D2d: merge the new #724 head into #689's branch; fix only what breaks (compile, tests) and apply the rulings above
   where #689/#690 still differ; then `gh pr edit 689 --base agent121/dunning-split-2d-restart-fixes`; restack #690 <- #689 and
   #691 <- #690.
4. Fix Opus B-689-5 (comment 5982575687), the only open item-list B on D3-D5: the disputed amount the client sees (quote
   disputes[].amount_cents, the card-result quote, and the card-result copy "Your bank reversed an earlier payment of $X") must come from
   the dispute ledger (ChargeDispute amount_cents/currency) or be omitted when unknown; never DunningState.last_failed_amount_cents.
   Failing-before test (Opus probe P3, run 37220145001). #689 has 87 lines of room: if the test does not fit, put it in #691 (258 room).
5. Do NOT fix (operator reclassified to "C (edge, deferred to 10k clients)" under the owner freeze, comments posted by the operator):
   Sol B-689-1, B-689-4, B-689-5, B-689-6 (5982476834); Sol B-690-1, B-690-2, B-690-5, B-690-6, B-690-7 (5982476848). Opus C-689-3,
   C-689-4, C-D2D-1/2/3 stay C. Keep the four already-built edge fixes in #724 (operator accepts B-DUND2D-121 decision 1, default keep).
6. Evidence: one CI lane (ci/B-DUNR3-122-1) at the new #691 head with `.ci-lane-tsc` plus every dunning/billing/dispute spec the train
   touches (test/dunning*, client-billing, checkout-webhook-handler, refund-dispute-handler, foundation-fixes, lockout guard) and the
   B-689-5 test. #687's own PR CI (all 11 required checks) must be green. Pieces' own CI is not required (A5 rule 11).
7. Comments, each ending READY FOR AUDIT and stating exactly what changed since the previous head (merge-only tree proof, or hunks/lines):
   FIX ROUND 5 (B-DUNR3-122, agent 122) on #687; RESTACK on #688, #704, #705, #724; FIX ROUND 3 on #689; RESTACK on #690; RESTACK (or
   FIX ROUND if the test lands there) on #691. Then write ops/lanes122/notify/dunning.txt with the eight new full heads and the lane run.
Size: check every PR before pushing (caps in _COMMON_122 item 5).

### AUD-OPUS-DUN1-122 / AUD-SOL-DUN1-122 — dunning train + #725, one pass under RUTHLESS SCOPE (T4; lands as one)
Lens: Claude Opus 5.5 (AUD-OPUS) and GPT-6.1 Sol (AUD-SOL), independent. Time box: 75 minutes including the wait for the builder.
Part 1 now: b#725 1dbc59b690119f03f010e406f9f1e0e43d1e6556 (base main, 117 lines: a client locked out by billing can still reach their
own coach's message thread, B-353-10). Builder report ops/reports/B-DUND2D-121.md. CI re-running (operator 15:1x): do not block on
queued checks; say which are green. Post your verdict on #725 first.
Part 2 now: read the dunning train for item-list problems only (money charged/refunded/reversed wrong, access wrongly kept or ended,
client- or coach-facing copy that is false, private or payment data to the wrong person, a core pay/cancel/card-update flow that
dead-ends). Content to read: D1-D2d at #724 e77a8d360f7a7ad02cf465b525eeed648a3a7825 (stack #687 -> #688 -> #704 -> #705 -> #724) and
D3-D5 at #691 e0afe6780e5954b20e88cfaefd63f12cd31d218d. Builder B-DUNR3-122 is merging main into #687 (one conflict:
coach-alert.emitter.ts), restacking everything, moving D3-D5 onto #724 and fixing Opus B-689-5 (disputed amount shown to the client).
Prior verdicts: verify only your own lens's earlier open Bs. Opus: #687 RC at f3c7fd37 (6000205361; FR4 6000627026 claims the fix),
#705 RC at 5138947c (6000206086; fixes in #705 2a03d7dd + #724), #689 RC (5982575687, B-689-5), #690 APPROVE (5982575812). Sol: #687
APPROVE at f3c7fd37 (5999796451), #688 and #704 APPROVE at 21714f7b / 49d0b66e, #705 RC (5999840529), #689 RC (5982476834), #690 RC
(5982476848). Operator reclassified to C (edge, deferred to 10k clients): Sol B-689-1/4/5/6 and B-690-1/2/5/6/7; B-DUND2D-121's four
built edge fixes stay. Background: ops/reports/B-DUND2D-121.md, B-DUNR2-120.md, B-DUNMR-120.md, your lens's AUD-*-D6-120.md.
Part 3: poll ops/lanes122/notify/dunning.txt and the PR comments every 5 minutes for the builder's READY FOR AUDIT. Then check each
piece's delta (main-merge conflict hunk on #687; merge-only restacks by tree equality; #689's move onto #724 and the B-689-5 fix) and post
ONE verdict per PR at the new exact heads: #687, #688, #704, #705, #724, #689, #690, #691. If the builder is not READY by 16:45 PDT, post
nothing on the train, put your findings in your report with ## HANDOFF and end.

### AUD-OPUS-TR10-122 / AUD-SOL-TR10-122 — trials train delta since the last verdicts (T4 money/access; lands as one)
Lens: Claude Opus 5.5 and GPT-6.1 Sol, independent. Time box 45 minutes.
Heads (restacked onto main 5da537d6 by B-TR9-121, READY 13:53; main is now cb986a4c, up-to-date is OFF, #671 merges clean):
#671 565893b5c969fdc937d03f3a5b947bcb8d100b11 (base main), #672 193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7, #673
91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5 (2,996/3,000), #706 87aaf126036bc7604dceb3ab55f0ddf255519950 (tests), #707
2bb4b368f39d8a380a48086c6c79d21cb4cc34b9. Last verdicts: #671 dual APPROVE at c75002c9 (Sol 5977306032, Opus 5977434502); #672 dual
APPROVE at 62c2c066 (Opus 5984213235, Sol 5984411900); #673 dual APPROVE at dcf095b8 (Opus 5984958541, Sol 5985426913); #706 dual
APPROVE at 3d95f96e; #707 RC both at ffed434e (Sol 5985426719, Opus 5985519108).
Review only the delta since your lens's last verdict head on each piece: the main refresh (#671: ci.yml, 2 hunks), the 3 conflict hunks
in #673 src/checkout/checkout-webhook-handler.service.ts, #673 FIX ROUND 12 (B-TR8-120: ONE SHARED TRIAL RULE: one trial per client per
coach, any kind; claimed in the webhook at trial start; only the winning purchase gets the marker; a losing purchase gets no access and
owes a cancellation), #707 FIX ROUND 2 (B-TR7-120) against your own #707 Bs, and the #706 tests. Reports: ops/reports/B-TR9-121.md,
B-TR8-120.md, B-TR7-120.md. Item-list problems only (a client charged when they should not be, a second free trial, a trial that grants
or keeps access wrongly, false trial copy, a checkout dead end). CI was re-run by the operator at 15:1x: do not block on queued checks;
say which are green. One verdict per PR at the exact head (5 comments).

## Owner change 15:15 PDT: agent 122 runs ALONE over both repos (agent 123 starts after 122). Mobile jobs below.
m = growth-project-mobile (github.com/BradleyGleavePortfolio/growth-project-mobile; local clone /home/user/workspace/growth-project-mobile;
shared deps /home/user/workspace/deps/mobile with READY file; link with `ops/link_deps.sh mobile <worktree>`; mobile CI lane:
`ops/ci-lane/ci_lane.sh mobile <worktree> <ci/...> <spec...>`). Mobile main 203e80e3. Heads verified 15:45 PDT.

### B-WIZ3-122 — coach wizard W2 m#346 fix + W3 m#347 known items, restack the money train m#348-#351 (T3/T4: publishes priced offers)
Builder: Claude Opus 5.5. Time box 60 minutes (READY by about 17:00 PDT). Lock ops/lanes122/locks/wizard.
Stack: m#345 ed29833c (base main, dual APPROVE: Sol 5998775552, Opus 5999046073) -> #346 26cf23b7987c866615ab9a4b2f95a10e6e318f40
(Opus APPROVE 5999046333; Sol RC 5998775024) -> #347 8437fb94aa031b906e26f33f734097d9af2f9bc5 (Sol APPROVE 5998774888; Opus APPROVE
5999046635 covered the restack delta only, NOT W3's own diff) -> money train #348 90501f847e03cf4cc1071503436acdd459643103 (conflicts with
its base #347) -> #349 35aa8163 -> #350 6fb21216 -> #351 352d768e (full shas via `git -C /home/user/workspace/growth-project-mobile
rev-parse pm348` etc.; #349/#350 are red by design until #351; land as one).
Work: read SoT A9.2 "B-WIZ3-120" word for word (it is your plan) with this operator scoping under RUTHLESS SCOPE:
1. #346: B-346-3 + Opus C-346-7 together, minimal: Create/Publish stays disabled until the saved package has loaded, and any hydration
   that changes the price or offer type clears a pending confirmation, so a publish is always a fresh tap on exactly the price and offer
   the coach sees. No other hardening. Failing-before test (Sol W2 lane run 37341467340 has the 2 challenges). #346 has 127 lines of
   room; tests that do not fit go to #347.
2. #347 (W3 own content): fix only item-list problems from the W12-119 / W12D-120 reports (ops/reports/AUD-*-W12-119.md,
   AUD-*-W12D-120.md): first-person copy around line ~343, the missing `isLive` handling if it lets a coach publish or price wrongly.
3. Restack: #347 <- #346, then #348 <- #347 (resolve the conflict once; list every hunk), #349 <- #348, #350 <- #349, #351 <- #350
   merge-only (one merge commit each, tree == merge-tree).
4. Evidence: one mobile CI lane at the new #351 head with the wizard + money specs and typecheck; PR CI on #345's chain as GitHub runs it.
5. Comments ending READY FOR AUDIT, each stating exactly what changed since the previous head: FIX ROUND 3 (B-WIZ3-122, agent 122) on
   #346; FIX ROUND (or RESTACK if no content change) on #347; RESTACK on #348 (with the conflict hunks), #349, #350, #351. Write
   ops/lanes122/notify/wizard.txt with all new full heads.

### AUD-OPUS-MON1-122 / AUD-SOL-MON1-122 — coach money screens m#348-#351, first full review (T4: payouts, earnings, money copy)
Lens: Claude Opus 5.5 and GPT-6.1 Sol, independent. Time box 60 minutes including the wait for the restack.
Current heads: #348 90501f847e03cf4cc1071503436acdd459643103 (N1), #349 35aa8163, #350 6fb21216, #351 352d768e (full shas: `git -C
/home/user/workspace/growth-project-mobile rev-parse pm349` etc.). Split of the closed m#332, sitting on the wizard (#345 -> #346 -> #347);
#349/#350 are red by design until #351; the train lands as one (A5 rule 11). Never reviewed at these heads (READY by operator 116,
5975773999). Backend they call (coach payouts, refunds/reversals, earnings) is deployed: b#674/#676/#677/#703 in production since 14:56.
Item-list problems only: money shown wrong to the coach (earnings, fees, payouts, refunds), a payout or Stripe Connect flow that dead-ends,
another coach's or client's data shown, false money copy, App Store problems. Read now at these heads. Builder B-WIZ3-122 is restacking
#348-#351 onto a fixed #347 (with one conflict in #348): poll ops/lanes122/notify/wizard.txt and the PR comments every 5 minutes; when it
posts READY, check the delta (merge-only trees; #348's conflict hunks) and post ONE verdict per PR at the NEW exact heads (4 comments). If
the restack is not READY by 17:15 PDT, post at the current heads and say so.

### AUD-OPUS-WL4-122 / AUD-SOL-WL4-122 — wizard delta m#346/#347 + lockout delta m#352-#354 (T4) (launch when a slot frees)
Lens: Claude Opus 5.5 and GPT-6.1 Sol, independent. Time box 50 minutes.
Part 1 lockout (now): m#352 da686cea, #353 78ed4e07, #354 be5c74b1 (full shas: rev-parse pm352 etc.; FIX ROUND 3 by B-LOCK3-121: false
"bank reversed" copy fixed; report ops/reports/B-LOCK3-121.md). Prior: Sol L3 #352 RC 6001848621, #353 RC 6001849106, #354 APPROVE; Opus
L3 RC #352/#353 (reports ops/reports/AUD-*-L3-121.md). Verify only your own lens's prior Bs and the changed lines. Operator rulings:
B-352-3 (native payment sheet race) is C (edge, deferred to 10k clients) (SoT A8.9); B-353-10 (locked client reaches own coach thread)
is fixed on the backend by b#725 (under review in DUN1). One verdict per PR at the exact head.
Part 2 wizard (after B-WIZ3-122 posts READY; poll ops/lanes122/notify/wizard.txt): #346 delta (B-346-3 / C-346-7 fix only) and #347
(Opus: first full review of W3's own diff, 30 minutes; Sol: delta since your APPROVE at 8437fb94). One verdict per PR at the new heads.

## Wave 2 (owner 15:43 PDT: "Scale up now to 10-12 agents"; space out builder pushes: GitHub runs 20 jobs at once; cancel superseded runs)

### B-TR11-122 — trials train: Sol B-673-3 fix + main refresh with the push-preferences move (T4 money/access; stack lock: trials)
Builder: Claude Opus 5.5. Time box 60 minutes (READY by about 16:50 PDT). Lock ops/lanes122/locks/trials.
Heads: b#671 565893b5c969fdc937d03f3a5b947bcb8d100b11 (base main) -> #672 193c6f9ac3f57a10b8ff87fa3874ee0f190dd9b7 (2,959/3,000) -> #673
91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5 (2,996/3,000: no room) -> #706 87aaf126036bc7604dceb3ab55f0ddf255519950 (tests) -> #707
2bb4b368f39d8a380a48086c6c79d21cb4cc34b9 (1,249/1,500). Verdicts at these heads: Opus APPROVE all five (6004664932, 6004665581, 6004666466,
6004667126, 6004667898); Sol APPROVE #671/#672/#706/#707, REQUEST CHANGES #673 (6004661734, B-673-3). Read both reports:
ops/reports/AUD-SOL-TR10-122.md and AUD-OPUS-TR10-122.md (lens rounds are posted; you may read both).
Work, in order (one push per PR; space your pushes at least 2 minutes apart):
1. Main refresh (Opus C-672-L1, binding): main 5cde6253 merges clean into #671 but the train conflicts in
   src/notifications/notifications.service.ts because main's push train (b#692) moved the notification preference mapping to
   src/notifications/push/push-preferences.ts. Merge origin/main into #671 (clean), then merge the new #671 into #672 and resolve:
   `trial_ending` must be mapped in push/push-preferences.ts exactly like main's other kinds, so the notice three days before the first
   charge is sent (a test that proves the trial_ending notice is delivered with main's push sender). List every hunk. Restack #673, #706,
   #707 merge-only (resolve and list any hunk if one conflicts).
2. B-673-3 (Sol, operator ruling: B, false customer-facing claim in an ordinary sequence): a client opens package A's free-trial checkout,
   dismisses it without saving a card, then opens package B from the same coach: the offer for B must match what B's checkout actually
   does. Preferred behaviour: dismissing A without a card does not use up the one trial: B's checkout retires A's unstarted open trial
   attempt (Opus C-673-11 says an abandoned attempt is retired before the next checkout: verify whether that happens for a DIFFERENT
   package of the same coach) and B gets the trial the offer showed. If that cannot be done safely and small, the offer must instead say
   the trial is unavailable/in progress with a working next action. Same-package resume and already-started trials unchanged. Code goes in
   #707 (top slice; #673 has no room); Sol's proposed 12-line test is in ops/aud-122/AUD-SOL-TR10-122/B-673-3-normal-offer-mismatch.diff.
3. Evidence: one backend CI lane at the new #707 head (tsc + trials specs + the new tests). #671's PR CI (all required checks) green.
4. Comments ending READY FOR AUDIT stating exactly what changed: MAIN REFRESH on #671 (merge-only proof), FIX ROUND (B-TR11-122, agent 122)
   on #672 (conflict hunks + push-preferences line), RESTACK on #673/#706, FIX ROUND on #707 (B-673-3). Write
   ops/lanes122/notify/trials.txt with the five new full heads. Cancel superseded runs of your own branches after each push.

### B-DUNFIX-122 — dunning fix round, standing by (T4; stack lock: dunning, taken only when B-DUNR3-122 has released it)
Builder: Claude Opus 5.5. Time box: until 18:15 PDT. Standing by costs nothing: poll every 5 minutes (sleep between polls), do not read
code in depth until there is work.
Trigger: the AUD-OPUS-DUN1-122 / AUD-SOL-DUN1-122 lenses post verdicts on the dunning train (b#687, #688, #704, #705, #724, #689, #690,
#691) and b#725 after B-DUNR3-122's restack (watch PR comments and ops/lanes122/notify/dunning.txt; the lenses' reports
ops/reports/AUD-*-DUN1-122.md). While waiting, read only ops/reports/B-DUNR3-122.md, B-DUND2D-121.md and the notify file.
When any verdict is REQUEST CHANGES with item-list Bs: wait until ops/lanes122/locks/dunning is released by B-DUNR3-122 (or the operator
tells you it is yours), take the lock, and fix every B in the piece that owns the code (b#725 is base main and separate). Then restack
upward merge-only, one push per PR, pushes at least 2 minutes apart, cancel superseded runs. Failing-before test per B. One CI lane at
the top head (tsc + dunning specs). Comments: FIX ROUND n (B-DUNFIX-122, agent 122) on fixed pieces, RESTACK on the others, each ending
READY FOR AUDIT. Write ops/lanes122/notify/dunning-fix.txt with all new full heads. A B that is an edge case under _COMMON_122 item 6:
list it for the operator instead of fixing. If both lenses APPROVE everything, end with "no fix round needed".

### AUD-OPUS-RCH1-122 / AUD-SOL-RCH1-122 — Roman chats mobile m#372-#376, first full review (T4: AI chat history, account binding, deletion)
Lens: Claude Opus 5.5 and GPT-6.1 Sol, independent. Time box 45 minutes.
Heads: m#372 61141c05c6fe5281a7a4c61370e3240163409f9e (base main; session fence + account binding for the shared API client, 1,456),
#373 70c24e710b9c5dddc49d87e0ea3e9e84298c9a26 (history + delete API), #374 0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a (state, copy, erase
tracker), #375 a10123f222013416edff450b15bd1bd34952dd90 (list screen), #376 6fabb1f989a985bf187552c2c8ad0f93d5486d4a (transcript screen,
entry points). Split of m#331 by B-SPLIT-ROMANCHATS-121 (report ops/reports/B-SPLIT-ROMANCHATS-121.md; prior #331 verdicts: Sol BLOCK at
c621770f and 5b58a121, Opus RC at c621770f: verify only your own lens's prior Bs). Binding: Roman chats are kept until the client deletes
them or the account; coaches never see client chat text; notes survive chat deletion; flag EXPO_PUBLIC_FF_ROMAN_CHAT unchanged. Item-list
problems only: one user's chats shown to another account (sign-out/sign-in on the same phone is NORMAL use), delete that does not delete,
false copy, a dead end. CI was cancelled in the outage and re-run by the operator: do not block on queued checks. Lands as one train.
One verdict per PR at the exact head (5 comments).

### AUD-OPUS-CL1-122 / AUD-SOL-CL1-122 — coachless backend b#721-#723, first full review (T4: auth, coach-code redemption, RLS) (queued)
Lens: Claude Opus 5.5 and GPT-6.1 Sol, independent. Time box 45 minutes.
Heads: b#721 d90b4842 (schema, migration, RLS live suite, erasure; base main, DIRTY vs main), #722 c219d2f3 (flag, errors, featured coach,
coachless Home + Roman card services), #723 e3368cc3 (idempotent coach-code redemption, routes, module) — full shas via gh. Split of b#657
by B-SPLIT-COACHLESS-121 (report ops/reports/B-SPLIT-COACHLESS-121.md). Item-list problems only (a client attached to the wrong coach,
a code that grants access it should not, private data across tenants, RLS gap reachable by a user, a signup dead end). #721 conflicts with
main: judge content; the operator schedules the conflict refresh. One verdict per PR at the exact head.

### B-RCH2-122 — Roman chats fix round (T4; stack lock: romanchats) (queued: launches when AUD-OPUS-RCH1-122 has posted)
Builder: Claude Opus 5.5. Time box 45 minutes.
Heads: m#372 61141c05c6fe5281a7a4c61370e3240163409f9e (base main) -> #373 70c24e710b9c5dddc49d87e0ea3e9e84298c9a26 -> #374
0ae9013fe06cbd1d5f1dbaf6ad6072f72f92358a -> #375 a10123f222013416edff450b15bd1bd34952dd90 -> #376 6fabb1f989a985bf187552c2c8ad0f93d5486d4a.
Verdicts: Sol APPROVE #372-#375, REQUEST CHANGES #376 (6004856689) B-376-1: a client deletes the chat that is open in the live Roman
screen from the history list, goes back, still sees the erased text, and the next message goes to the erased session id and fails. Fix:
when a confirmed delete erases the session the live screen holds, the live screen drops that session (clears the transcript, starts a
fresh session on the next send). Sol's three sequential counterexamples: probe run 37384807869 (evidence ops/aud-122/AUD-SOL-RCH1-122/).
Plus every item-list B in the Opus RCH1 verdicts (ops/reports/AUD-OPUS-RCH1-122.md once posted). Fix each B in the piece that owns the code,
failing-before test per B, restack upward merge-only, one push per PR, at least 2 minutes apart, cancel superseded runs. Mobile CI lane at
the top head (tsc + the Roman chats tests). Comments: FIX ROUND (B-RCH2-122, agent 122) on fixed pieces, RESTACK on the others, each ending
READY FOR AUDIT. Write ops/lanes122/notify/romanchats.txt with all five new full heads.

### B-MON2-122 — money screens fix round m#349 (+ any Sol MON1 Bs) (T4 money copy; stack lock: wizard) (queued until Sol MON1 posts)
Builder: Claude Opus 5.5. Time box 40 minutes.
Heads: wizard/money train m#345 ed29833cb2d5c597f0be3a557877bd3cf29d85a3 (base main) -> #346 5f8378ff26ab15bb007d33f14218f46d6c508cf3 ->
#347 08c7416ee102e457fdad3b98ca9b60e4268fa48d -> #348 d55e6f56d0d7328e12042413005cf40d40fa98c9 -> #349
53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4 -> #350 040a6a4efd8c9ea635861df718d32d6e5e418d46 -> #351 f30c5dbb4cb4e6211111291c2f6ca2f1598dffe3.
#345-#348, #350, #351 are approved by both lenses or Opus; do not change them except merge-only restack.
B-349-1 (Opus 6004992019): a coach taps one charge of a $100 monthly plan the client has paid three times; the page shows "$100.00" but
"Clients paid $300" and a $6 "TGP fee (2%)", and if the latest renewal failed it says the client was never charged and nothing reached
payouts (the backend breakdown sums every renewal of the plan). OPERATOR RULING: option 1, mobile only in #349: label the breakdown
truthfully as the plan's totals so far (e.g. "This plan so far: clients paid $300 ...") distinct from the single charge amount, and keep
the breakdown (no "never charged" claim) when only the latest renewal failed. No backend change. Plus every item-list B in Sol's MON1
verdicts (ops/reports/AUD-SOL-MON1-122.md once posted). If moneyCopy.ts changes, say which strings (it touches #348's review).
Failing-before test per B. Restack #350, #351 merge-only. One push per PR, at least 2 minutes apart; cancel superseded runs. Mobile CI lane
at #351 (tsc + money/Earnings tests). Comments: FIX ROUND (B-MON2-122, agent 122) on #349, RESTACK on #350/#351, each ending READY FOR
AUDIT. Write ops/lanes122/notify/money.txt with the new full heads.

## Wave 3 (owner 16:04 PDT: "More agents - scale up")

### Programs (step 6) — operator 122 rulings for all three programs jobs
The A9 entries B-PROG2-120, B-PROG4-120 and B-MWB409-120 in TGP_SOURCE_OF_TRUTH.md (tgp-agent-context, Part A9) are the job text; read
them in full. Heads unchanged since: m#355 902c64a64156255ce9ce54147db896ac2142a954 (base main), #356 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5,
#357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381, #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94. Reports: ops/reports/AUD-{OPUS,SOL}-{P12,P34}-120.md;
probes ops/aud-120/AUD-*-P12-120/ and AUD-*-P34-120/. OPERATOR RULINGS under the owner freeze (C (edge, deferred to 10k clients), do NOT
fix): Sol #356 "Undo races an explicit Save"; Sol #356 "HTTP 408 reopens editing"; Opus B-355-2 (in-progress retry treated as refusal);
Opus B-357-1 (lost response reuses the request key). Every other Sol #357/#358 B: apply _COMMON_122 item 6 yourself; fix only those with
an ordinary-use story; list the rest in your report as proposed C (edge) with one line each for the operator. Remove the clinic-build
flag flips from #355's eas.json (A9 ruling). Time box 60 minutes each.

### B-PRG2-122 — programs #355 + #356 fix round (mobile; lock programs) = B-PROG2-120 under the rulings above
Builder Opus. Fix in #355/#356 only: Sol/Opus roster capped at 20 (B-355-3 + Opus B-358-1 same root cause: paginate to completion or say
the list is partial), B-355-1/B-356-1 mobile side (read headIndex + lock token the backend PR from B-MWB409-122 returns; fail truthfully
until it ships), B-356-2. Merge main into #355. Write ops/lanes122/notify/programs.txt "programs P2: #356 @ <full sha>" when #356 is pushed.

### B-PRG4-122 — programs #357 + #358 fix round (mobile; lock programs-p34; parallel) = B-PROG4-120 under the rulings above
Builder Opus. Fix Opus B-358-2 (Remove dialog must show the true total and scope across runs/package copies) and the ordinary-use Sol
#357/#358 Bs. When ops/lanes122/notify/programs.txt shows the #356 head, merge it into #357 (merge-only), then #357 into #358.

### B-MWB409-122 — backend: keep head index + lock token in MWB autosave/undo 409 replies (new PR on main, under 1,500) = B-MWB409-120
Builder Opus. Exactly the A9 entry. Tell B-PRG2-122 the field names through ops/lanes122/notify/mwb409.txt as soon as they are fixed
(before the push). One CI lane; PR CI green; FIX ROUND 1 (OPENING, B-MWB409-122, agent 122) + READY FOR AUDIT.

### AUD-OPUS-BC1-122 / AUD-SOL-BC1-122 — broadcasts backend b#726-#730, first full review (T4: messaging to clients, consent, migration)
Lens: Opus and Sol, independent. Time box 45 minutes. Heads: b#726 b5501a89611844fc43717084d887e604af33037a (base main; schema, migration,
flag, errors; 642), #727 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5 (segments, recurrence, send-time scope; 1,221), #728
1dd798ab36e90dbb6b3719b7a4ae13883797167f (broadcasts, saved replies, client tags service; 1,162), #729 82a28bf2dbbe52b516e30fda1d22959ea0f87b42
(dispatcher; 1,114), #730 e97c472f00cdecbce2e5f1a680e05b1744c14715 (routes, module wiring, live checks; 865). Split of b#659 by
B-SPLIT-BCAST-121 (ops/reports/B-SPLIT-BCAST-121.md; verify only your own lens's prior #659 Bs). Item-list problems only: a broadcast
reaching clients of another coach or a client who left, a client who turned messages off still receiving them, private data in a message,
a scheduled broadcast that never sends or sends twice in normal use, a migration that breaks production. One verdict per PR at the exact head.

### B-CL2-122 — coachless b#721-#723 main refresh (T4; stack lock: coachless)
Builder Opus. Time box 40 minutes. Heads (dual APPROVE at these exact heads: Sol 6004991224/6004991568/6004991999, Opus
6005035666/6005036089/6005036513): b#721 d90b484278f432e6e73e41326dc31cadc8892999 (base main) -> #722 c219d2f391c37edd700d5204f31b50286f280d82
-> #723 e3368cc3cbb0961326ddf147728f7fc32d884188. #721 conflicts with main (prisma/schema.prisma; main moved through dunning-free
merges #712-#720, #731). Merge origin/main into #721 and resolve: keep both sides, no content change beyond the conflict hunks; list every
hunk in the comment. Prisma: `prisma validate` + `prisma format` check; migration name unchanged (Opus D1: keep) and still the newest-safe
additive migration (check main's migration list; say if its timestamp sorts before any main migration and whether that matters for
`migrate deploy` — it applies regardless of order). Then merge new #721 into #722, #722 into #723 (resolve and list any hunk). Run
/home/user/workspace/ops/tree_check.sh for each (approved sha vs new sha) and paste the result. One push per PR, at least 2 minutes apart.
PR CI on all three new heads incl. #721's rls-live-tests job (re-run any cancelled job). Comments: MAIN REFRESH (B-CL2-122, agent 122)
on #721, RESTACK on #722/#723, each ending READY FOR AUDIT (delta: conflict hunks only). Write ops/lanes122/notify/coachless.txt with the
three new full heads and the tree_check output. Do NOT fix the Cs (C-721-1 export rows, C-723-1..3) in this round.

### AUD-SOL-W3F-122 — Sol first FULL review of wizard W3 m#347 (T4: coach package creation/publish)
Lens: GPT-6.1 Sol. Time box 30 minutes. Head m#347 08c7416ee102e457fdad3b98ca9b60e4268fa48d (base = #346 branch at 5f8378ff26ab15bb007d33f14218f46d6c508cf3,
dual APPROVE). Sol's earlier #347 verdicts were restack-only (5998774888) and delta-only (6005093397); Opus did the first full W3 review
(6004996279, APPROVE 0/0/5; do not read it before posting). Review W3's whole diff vs #346 (CoachWizardNavigator.tsx,
CoachPackageEditScreen.tsx, tests). Item-list problems only: a coach publishes a price or offer different from what the screen shows,
a dead end in creating or editing a package, false copy, a client charged wrongly. Coach backend (b#674/#676/#677/#703) is in production.
One verdict at the exact head: "AUDIT GPT-6.1 Sol — growth-project-mobile#347 @ <sha> — VERDICT: ..." stating "full W3 review".

### AUD-OPUS-RMN1-122 / AUD-SOL-RMN1-122 — Roman backend b#667, #665, #666, #668 after FIX ROUND 1 (T4: AI, health data, safety)
Lens: Opus and Sol, independent. Time box 50 minutes. Stack (all draft, grandfathered 3,000): b#667 c5102cae659f87a4487a5756c52e8ab303664968
(A1 client context core, base main) -> #665 4dde3ffed2f21937bc036203eb90afc0d84ecd5e (A2 client context service + coach context
controller) -> #666 a3eb3206d3805dc765962528b6a1a3ab6e085b09 (B safety router + reply post-check, inert) -> #668
dabed7388157c64a50ff32bc8e7e003c001af339 (C1 live-turn wiring). FIX ROUND 1 comments: #667 6002677425, #665 6002677821 (B-ROMAN-AFIX-121),
#666 6002680008, #668 6002680261 (B-ROMAN-BFIX-121); builder reports ops/reports/B-ROMAN-*FIX-121.md. Prior verdicts: Sol RC on all four
(19:51-19:52); Opus RC on #666/#668 (20:28); Opus never reviewed #667/#665 (first full review for Opus there; delta + own prior Bs for
the rest). #669/#670 are NOT in scope. Binding (A9 "Roman day-1 jobs"): OR-115-1 neutral roman.safety_route action + restricted reason
code; OR-115-2 crisis templates without box-2 consent; Roman never reads CoachingSession private notes, bloodwork, purchases/invoices
or other users' rows (docs/roman-client-context.md in #667). Item-list problems only: Roman sees or reveals another user's data or a
forbidden source, a crisis message that does not get the safety reply, a client's health data sent without consent, a coach seeing a
client's private AI text, a migration that breaks production. Everything is inert until the Roman flags turn on. One verdict per PR.

### AUD-OPUS-RCH2D-122 / AUD-SOL-RCH2D-122 — Roman chats m#376 delta (T4)
Lens: Opus and Sol, independent. Time box 20 minutes. m#376 9f4415455f66605fd6dbcaf628621aa3d2064c37 (was 6fabb1f9; FIX ROUND comment
6005105143; report ops/reports/B-RCH2-122.md; PR CI run 37386559863 green; lane 37386588098 green incl. both lenses' probes). Check only:
B-376-1 closed (delete of the open chat from its row, transcript or Delete all clears the text and opens a fresh chat; a send at that
moment goes to the fresh chat) and the changed lines add no new item-list problem. #372-#375 unchanged and approved by both. One verdict.

### AUD-OPUS-TD1-122 / AUD-SOL-TD1-122 — trials delta (5 PRs) + Roman chats m#372 main merge (T4)
Lens: Opus and Sol, independent. Time box 35 minutes. Post the m#372 verdict first (5 minutes), then trials.
(A) m#372 @ 00b65c38df7c04f51f9a23763912bfd89149b8a6 (operator MAIN REFRESH comment on #372): the Roman chats train landed into #372 (bottom
head 6e73f0ea, tree = audited #376 9f441545 tree), then origin/main 203e80e3 was merged: README docs conflict (both sections kept) and two
auto-merged navigators whose change is exactly main's own hunks. Verify only that; one verdict on #372 at that head.
(B) trials (B-TR11-122, report ops/reports/B-TR11-122.md): #671 6bf110fb0f1c7ed7c0e6281c88ded177ddc357e1 (main merge; main touched ci.yml,
schema.prisma, account-deletion.manifest.ts outside PR lines), #672 0b55832e9198b167bf947fcba3220849dc01bea7 (conflict resolved to main's
side in notifications.service.ts + trial_ending in push/push-preferences.ts + test), #673 fbbd418aa2894a545cdc170b0ae41cd0f1e638ac and
#706 4f66e844cb13120d795dbf4f92b272552f3391de (merge-only), #707 92f48a5abbf4dd081787c019c9f632e31acb6769 (B-673-3 fix: opening a trial plan
cancels a card-less unstarted trial attempt on another plan of the same coach; main's spec split into no-card / card-saved cases).
Prior: Opus APPROVE all five at the old heads; Sol APPROVE four + RC #673 B-673-3. Check: B-673-3 closed for an ordinary client, the
three-days-before-charge notice is delivered with main's push code, merges add nothing new from the item list. One verdict per PR.

### B-BC2-122 — broadcasts fix round b#727/#728 (T4; stack lock: bcast)
Builder Opus. Time box 50 minutes. Heads: b#726 b5501a89611844fc43717084d887e604af33037a (base main) -> #727 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5
-> #728 1dd798ab36e90dbb6b3719b7a4ae13883797167f -> #729 82a28bf2dbbe52b516e30fda1d22959ea0f87b42 -> #730 e97c472f00cdecbce2e5f1a680e05b1744c14715.
Verdicts: Opus APPROVE all five (6005262469..6005263800; report ops/reports/AUD-OPUS-BC1-122.md); Sol APPROVE #726/#729/#730, REQUEST
CHANGES #727 (6005225441) and #728 (6005225900) (report ops/reports/AUD-SOL-BC1-122.md; probes run 37387147283, evidence
ops/aud-122/AUD-SOL-BC1-122/). Fix, in the piece that owns the code, failing-before test each:
1. Sol B-727-1: clients normally assigned to a master program disappear from that program's audience, so the coach cannot schedule.
2. Sol B-728-1: a sub-coach's ordinary audience-picker request shows other authors' owner-only program names.
3. Opus C-727-1 (operator: fix now, before the flag can turn on): archived clients must not be in any broadcast audience.
4. Opus C-728-1 (operator: fix now): editing a draft without a status keeps its current status (never sends it).
Leave C-728-2 and the other Cs. Restack upward merge-only. One push per PR, at least 2 minutes apart; cancel superseded runs; then make
sure every required check, including the live database specs, RUNS and is green at all five new heads (re-run cancelled jobs). One CI
lane at #730. Comments: FIX ROUND (B-BC2-122, agent 122) on fixed pieces, RESTACK on the others, each ending READY FOR AUDIT.
Write ops/lanes122/notify/bcast.txt with the five new heads.

### B-INV4-122 — invite codes b#658 B-658-9 (T4 access/money; stack lock: invite)
Builder Opus. Time box 35 minutes. Head b#658 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0 (base main; 2,960/3,000: keep the fix small).
Sol APPROVE at this head (19:44); Opus REQUEST CHANGES 6002144885 (report ops/reports/AUD-OPUS-INV3-121.md; probe
ops/aud-121/AUD-OPUS-INV3-121/aud-opus-inv3-121.probe.spec.ts). Operator ruling (121, 13:14, kept): sub-coaches may NOT attach the head
coach's packages to codes. Fix exactly as Opus wrote: in create(), when scope.issuerId is set and package_id or grant_mode is present,
answer 403 code_package_head_coach_only before assertBindablePackage and write nothing; update the B-658-1 unit case; add Opus P1 as the
regression (fails before, passes after). Merge origin/main first (say if anything conflicts). One push. PR CI green (re-run cancelled
jobs). Comment FIX ROUND 2 (B-INV4-122, agent 122) ending READY FOR AUDIT. Write ops/lanes122/notify/invite.txt with the new head.

### B-WIZ4-122 — wizard W3 m#347 fix round for Sol's full-review Bs (T4; owns the #347 branch; money restack after B-MON2-122)
Builder Opus. Time box 50 minutes. Head m#347 08c7416ee102e457fdad3b98ca9b60e4268fa48d (2,749/3,000: stay small), base #346 5f8378ff (dual
APPROVE, do not change). Sol full W3 REQUEST CHANGES 0/3/2 (6005264344; report ops/reports/AUD-SOL-W3F-122.md; probe run 37387324330 and
evidence ops/aud-122/AUD-SOL-W3F-122/). Opus APPROVE full W3 (6004996279). Operator ruling: all three are B (ordinary coach paths):
1. B-347-1: a coach edits the name/description of the free first package; Save rejects the unchanged $0 price. Saving unchanged $0 must work.
2. B-347-2: a coach enters a trial on a live monthly package and saves; the server does not keep it (main's backend has no trial column yet;
   trials ship with b#671-#707 and mobile m#338), yet the editor says saved and the buyer preview promises a trial. Never claim or preview a
   trial the server did not return; the simplest truthful fix (e.g. hide/disable the trial input until the saved package carries the
   trial field) is fine. Check m#338 (dual APPROVE, held) so the two do not fight; say how they compose.
3. B-347-3: a coach skips the first package, finishes setup, creates a paid package from the Home checklist, and has no action to publish
   it. Give the editor a reachable publish action for a draft (same publish call and confirm as the wizard).
Failing-before test each (Sol's probe should pass). One push to #347. Then the money train: B-MON2-122 owns #348-#351 until it writes
ops/lanes122/notify/money.txt and releases ops/lanes122/locks/wizard; after that, take the lock, merge your new #347 into #348, then
#348 -> #349 -> #350 -> #351 merge-only (list any conflict hunk), pushes at least 2 minutes apart. Mobile CI lane at #351. Comments:
FIX ROUND 4 (B-WIZ4-122, agent 122) on #347, RESTACK on #348-#351, each ending READY FOR AUDIT. Write ops/lanes122/notify/wizard2.txt.

### B-RMN2-122 — Roman backend fix round b#666 + #668 (T4 safety; stack lock: roman)
Builder Opus. Time box 60 minutes. Heads: b#667 c5102cae (dual APPROVE) -> #665 4dde3ffe (dual APPROVE) -> #666
a3eb3206d3805dc765962528b6a1a3ab6e085b09 -> #668 dabed7388157c64a50ff32bc8e7e003c001af339. Reports: ops/reports/AUD-OPUS-RMN1-122.md,
AUD-SOL-RMN1-122.md (probes: Sol run 37387394935, evidence ops/aud-122/AUD-SOL-RMN1-122/; Opus ops/aud-122/AUD-OPUS-RMN1-122/).
First merge #665's head into #666 and #666 into #668 (Opus: clean). Fix, failing-before test each:
1. Opus A-666-2 (safety-router.ts:34/68/72-87): common crisis phrasings ("I have been thinking about ending my life" and Opus's 7 probes;
   "I took 20 of my sleeping pills" -> the 911 reply) must get the crisis reply before any AI call, and never a 403 consent error (OR-115-2:
   crisis templates without box-2 consent). Run all of Opus's probe phrasings.
2. Sol B-666-4: a client asking whether to skip insulin before training must not receive that instruction unchanged (reply post-check /
   medication rule; safe redirect to their clinician).
3. Sol B-668-1 (Sol's id; different from Opus's closed B-668-1): when the coach's remaining AI credit cannot cover a reply, the client
   gets the capacity message, and the remainder is not silently bypassed.
4. Sol B-668-3: a daily-total claim (breakfast + lunch = 780 kcal) must be validated against the sum, not one meal.
Not in this round: Opus decision 2 (locked clients and Roman context: follow-up C, flags off) and #669/#670. Restack nothing above #668.
One push per PR, at least 2 minutes apart; cancel superseded runs; re-run cancelled required checks so they RUN at the new heads. One CI
lane at #668 (tsc + Roman specs + probes). Comments: FIX ROUND 2 (B-RMN2-122, agent 122) ending READY FOR AUDIT. Write
ops/lanes122/notify/roman.txt with the new heads.

### AUD-OPUS-CL3-122 / AUD-SOL-CL3-122 — coachless main-refresh delta b#721-#723 (T4)
Lens: Opus and Sol, independent. Time box 20 minutes. New heads (B-CL2-122, report ops/reports/B-CL2-122.md, evidence
ops/aud-122/B-CL2-122/): #721 538a0ba4baacefcea5208c0a8a11e87a1a09fb86 (main 5cde6253 merged; 1 conflict hunk at the end of
prisma/schema.prisma: PR's three coachless models + main's SchedulingJobLease), #722 f02a3904d0662731e0dc7bbb7cbbb026dfefdd71 (4 hunks:
feature-flag lists keep coachless_home + main's messaging_core_v2), #723 8c9943673cd2129732fde9b59aef2c19389d4b6c (merge-only). Both
lenses APPROVED the old heads (d90b4842 / c219d2f3 / e3368cc3). Check only the conflict hunks and that every PR line is unchanged; that
the migration (sorts before 7 main migrations, additive tables) applies cleanly with `migrate deploy`; #721's 11 required checks incl.
rls-live-tests green. One verdict per PR at the exact head.

### AUD-OPUS-PD1-122 / AUD-SOL-PD1-122 — programs m#355-#358 delta + backend b#733 first review (T4)
Lens: Opus and Sol, independent. Time box 45 minutes. Mobile: #355 36fd39d9eea8f4603358734a3e6c53905310992d (main merged; FIX ROUND 1
6005326625), #356 d38b4a7045da9c8aa0bec262adba2428dc8da287 (6005326994), #357 670fea7555e0621d475455d8f8490b0ac6f28c6d (merge-only,
6005427938), #358 dc47b4934b1feb5e77d6fc146e48aef3498c66cc (6005428222). Builder reports ops/reports/B-PRG2-122.md, B-PRG4-122.md.
Backend: b#733 635cabeeae1c3e74dd3f9311e5a059680e917628 (base main, 464 lines: allow-listed head_revision_index + lock_token in the three
409 replies; report ops/reports/B-MWB409-122.md; field contract ops/lanes122/notify/mwb409.txt) — first full review.
OPERATOR RULINGS (C (edge, deferred to 10k clients), do not re-raise): Sol #356 Undo-vs-Save race, Sol #356 408, Opus B-355-2, Opus
B-357-1, Sol B-357-1..4, Sol B-358-1, Sol B-358-2, the autosave pill copy when a 409 lacks head/token, a DB serialization 409 without
fields. Verify your own lens's remaining prior Bs are closed (B-355-1/B-356-1 end to end with b#733: the mobile parses the backend's
real 409 body; the 20-client roster; B-356-2; B-358-2 Remove scope/total; Sol B-358-3 Sentry PII). Opus's roster probe fakes the wrong
getClients signature (B-PRG4-122 report): judge the fix by the real call. One verdict per PR (5 comments).

### AUD-OPUS-MSG1-122 / AUD-SOL-MSG1-122 — messaging mobile m#371 + m#377, first full review (T4: messages between coach and client)
Lens: Opus and Sol, independent. Time box 40 minutes. m#371 d4244f2cab5a3d89124a5f56221ef389527d525b (base main; one coach inbox on the
v2 routes behind messaging_core_v2; 1,381) -> m#377 316f0a130012509f498b36993ec304f0dc151b3a (v2 thread actions on both thread screens;
1,492). Operator 121 FIX comments on both (realtime thread-updated pings with empty payload are refresh signals). Backend b#708-#711 is
in production (deploy 3); flag messaging_core_v2 is off in production. Reports for context: ops/reports/B-MSG-FIN-121.md,
B-SPLIT-MSG-120.md. Item-list problems only: a message shown in the wrong thread or to the wrong account, a message that does not send or
says sent when it was not, a coach inbox missing a client's message, a dead end. One verdict per PR.

### AUD-OPUS-SCH1-122 / AUD-SOL-SCH1-122 — scheduling mobile m#365-#367, first full review (T4: bookings, calendar)
Lens: Opus and Sol, independent. Time box 50 minutes. m#365 cceeb33a71982d44da40e75714332f59844e45fc (base main; scheduling API, errors,
calendar time, phone calendar; 2,025) -> m#366 fa7744cc237418a90239279541450ce2a8dc5959 (coach scheduling controls + tutorial calendar
step; 1,680) -> m#367 6418e759813065dc353720533dfd5c9b5a51ceb3 (client Calendar screens; retire booking request; 2,294). Backend
scheduling (b#712-#720 + #653) is in production (deploy 4). Owner day-1 scope: no double booking, appointment types, coach approval or
instant confirm, request expiry, reminders, coach and client calendar screens, phone time zone; coaches decide their times (open hours,
time off, notice, booking window, buffers, daily max). Item-list problems only (RUTHLESS SCOPE: zero time on time zones, races,
retries): a booking at a time the coach did not offer, a confirmed booking the other side never sees, a request that cannot be approved
or declined, false copy, a dead end. Never reviewed: first full review. One verdict per PR.

### AUD-OPUS-INV5-122 / AUD-SOL-INV5-122 — invite codes b#658 delta (T4 access/money)
Lens: Opus and Sol, independent. Time box 20 minutes. b#658 4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d (was 4de7a6dc: Sol APPROVE, Opus RC
B-658-9). Change = clean merge of main 5cde6253 + one fix commit (FIX ROUND 2 6005531674; report ops/reports/B-INV4-122.md): a team
sub-coach sending package_id or grant_mode to POST /coach/codes gets 403 code_package_head_coach_only before the package check and
nothing is written (operator ruling 121 13:14). Check: B-658-9 closed (Opus P1 passes; P3 refused as intended), the merge adds nothing
from the item list, CI green. One verdict at the exact head.

### AUD-OPUS-WM1-122 / AUD-SOL-WM1-122 — wizard W3 + money screens delta m#347-#351 (T4)
Lens: Opus and Sol, independent. Time box 35 minutes. Heads: #345 ed29833c and #346 5f8378ff (dual APPROVE, unchanged) -> #347
ee8a7777f8411283304d17a319b2e474970da593 (FIX ROUND 4, 6005454509: B-347-1 free $0 edits save; B-347-2 trial input removed, preview shows only
the saved trial; B-347-3 "Make <name> live" on drafts via the wizard publish route) -> #348 dca7e527bd6d8480c8d93b3591eca13429c6b7a0 (B-MON2
fix "Processing" -> "Not paid yet" for unpaid trials, 6005182154, then merge-only restack 6005475193) -> #349
8603080a1c01581c04af0f01c63c23d9fad44e1f (B-MON2 fixes 6005219170: "This plan so far" breakdown, failed latest renewal keeps earlier
breakdown, unpaid trial shows price only, held balance explained incl. paid-out money; restack 6005506675) -> #350
3dbd4b1d81f624bc09cd2b1f75554220de522c54 and #351 7bf7d6961df3e9586a1797452b524eed227a3fb2 (merge-only). Reports
ops/reports/B-WIZ4-122.md, B-MON2-122.md. #349/#350 PR CI red by design on 3 Earnings tests #351 retires; lane 37389877466 green at #351.
Check: your own lens's Bs closed (Sol: B-347-1/2/3, B-348-1, Sol B-349-1, B-349-2; Opus: B-349-1), the changed lines add nothing from
the item list, merges are merge-only. Operator accepts B-347-2's hide fix (Sol probe case 2 expected a trial in the request: not a B).
One verdict per changed PR (#347, #348, #349) and a merge-only verdict for #350 and #351 (5 comments).

### B-MSG2-122 — messaging mobile m#377 fix round B-377-1 (T4; stack lock: msg-mobile)
Builder Opus. Time box 35 minutes. Heads: m#371 d4244f2cab5a3d89124a5f56221ef389527d525b (dual APPROVE, do not change) -> m#377
316f0a130012509f498b36993ec304f0dc151b3a (1,492/1,500: 8 lines of room). Both lenses: B-377-1 (Sol 6005613022, Opus 6005697049;
probes: Sol run 37389419746, Opus run 37389829558): a client's failed "Done"/"Thanks" bubble disappears on the next refresh because
reconciliation matches older message text; drop a "Not sent" bubble only when the server has a row with the same client_message_id
(send UUID). If the same reconciliation code serves the flag-off client screen (Opus decision 2), the same rule fixes both; say so.
If the fix cannot fit #377's cap, open a NEW small PR on top of #377 (base = #377's branch, Conventional Commits title, under 1,500)
and say so. Failing-before test (both probes should pass). One push. Mobile CI lane (tsc + messaging tests). Comment FIX ROUND
(B-MSG2-122, agent 122) ending READY FOR AUDIT. Write ops/lanes122/notify/msg-mobile.txt.

## Wave 4 (owner: more agents; fix as much as possible before the 10-07 build)

### B-SCH2-122 — scheduling mobile m#367 fix round (T4; stack lock: sched-mobile)
Builder Opus. Time box 40 minutes. Heads: m#365 cceeb33a71982d44da40e75714332f59844e45fc (base main, dual APPROVE) -> #366
fa7744cc237418a90239279541450ce2a8dc5959 (dual APPROVE) -> #367 6418e759813065dc353720533dfd5c9b5a51ceb3. Two different Bs on #367
(reports ops/reports/AUD-OPUS-SCH1-122.md, AUD-SOL-SCH1-122.md; Sol probe run 37389639924, evidence ops/aud-122/AUD-SOL-SCH1-122/):
1. Opus B-367-1 (6005655881): a request that needed approval and was not answered in 48 hours shows "Status unavailable..." in Calendar and
   in the "Session request closed" push; production sends `expired`. Add the status and a plain label ("Request closed: your coach did not
   answer in time" or similar, impersonal voice) in calendarUi.tsx.
2. Sol B-367-1 (6005711262): a client choosing a regular appointment from the welcome fallback gets a welcome-call heading and a false
   "welcome booked" completion. Heading and completion must match the type booked.
Also, cheap and in #367 only: Opus C copy "coach will see it in Calendar" -> where coaches really see it (booking inbox). Merge origin/main
(2c88eae5) into #365 first (say if it conflicts), restack #366, #367. One push per PR, at least 2 minutes apart; cancel superseded runs.
Mobile CI lane at #367. Comments: MAIN REFRESH on #365, RESTACK on #366, FIX ROUND (B-SCH2-122, agent 122) on #367, each ending READY FOR
AUDIT. Write ops/lanes122/notify/sched-mobile.txt.

### S-AVAIL-122 — backend: coach booking options (minimum notice, booking window, buffers, daily max) (T4; new PR on main)
Builder Opus. Time box 75 minutes. Job text = A9 "S-AVAIL-120 = coach booking options only" in TGP_SOURCE_OF_TRUTH.md (owner 10:32
"COACHES DECIDE THEIR TIMES AND AVAILABILITY"): per coach (per appointment type where it makes sense): minimum notice (default 5 min =
today's rule), booking window (default 120 days = today's rule), buffer before/after (default 0), optional daily maximum. Additive
columns with defaults that reproduce current behaviour (one additive migration), enforced in the same advisory-locked validation as the
scheduling train on main (b#712-#720), open-slots honours them, coach GET/PATCH endpoints next to open hours (coach-only, own data). No
onboarding change. One NEW PR on main (backend main 95b0a05d), under 1,500 lines, Conventional Commits title, no banned casts. Tests:
each option enforced on booking + reflected in open slots; defaults unchanged. One CI lane; PR CI green incl. schema parity. Comment FIX
ROUND 1 (OPENING, S-AVAIL-122, agent 122) + READY FOR AUDIT. Write the endpoint contract to ops/lanes122/notify/avail.txt as soon as it is
fixed (a mobile builder uses it).

### M-ROMANCAP-122 — mobile: AI daily cap pop-up (owner 11:20, day 1; T3 mobile)
Builder Opus. Time box 45 minutes. Job text = A9 "M-ROMANCAP-120" in TGP_SOURCE_OF_TRUTH.md: when a client hits the daily AI cap, every AI
entry point shows a graceful pop-up with the owner's words "You've used your maximum AI allotment today." (plus when it resets, local
time), never a generic error or "Roman is unavailable". Map backend 503 ROMAN_CAPACITY_REACHED (b#669, not merged yet) and
AI_DAILY_QUOTA_EXCEEDED (ai.service.ts) plus the existing 429 to the pop-up in the Roman chat and every other AI surface; crisis turns stay
exempt. Report the configured cap value and env name from the backend. NEW PR on mobile main (2c88eae5), under 1,500 lines. Mobile CI
lane; PR CI green. Comment FIX ROUND 1 (OPENING, M-ROMANCAP-122, agent 122) + READY FOR AUDIT.

### B-ADJB-122 / B-ADJM-122 — Roman approve-to-adjust fix rounds: backend b#655 / mobile m#337 (T4; locks roman-adjust-be / -m)
Builders Opus (one per repo, coordinate through ops/lanes122/notify/adjust.txt). Time box 60 minutes. Heads: b#655
bf9120c1178c28b54256d41afed05a25578353f3 (2,058; base main), m#337 63be101394d996bd4475a8ad86c400925997092c (1,052; base main). Verdicts:
b#655 Sol RC 6001900785, Opus RC 6002431795; m#337 Sol RC 6001900495, Opus RC 6002745483; reports ops/reports/AUD-{OPUS,SOL}-RADJ-121.md.
Apply _COMMON_122 item 6 strictly: fix only Bs with an ordinary-use story (coach approves or declines a suggestion and the client's plan
changes or does not change as shown; no client sees a change the coach did not approve; no false copy; no dead end); list every other B
in your report as proposed C (edge) with one line each for the operator. Merge origin/main first. Flag FEATURE_ROMAN_ADJUST_ENABLED stays
off. Failing-before test per fixed B. One push. CI lane + PR CI green. Comment FIX ROUND (B-ADJB-122 / B-ADJM-122, agent 122) ending
READY FOR AUDIT.

### B-WIZ5-122 — wizard m#347 B-347-4: "Make live" must not publish stale terms (T4 money; stack lock: wizard)
Builder Opus. Time box 30 minutes. State: money train #351->#350->#349->#348 LANDED into #347's branch at 16:58 (dual APPROVE at
7bf7d696/3dbd4b1d/8603080a/dca7e527); #347 head is now 77e60a83ca541e8f480bb7729acbc0702cea9b71 (tree 757a2b37 = audited #351 top).
#346 5f8378ff and #345 ed29833c dual APPROVE. Operator ruling: Sol B-347-4 (6005829500; probe run 37390679683) is a B (= Opus C-347-6):
a coach edits a draft from $99 to $199 and taps "Make <name> live" and the old $99 offer goes live. Fix in the wizard screen on #347's
branch: while the form has unsaved changes, "Make live" saves the changed terms first (and only publishes after the save succeeds) or is
disabled with the plain line "Save your changes before making this live." Pick the smaller safe one. Failing-before test (Sol's probe
should pass). ONE fix commit on agent115/wizard-split-3-wizard-navigator, no merges. Mobile CI lane (tsc + wizard tests). Comment FIX
ROUND 5 (B-WIZ5-122, agent 122) on #347 ending READY FOR AUDIT (note: #347 now carries the landed money train; delta = your commit only).
Write ops/lanes122/notify/wizard3.txt.

### AUD-OPUS-BC3-122 / AUD-SOL-BC3-122 — broadcasts b#726-#730 delta (T4: messages to many clients)
Lens: Opus and Sol, independent. Time box 25 minutes. Heads: #726 b5501a89611844fc43717084d887e604af33037a (unchanged; base main) -> #727
63348b0771e39996cf75f8451802430f9f497229 -> #728 06b322e8471929933cbe0e635b1cc2f9dcdbc4cb -> #729 ec53c87f7bd800b9f2c469c7d4b36b16b8e67e65
(merge-only) -> #730 afbb4c1a846422df6b09a028d71d2a763a6ccf76. Report ops/reports/B-BC2-122.md (FIX ROUND comments 6005447893, 6005448253,
6005669771, 6005700804, 6005738820, 6005596999). Fixed: Sol B-727-1 (master-program audiences reach clients on that program), B-728-1
(program-ref check + picker), Opus C-727-1 (archived clients), C-728-1 (draft edits stay drafts); outside the list: #730 live-spec seed
(two sub-coaches shared a client), #728 test casts removed. Check your own lens's items are closed and the changed lines add nothing from
the item list (wrong audience = a client gets a message not meant for them, or misses one meant for them). One verdict per PR (#729
merge-only, #726 confirm unchanged).

### AUD-OPUS-MSG2-122 / AUD-SOL-MSG2-122 — messaging mobile m#377 delta (T4)
Lens: Opus and Sol, independent. Time box 20 minutes. m#371 d4244f2cab5a3d89124a5f56221ef389527d525b (dual APPROVE, unchanged) -> m#377
fae228c8f1609c24f9a581c74393b072eea23c12 (was 316f0a13; one fix commit, FIX ROUND 6005846596, report ops/reports/B-MSG2-122.md; lane
37390700458 77/77 incl. both lens probes). Check B-377-1 closed (a failed bubble stays until the server returns the same client_message_id;
older same-text messages no longer remove it) and the change adds nothing from the item list. One verdict on #377.

### AUD-OPUS-MF1-122 / AUD-SOL-MF1-122 — b#734 main fix: coachless map for invite-code lifecycle codes (T4)
Lens: Opus and Sol, independent. Time box 15 minutes. b#734 11ebdf44ffe27beceff36c79073155624068e73f (base main 6aff479c; 4 lines; operator 122 wrote it, so lenses are
independent). Main CI build-and-test red at 6aff479c (run 37390793076): b#658 made attachUserToCoachByCode throw code_revoked /
code_expired / code_exhausted; ATTACH_TO_COACHLESS lacked them, so coachless redemption answered 500 redemption_failed. Check: the map is
right, no other caller of attachUserToCoachByCode (auth.service.ts signup paths, auth.controller.ts) now turns those three codes into a
500 or a wrong message for a normal client (say so if one does: that is a B), CI green. One verdict at the exact head.

### AUD-OPUS-DUN2-122 / AUD-SOL-DUN2-122 — dunning delta b#689/#690/#691 (T4 money/access) — STEP 4, top priority
Lens: Opus and Sol, independent. Time box 25 minutes. Heads: #687 c140575c, #688 610c5254, #704 524c4025, #705 346b7757, #724 410fb1b3
(dual APPROVE, unchanged) -> #689 68796f675df9c67c0618145efff58caf32a26b04 (FIX ROUND 4, 6005485883: C-689-6 neutral dispute-or-inquiry
copy; SetupIntent omits an empty on_behalf_of) -> #690 5d41f7678438c11865762a7925ad53520948fe75 (FIX ROUND 3, 6005486208: B-690-8 / B-690-S1
coach restart route + clean #689 merge) -> #691 3dc0e9472954bdd8381d3394aeb79ab0d5712514 (RESTACK merge-only, 6005486528). Report
ops/reports/B-DUNFIX-122.md; lane 37388562724 green. Re-review scope: #689 commits 46fe43f7..68796f67; #690 d46ea900 + 5d41f767 (+ clean
merge 79601701); #691 merge-only. Check: B-690-8 closed (a coach can restart a client whose plan ended after failed payments, and only their
own client), the copy is true, the changed lines add nothing from the item list. One verdict per PR (#689, #690, #691).

### M-RESTART-122 — mobile: coach "Restart plan" for a dispute-paused client plan (T4 money; new PR on top of lockout m#354)
Builder Opus. Time box 45 minutes. Backend route (b#690 5d41f7678438c11865762a7925ad53520948fe75, FIX ROUND 3 comment 6005486208, report
ops/reports/B-DUNFIX-122.md): POST /v1/coach/purchases/:id/dispute-restart (coach/owner, own client only). 200 { restarted: true }; 404
PURCHASE_NOT_FOUND; 409 PLAN_NOT_DISPUTE_PAUSED, PLAN_ENDED, OTHER_LIVE_PLAN, NEW_DISPUTE; billing_busy (read the controller for the exact
code/status). Normal-user story: a coach whose client's plan was paused after a payment dispute (resolved in the coach's favour or settled)
taps "Restart plan" on that client's purchase and billing resumes; each refusal shows one plain sentence (impersonal voice, no "we").
Where: the coach's view of a client purchase that shows the dispute-paused state (find it in mobile main f5c399a7 or in the lockout stack
m#352 da686cea -> #353 78ed4e07 -> #354 be5c74b1, which adds the dunning API client). Base the NEW PR on the branch of m#354
(agent115/lockout-split-3-...; check with gh) so it lands right after lockout; under 1,500 lines; Conventional Commits title; confirm
dialog before restarting; button only when the backend says the plan is dispute-paused. Tests: success, each 409 maps to its sentence,
button hidden otherwise. Mobile CI lane; PR CI green. Comment FIX ROUND 1 (OPENING, M-RESTART-122, agent 122) + READY FOR AUDIT.

### AUD-OPUS-WZ6-122 / AUD-SOL-WZ6-122 — wizard m#347 B-347-4 delta (T4 money)
Lens: Opus and Sol, independent. Time box 15 minutes. m#347 9c86167e81cac8b0da12aabf129d9210fc435695 = 77e60a83 (money train landed into
#347's branch at 16:58; tree 757a2b37 = dual-approved #351 top) + ONE commit (FIX ROUND 5, 6006026528; report ops/reports/B-WIZ5-122.md;
lane 37391686887 green incl. Sol's probe). Fix: while the editor has unsaved changes, "Make live" sends nothing and shows "Save your
changes before making this live."; after Save it publishes the saved terms. Check B-347-4 closed and the commit adds nothing from the
item list. Delta = that one commit only (git diff 77e60a83 9c86167e). One verdict on #347.

### AUD-OPUS-RMN3-122 / AUD-SOL-RMN3-122 — Roman backend b#666/#668 delta (T4: health safety, money)
Lens: Opus and Sol, independent. Time box 25 minutes. Heads: #667 c5102cae, #665 4dde3ffe (dual APPROVE, unchanged) -> #666
8cfad60751e77eedb99c5ef0bd08abfe679976c5 (was a3eb3206; clean merge of #665 + fixes A-666-2 crisis phrasings get 988/911 before any AI
call, B-666-4 insulin line replaced, B-668-3 post-check half) -> #668 fefe73c6741843aaed2f31fa0881aa829114b201 (was dabed738; clean merge of
#666 + B-668-1 coach credit admission at worst-case 9 cents). FIX ROUND 2 comments 6005723004, 6005723267; report ops/reports/B-RMN2-122.md;
lane 37389901390 (all prior lens probes pass). #668 PR CI red only on the 12 known tests (11 C-668-6 mock tests fixed by #669's stub +
by-design FR1-651-3); #668 lands only together with #669. Check your own lens's items are closed and the changed lines add nothing from
the item list. Operator: keep the 9-cent threshold; Opus decision 2 (locked clients' Roman context) stays a follow-up C. One verdict per
PR (#666, #668).

### B-RMNC2-122 — Roman C2 b#669 finish + restack C3 b#670 (T4: health safety, money; stack lock: roman)
Builder Opus. Time box 75 minutes. #669 head 6386c00b (base agent115/roman-split-c1-live-turns = #668's branch) is NOT READY: the C2 fix
sits half-done and untested on ci/B-ROMAN-BFIX-121-669-wip @ 62f89792 (STATUS comment on #669 by B-ROMAN-BFIX-121: payload bound,
advisory-lock admission, settledUsage, neutral roman.safety_route audit, no exclamation allowance, error-tag dedupe, roman.prompts.ts line,
disclosed T4 ci.yml step for roman-spend-admission.live.spec.ts). Do: start from that wip branch, merge #668's new head
fefe73c6741843aaed2f31fa0881aa829114b201, run the recipe's before-specs and make them pass, add the C-668-6 assertCoachPoolOpen stub (so
#668's 11 mock tests pass on #669), keep the B-668-1 9-cent admission, make #669's own tests green (FR1-651-3 included: #669 is the fix
for C2's red-by-design tests), push to #669's branch ONCE, then restack #670 (merge new #669; golden-set harness) and push. Read only the
SoT A9 entries for B-ROMAN-BFIX-121 / B-SCHED-ROMAN-115 for the recipe if you need it. Size caps: #669 under 3,000, #670 under 3,000.
CI lane at #670; PR CI green on #669 and #670. Comments FIX ROUND (B-RMNC2-122, agent 122) on #669 and RESTACK on #670, both ending READY
FOR AUDIT. Write ops/lanes122/notify/roman-c2.txt.

### B-WIZ6-122 — step 3 mobile: main refresh of the collapsed wizard+money train m#345 (T4 money; stack lock: wizard)
Builder Opus. Time box 40 minutes. State: m#351..#346 all LANDED into #345's branch (agent115/wizard-split-1-setup-data) at 17:12; #345 head
f7a86065bfe7e128eb4437b4124b63c1c2bb254a, tree 71c4f04e = the dual-approved top (#347 9c86167e). #345 base = main (mobile main c0e1c9ac).
`git merge-tree` shows two content conflicts with main: src/api/packagesApi.ts and src/screens/coach/payments/CoachPackageEditScreen.tsx,
from the m#321 S-FEE fee-rule editor that landed on main (commits 8bc4de3, a9b1f49, 4295fc7, 7322bbf, 11ed094: $19.99 minimum or free
rule inline, specific package-save failures, currency/billing edits sent, publish/unpublish, every editor input saved and publish waits
for a save, recurring price copy never offers $0). Do: merge origin/main into #345's branch and resolve so BOTH sides' behaviour stays:
S-FEE (above) and the wizard train (B-347-1 a free one-time package saves edits at its unchanged $0 while a new $0 on a paid package is
refused; B-347-2 no trial input; B-347-3/4 "Make <name> live" for drafts, blocked with "Save your changes before making this live." while
unsaved). Where both sides solved the same thing (publish waits for a save), keep ONE path, not two. Both sides' tests must pass. ONE merge
commit (plus a fix commit only if a test proves it is needed). Mobile CI lane (tsc + package/wizard/money tests + S-FEE tests); PR CI
green. Comment MAIN REFRESH (B-WIZ6-122, agent 122) on #345 listing each conflict hunk and how it was resolved, ending READY FOR AUDIT.
Write ops/lanes122/notify/wizard4.txt.

### AUD-OPUS-DUN3-122 / AUD-SOL-DUN3-122 — dunning b#687 main merge check (rule 12: sensitive files in a main merge)
Lens: Opus and Sol, independent. Time box 12 minutes. The whole dunning train (#691..#688, all dual APPROVE) landed into #687 at 17:11;
#687 0716a0f4ebf82fe6d73399fe80d4930d9bd77589 had tree d5d8d95c = the audited #691 top. Operator then merged main a70533d5 into #687
(GitHub update-branch, no conflicts) -> #687 aa736434287c7ebcf2b68e87ee8a0b5dabf2b015. ops/tree_check.sh flags two sensitive files changed by
the merge: prisma/schema.prisma and src/common/env-validation.ts (main brought coachless b#721-#723, invite codes b#658, MWB 409 b#733,
coachless map b#734). Check ONLY the merge commit: for those two files (and the migrations folder order), the result is the plain union of
both sides, nothing of either side lost or changed, migration timestamps of dunning sort after main's or are independent, no duplicate
model/enum/env key; PR CI at aa736434 green (or name the failing check). One verdict on #687 at aa736434 ("merge-only").
ADDENDUM 17:15 to B-RMNC2-122: also fix in #669 Opus A-666-3 (named-medicine overdose phrasings must get the 911 reply before any
consent/pool check; probe in ops/aud-122/AUD-OPUS-RMN3-122/probes/) and Sol B-666-5 (meals path bypasses whole-day validation; probe run
37392562345). #666 8cfad607 and #668 fefe73c6 stay unchanged (#668 dual APPROVE; #666 Opus RC A-666-3 + Sol RC B-666-5 -> verified at #669).

### AUD-OPUS-CAP1-122 / AUD-SOL-CAP1-122 — AI cap pop-up m#379, first review (T3 mobile; health-adjacent copy)
Lens: Opus and Sol, independent. Time box 20 minutes. m#379 67d9aaa33afe9740201f8e110649967c832bd461 (base mobile main; +657/-6; report
ops/reports/M-ROMANCAP-122.md; OPENING comment 6006235540). Owner 11:20: when a client hits the daily AI cap, every AI entry point shows a
graceful pop-up "You've used your maximum AI allotment today." (with when it resets), never a generic error. Check: the pop-up shows on the
real cap codes the backend sends (503 ROMAN_CAPACITY_REACHED from b#669, AI_DAILY_QUOTA_EXCEEDED, 429) in Roman chat (client + coach) and the
AI guide; a crisis message is never blocked by the app; no false copy (reset time). Operator rulings: the platform-wide spend cap and the AI
guide token limit are backend follow-ups, not Bs on this PR. One verdict.

### B-AIG-122 — backend: AI guide crisis message is answered before the daily token limit (T4: health safety; new PR on main)
Builder Opus. Time box 35 minutes. Found by M-ROMANCAP-122 (report ops/reports/M-ROMANCAP-122.md, decision 3): src/ai/ai.service.ts
reserveDailyTokens throws 429 AI_DAILY_QUOTA_EXCEEDED before any safety handling, so a client who used up the day's AI guide limit and then
types a crisis message (self-harm, overdose, "I want to die") gets the limit pop-up instead of 988/911. src/ai/ai-guardrails.service.ts
already has crisis patterns. Normal-user story: a struggling client who chatted a lot today types "I want to kill myself" in the AI guide
and must see the 988/911 message, never "You've used your maximum AI allotment today." Fix: run the crisis check first; a crisis message
gets the safety reply without spending quota or calling the model (match Roman's crisis reply wording if one exists in main; impersonal
voice). Do not change the token limit itself (operator: separate follow-up). NEW PR on backend main (pull first), under 1,500 lines,
Conventional Commits title, no banned casts, failing-before test. CI lane (targeted) + PR CI green. Comment FIX ROUND 1 (OPENING,
B-AIG-122, agent 122) + READY FOR AUDIT.

### AUD-OPUS-AV1-122 / AUD-SOL-AV1-122 — coach booking options b#735, first review (T4: bookings)
Lens: Opus and Sol, independent. Time box 30 minutes. b#735 32d8120712cc106eb87a4a3457661dc2cf427a1e (base main; 915 lines; report
ops/reports/S-AVAIL-122.md; OPENING comment 6006284912; contract ops/lanes122/notify/avail.txt). PR CI build-and-test red only on the 3
coach-code-redemption tests that were red on main 6aff479c (fixed on main by b#734 a70533d5; not this PR). Owner day-1 scope (10:32
"COACHES DECIDE THEIR TIMES AND AVAILABILITY"): per-coach minimum notice (default 5 min), booking window (default 120 days), buffers
before/after (default 0), optional daily maximum; defaults reproduce today's behaviour; enforced in the locked booking validation; open
slots honour them; coach GET/PATCH own options. Operator accepts the builder's 4 design defaults (per coach not per type; buffers add up
and need not fit open hours; daily max counts requested+scheduled+pending on the coach's local day; coach self-moves not bound). Item-list
problems only: a client can book a time the options forbid, open slots show a time that then fails, a coach can read/change another
coach's options, defaults change today's behaviour, the migration is not additive. One verdict.

## Wave 5 (owner 17:18: 15 parallel workers, everything except free trials)

### AUD-OPUS-DUN4-122 / AUD-SOL-DUN4-122 — dunning b#687 R75 fix commit (T4)
Lens: Opus and Sol, independent. Time box 10 minutes. #687 2f11f14bb8c361d72dc0f5db8e0725801a83b821 = aa736434 (DUN3 dual APPROVE
merge-only) + ONE operator commit: the two best-effort requeue writes in src/checkout/client-billing.service.ts (reconcile 2A requeue,
deferOperation) now log a warn with dunningErrorCode instead of `.catch(() => undefined)`; nothing rethrown, behaviour otherwise unchanged.
R75 local: empty-catch-undefined net 0, OK. Check the commit only (git diff aa736434 2f11f14b) + PR CI at 2f11f14b. One verdict on #687.

### AUD-OPUS-SCH3-122 / AUD-SOL-SCH3-122 — scheduling mobile m#365-#367 delta (T4)
Lens: Opus and Sol, independent. Time box 25 minutes. #365 cd546a43d0d90f1e032fdf1d8520dfc9ccdc2821 (MAIN REFRESH merge of main 2c88eae5,
6006000889) -> #366 4936257bded6034fe9bda6eebd1783b9ecf1f526 (RESTACK 6006038493) -> #367 2699b4b10f4a5370a8d44121f7b8c18331a712b0 (FIX ROUND
6006086428: Opus B-367-1 "Request closed, your coach did not answer in time" + "Pick another time"; Sol B-367-1 welcome heading/completion
only for a real welcome type; Opus C-367-2 booking inbox copy). Report ops/reports/B-SCH2-122.md. Merges changed some PR files (main also
edited them), so check #365/#366 merges are plain unions (merge-only), your own lens's B is closed, the fix adds nothing from the item list.
Note: mobile main is now c0e1c9ac (programs + messaging merged after 2c88eae5); say if you see a conflict risk. One verdict per PR.

### AUD-OPUS-RST1-122 / AUD-SOL-RST1-122 — coach "Restart plan" m#380, first review (T4 money)
Lens: Opus and Sol, independent. Time box 20 minutes. m#380 b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 (base m#354's branch
agent115/lockout-split-3-card-update-tests @ be5c74b1; 549 lines; report ops/reports/M-RESTART-122.md; OPENING 6006316073). Backend route
b#690 POST /v1/coach/purchases/:id/dispute-restart (now landed into b#687). Check: the button shows only for a dispute-paused plan of this
coach's client, a confirm step, success refreshes the state, each refusal shows one true sentence, no client-side path can restart someone
else's plan. Operator accepts placement on the coach's client detail screen. One verdict.

### M-AVAIL-122 — mobile: coach booking options editor (T3 mobile; new PR on top of m#367)
Builder Opus. Time box 50 minutes. Backend b#735 32d81207 (in review): GET/PATCH /scheduling/coach/booking-options, fields
min_notice_minutes (default 5), booking_window_days (default 120), buffer_before_minutes, buffer_after_minutes (default 0),
daily_max_sessions (null = no cap); 400 INVALID_BOOKING_OPTIONS names the field; 403 for non-coaches (contract
ops/lanes122/notify/avail.txt). Build a coach "Booking options" screen next to open hours in the coach scheduling controls (m#366/#367
area), plain labels and short helper lines (impersonal voice), validation matching the backend, save with clear success/failure copy; a
404/feature-off answer hides the entry. Base the NEW PR on m#367's branch (agent115/sched-split-3-client-calendar @ 2699b4b1) so it lands
right after scheduling; under 1,500 lines; Conventional Commits title. Tests: load, save, field error, hidden when off. Mobile CI lane; PR
CI green. Comment FIX ROUND 1 (OPENING, M-AVAIL-122, agent 122) + READY FOR AUDIT.

### B-BC4-122 — broadcasts b#726 main refresh (T4; stack lock: bcast)
Builder Opus. Time box 40 minutes. Broadcasts #730..#727 LANDED into #726 at 17:05 (dual APPROVE BC3); #726 head
cb5ef90a43974e17abca3715cdf8d1432d004f48, tree 22166591 = audited top (#730 afbb4c1a). #726 base main; conflicts with main in
.github/fly-env-desired-state.json, .github/workflows/ci.yml, docs/runbooks/launch-flags.md, prisma/schema.prisma,
src/account-deletion/account-deletion.manifest.ts, src/messaging/messaging.service.ts. WAIT until dunning b#687 is merged into main (poll
`gh pr view 687 --json state` every 3 minutes, at most 25 minutes; if it has not merged by then, merge the current main anyway and say so),
then merge origin/main into #726's branch and resolve: both sides kept (flags, CI steps, runbook rows, schema models, deletion manifest
entries are unions; messaging.service.ts: keep main's behaviour AND broadcasts' additions, never drop either). Both sides' tests must pass;
schema parity green. ONE merge commit (+ a fix commit only if a test proves it). CI lane + PR CI green (all 11 required). Comment MAIN
REFRESH (B-BC4-122, agent 122) listing each conflict hunk and its resolution, ending READY FOR AUDIT. Write ops/lanes122/notify/bcast2.txt.

### B-LOCK5-122 — lockout mobile m#352 main refresh (T4 access/money; stack lock: lockout-m)
Builder Opus. Time box 35 minutes. m#380 (coach Restart plan, dual APPROVE b49d7147) -> #354 -> #353 all LANDED into #352's branch
(agent115/lockout-split-1-dunning-data) at 17:30; #352 head e39a84de6e3b8e96afb44b96f80e2eb09ea3cb26, tree 9f6b64af = audited top. Base main
(mobile main 3c315e40 + #365 soon). Conflicts with main: src/navigation/README.md, src/services/api.ts (main gained programs m#355-#358,
messaging m#371/#377, AI cap pop-up m#379, Roman chats). Merge origin/main into #352's branch; resolve as unions: api.ts keeps BOTH main's
interceptors/handlers (AI cap codes, MWB 409 etc.) AND lockout's 402/lockout handling, in an order where a lockout answer still routes to the
lockout screen and an AI cap answer still shows the pop-up; README rows from both. Both sides' tests pass. ONE merge commit (+ a fix commit
only if a test proves it). Mobile CI lane (tsc + lockout + api + AI-cap + messaging tests); PR CI green. Comment MAIN REFRESH (B-LOCK5-122,
agent 122) on #352 listing each hunk and its resolution, ending READY FOR AUDIT. Write ops/lanes122/notify/lockout-m.txt. The payment sheet
m#342 (collapsed, 4c79b67c) refreshes AFTER this lands (it conflicts with lockout in config/expected-env.json and ClientPackagesScreen.tsx).

### AUD-OPUS-ADJ2-122 / AUD-SOL-ADJ2-122 — Roman approve-to-adjust delta b#655 + m#337 (T4: client plan changes)
Lens: Opus and Sol, independent. Time box 30 minutes. b#655 2902add5bb9f96c2ea488282ee1e6d727d203044 (fix 2d356da4 + main merge; FIX ROUND
6006482768; report ops/reports/B-ADJB-122.md) and m#337 c37add1c37dd47fb6d5ade587b320b84e64854db (FIX ROUND 6006171272; report
ops/reports/B-ADJM-122.md). Flag FEATURE_ROMAN_ADJUST_ENABLED stays off. Builders' proposed Cs (operator will rule C (edge) unless you give
a normal-user story): backend Sol B-655-1..4, the sleep-rule logic, sub-coach access (head coach only at launch), DB access rules for the
reassigned-client case; mobile Sol B-337-4, Opus C-337-1..5, Sol C-337-1/2. Check your own lens's remaining Bs are closed (incl. Sol A-655-1:
a reassigned client's old coach can no longer see her heart data or change her workout; B-337-2/3 unconfirmed results say so and reload),
and the changes add nothing from the item list. One verdict per PR (2).

### B-725R-122 — backend b#725 main refresh after dunning (T4 access; lock: lockout-be)
Builder Opus. Time box 30 minutes. b#725 1dbc59b690119f03f010e406f9f1e0e43d1e6556 (base main; dual APPROVE; "a locked client reaches their
own coach thread", B-353-10). Dunning (b#687 incl. #691) merged to main eb2e9e03 at 17:28 and conflicts with #725 on the lockout
allow-list. Merge origin/main into #725's branch so there is ONE lockout allow-list holding both main's entries (incl. #691's and the coach
restart route rules) and #725's own-coach-thread entries; a locked client reaches exactly their own coach's thread and nothing else new.
Tests from both sides pass (route-table spec, lockout specs). ONE merge commit (+ fix commit only if a test proves it). CI lane + PR CI green
(11 required). Comment MAIN REFRESH (B-725R-122, agent 122) with each hunk's resolution, ending READY FOR AUDIT.

### B-339-122 — mobile m#339 impersonal-voice copy sweep fix round (T3 copy)
Builder Opus. Time box 35 minutes. m#339 8165ca9560d2bcd35f92b1cd8468e6c998aa552a (base main; 698 lines; "impersonal voice across shipped copy with
a repo-wide voice check"). Sol RC 5972066633 (10-03). Merge origin/main first (main moved a lot today: wizard pieces not yet, but programs,
messaging, Roman chats, AI cap pop-up, scheduling soon): the repo-wide voice check must pass on the merged tree, so fix any new first-person
copy ("we", "our", "I") main brought, or exempt only crisis/legal lines the check already exempts. Fix Sol's Bs that have an ordinary-use
story; list the rest as proposed C. One push. Mobile CI lane; PR CI green. Comment FIX ROUND (B-339-122, agent 122) ending READY FOR AUDIT.

### B-643-122 / B-341-122 — booking reminders on at launch: backend flag b#643 + mobile device zone/quiet hours m#341 (T4)
Builders Opus (one per repo; coordinate via ops/lanes122/notify/reminders.txt). Time box 45 minutes. b#643 f21b3c63 "chore(flags):
BOOKING_REMINDERS_ENABLED -> on, reminders on at launch (OR-110-5)", base main, both RC 10-02 (Sol 5960175016, Opus 5960179586). m#341
7c791bb39979eb16481ce71a85de652b41368a3a "device zone via PUT /notifications/timezone, booking ..." (1,966 lines), base main, both RC 10-03 (Sol
5972146496, Opus 5972160274). Scheduling backend is in production (deploy 4) and mobile scheduling m#365 is landing now. FIRST check what
main already has (mobile main has src/services/timezoneSync.ts; backend may already have PUT /notifications/timezone): if a PR is
superseded, say so in its comment and stop for that PR. Otherwise merge origin/main and fix only Bs with an ordinary-use story (a client
gets a reminder at the wrong hour or not at all, a reminder for a cancelled booking, a tap that opens the wrong screen); RUTHLESS SCOPE
(zero time on DST/race/retry edges: list as proposed C). One push each. CI lane + PR CI green. Comments FIX ROUND (B-643-122 / B-341-122,
agent 122) ending READY FOR AUDIT.

### B-MWBFLAG-122 — programs on at launch: backend flag PR + mobile build flags (T4 flags; do NOT merge)
Builder Opus. Time box 35 minutes. Programs backend (b#733 + MWB-3) is in main and deploys now; mobile programs m#355-#358 merged (flag off).
Backend .github/fly-env-desired-state.json has FEATURE_MWB_TEMPLATES, FEATURE_MWB_AUTOSAVE_UNDO, FEATURE_NAMED_REGIMES = unset and
MWB_AUTOSAVE_LOCK_TOKEN_SECRET = unset (note: precondition of the autosave flag; the secret itself must exist as a GitHub secret before the
flip; you must NOT create or set any secret and must NOT run any env sync or fly-secrets workflow). Do: (1) backend NEW PR on main flipping
the three flags to on and the secret entry to github-secret, docs/runbooks/launch-flags.md rows, any flag test updated; PR body states
"merge only after the owner confirms MWB_AUTOSAVE_LOCK_TOKEN_SECRET exists". (2) mobile NEW PR on main turning EXPO_PUBLIC_FF_MWB_AUTOSAVE and
EXPO_PUBLIC_FF_MWB_PROGRAMS on for the production build profile the 10-07 Expo build uses (find where production EXPO_PUBLIC_FF_* values live:
eas.json / config/expected-env.json; follow how other day-1 flags were turned on). Both under 300 lines, Conventional Commits titles. CI
green. Comment FIX ROUND 1 (OPENING, B-MWBFLAG-122, agent 122) + READY FOR AUDIT on each. Report the exact owner step for the secret in
plain words.

### AUD-OPUS-AIG1-122 / AUD-SOL-AIG1-122 — AI guide crisis reply before the daily limit, b#736 (T4 safety)
Lens: Opus and Sol, independent. Time box 25 minutes. b#736 f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 (base main; 213 lines; builder comment
6006627739; report ops/reports/B-AIG-122.md). Story: a client who used up today's AI guide allowance types "I want to kill myself" or "I took
a whole bottle of pills" and gets the fixed 988 / 911 reply instead of "limit reached". Check: the crisis check runs before consent, the
token limit and the model; no allowance spent; non-crisis messages unchanged (limit still applies, normal answers unchanged); fixed text is
impersonal and correct (988 for self-harm, 911 for emergencies); no false positive on ordinary fitness phrases a normal client types
("kill this workout", "I'm dying after leg day", "overdose on cardio") that would replace a normal answer with a crisis reply. Builder's
proposed follow-ups (hourly 20/h /ai/chat throttle, shared pattern list after Roman merges, daily limit size) are C unless you give a
normal-user story. One verdict.

### AUD-OPUS-RMN4-122 / AUD-SOL-RMN4-122 — Roman live turns delta b#669 + b#670 (+ closes #666 Bs) (T4 safety/AI)
Lens: Opus and Sol, independent. Time box 35 minutes. Stack: #667 c5102cae -> #665 4dde3ffe -> #666 8cfad607 -> #668 fefe73c6 -> #669 -> #670.
#667/#665/#668 dual APPROVE; #666 has Opus A-666-3 (named-medicine overdose "a whole bottle of Tylenol" got no 911) and Sol B-666-5 (a day
total mentioning "meals" not checked against the whole day) whose fixes sit on #669 (operator ruling: review them on #669).
#669 ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2 (FIX ROUND 1 6006562381; 1,609 lines vs #668; finishes the C2 WIP, merges #668, stub for #668's
red tests, B-668-1 pool tests, A-666-3, B-666-5); #670 dc159eaf24dafafd32df4c06ed75f08971b31bbc (RESTACK 6006623533; merge-only; golden 27/27).
Report ops/reports/B-RMNC2-122.md. Check: A-666-3 and B-666-5 closed with tests that fail on the old code; overdose threshold (5+, or bottle/
pack/handful/bunch) does not fire on "took 2 Tylenol for my headache"; #669's own Bs from earlier rounds (B-651-1/4/5, OR-115-1/2, B-651-9)
closed; nothing from the item list added; #670 is merge-only. One verdict per PR (#669, #670) plus a one-line "#666 Bs closed via #669: yes/no"
in the #669 verdict.

### AUD-OPUS-WZ7-122 / AUD-SOL-WZ7-122 — step 3 mobile m#345 main-refresh resolution (T4 money copy/paths)
Lens: Opus and Sol, independent. Time box 25 minutes. m#345 90e113bbcf9d1df530bd692a407b1c214598523f = ONE merge commit of the audited train
top f7a86065 (tree 71c4f04e = WZ6 dual-APPROVED #347 9c86167e) and main 3c315e40 (which carried S-FEE m#321's fee-rule editor). Builder
comment 6006513689 (+ CI follow-up 6006620708); report ops/reports/B-WIZ6-122.md. Review ONLY the conflict resolution in src/api/packagesApi.ts,
src/screens/coach/CoachPackageEditScreen.tsx and the four test files whose assertions changed: (a) one save path (lower-case currency, billing
only when changed, switching to one-time clears interval/count) and one publish path (main's, with idempotency key); (b) the edit screen keeps
main's price rule and messages AND the train's durable create; "Make <name> live" disabled while unsaved (B-347-4 must stay closed); live
packages show "Unpublish package"; (c) nothing either side had is silently dropped. Builder decisions (operator default keep): $0 one-time
allowed per main's fee rule; blocked "Make live" is a disabled button. Story check: a coach edits a price and taps Make live without saving -> the
button is disabled, so the old price is never published. One verdict.

### AUD-OPUS-MO1-122 / AUD-SOL-MO1-122 — merge-only checks after dunning landed: b#655 + b#735 (T4)
Lens: Opus and Sol, independent. Time box 12 minutes. Both PRs were dual APPROVED; main then moved to eb2e9e03 (dunning) and each got a
main merge that tree_check flags. Verify ONLY that each new head is the approved head + main with the PR's own change unchanged:
- b#735 082d4653aa88ab1e4b05817a3a305fc138805026 = approved e07d6e13 (AV1 dual APPROVE at 32d81207, then a merge-only update to a70533d5) + main
  eb2e9e03 via GitHub update-branch (no hand edits). tree_check flags prisma/schema.prisma (dunning also edited it). Operator evidence: stable
  patch-id of `git diff eb2e9e03..082d4653` = patch-id of `git diff a70533d5..e07d6e13` = 0dd2c4e4. Check schema.prisma composes (both
  dunning's and #735's models/columns present, no duplicate), migrations from both present, PR CI green at 082d4653.
- b#655 a0ccfcdd542022ce4e654709790aa50074c4b861 = approved 2902add5 (ADJ2 dual APPROVE) + main eb2e9e03, one hand-resolved conflict in
  .env.example (both flag blocks kept). Comment 6006684890. Check the resolution and that nothing else changed; PR CI green at a0ccfcdd.
Post "AUDIT <lens> — growth-project-backend#<n> @ <sha> — VERDICT: APPROVE (merge-only)" or REQUEST CHANGES per PR.
