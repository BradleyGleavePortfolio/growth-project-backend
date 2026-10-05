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
