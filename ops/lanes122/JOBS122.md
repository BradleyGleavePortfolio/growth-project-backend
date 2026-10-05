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
