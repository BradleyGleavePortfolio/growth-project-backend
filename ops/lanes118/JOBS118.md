# Agent 118 job board — wave 1 (10-04). One agent per job; one or two PRs per job (plus merge-only restacks named in the entry); END.
Re-read every head on GitHub before acting. All jobs T4 unless stated. Builders: _COMMON_116.md section 7 + _COMMON_118.md.
Lenses: _COMMON_116.md section 8 (claims under ops/lanes118/claims) + _COMMON_118.md; independent of every builder; one verdict per
PR per head; re-read the head right before posting. Repo = growth-project-backend unless "mobile". B = backend base URL
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/<n>#issuecomment-<id>.

## B-FEES15-118 (builder, Claude Opus 5.5, T4) — fees F2 #682 + F3 #683, then merge-only restack F4 #684 -> F4b #697 -> F5 #685 -> F6 #686
Job one of the whole launch: recurring is stacked on fees, so every fees round forces a recurring restack. Land-quality, once.
Heads: #681 F1 e9650dc4 (dual APPROVE, do not touch), #682 a2051568, #683 33a9d83b, #684 7872a533, #697 b8b63e63, #685 8dc2c2ed,
#686 13c814f7. Take lock `fees`.
- #682: Sol APPROVE 0/0/0 (5977674117). Opus RC 0/1/3 (5977756869): B-682-9 — round-14 test adds banned R75 tokens
  (`test/s-fee-r11-reversal-admission-diagnostics.spec.ts` :357/:371 `page as never`, :369 `.catch(() => undefined)`); the composed
  candidate fails the required "Banned cast tokens" check when F1 carries the stack to main. Dead builder B-F3-117 left two unpushed
  commits on branch ci/B-F3-117-682-r75-after (4482adcd, 5a57e220; its lane run 37186992337 FAILED — find out why). It typed the
  array as `any`; use a genuinely neutral typed form instead (no `any`, `as never`, `as unknown as`, empty catch). Prove with
  `node scripts/check-r75.js --mode=range --base=b644198b90bb9ab1dc62a78794e12cf09f8ace7c --head=<sha>` at F2, at the restacked fees top
  #686, and on a scratch merge of the recurring top (#701 67905b43) with your fees top: no positive class anywhere.
  #682 stays red by design with exactly the 4 tests Sol/Opus verified (F4 carries them); say so with the run URL.
- #683: Sol RC 0/2/2 (5977674319), Opus RC 0/1/4 (5977756981; corrected from APPROVE). Fix:
  - Sol B-683-1 (both lenses): deferred-fee awaiting->settled currency switch compares presentment cents with settlement cents
    (`src/connect/fees/charge-settlement.service.ts` :687-691 with :1421-1455 and the claim's currency rewrite :722). Rule: take
    row.refunded_cents into the max only when row.currency equals the settlement currency; otherwise derive succeeded refunds in the
    settlement currency from the list (as before round 13); list unreadable -> stay awaiting, nothing moved. Verify the two CAD->USD
    deferred cases pay USD 56.40, store 2000 USD, reconcile to zero drift after retry/replay; same-currency, changed-FX higher/lower,
    pending/failed refund and head-coach controls; late converted refund notices unchanged.
  - Sol B-683-5 (Opus rates C; fix it, it is cheap and a Sol B): never clear a retry flag raised by the current run (propagate the
    notice-recording failure, or clear with a CAS on the observed flag value). Verify same-instant failure keeps retry authority and a
    later sweep creates the notice once with no second reversal.
  - Replay every prior probe: Sol's spec `test/aud-sol-f23-117-settlement-boundaries.spec.ts` (parent of commit
    80ca936a2f1443f91f8140f094fd09d9ca5f1943; `git fetch origin <sha>`), audit/AUD-SOL-F34-117/{683-boundaries,683-boundaries-v2,
    684-refunds,684-refunds-budget}, and the round-13/14 probes named in the #683/#684 verdict threads. #683 stays red by design with
    exactly 3 suites / 9 tests (state the run).
  - FREEZE: C-683-4 (both lenses' different C-683-4s), Sol C-683-6 = Opus C-683-5, C-682-5/6/7 go to your report as follow-ups.
- Then merge-only restack #684 -> #697 -> #685 -> #686 (no content edits; if a conflict forces one, that piece gets a FIX ROUND with
  failing-before evidence). Post `FIX ROUND <k> (merge-only restack ...)` + READY on each at green heads. Release the lock and write
  notify/fees.txt: "fees top: #686 @ <sha> (B-FEES15-118, <time>)". Do not touch #678-#701.
Report: ops/reports/B-FEES15-118.md.

## B-RECUR6A-118 (builder, Claude Opus 5.5, T4) — recurring R1 #678 + R2 #679 (MOST CRITICAL OF ALL)
Heads: #678 b04ea692 (base fees F6 #686), #679 6760ee6a. Above them (NOT yours): #680 9621457e, #696 5225e078, #701 67905b43; a
second builder (B-RECUR6B-118) takes #680/#696/#701 after you end. Take lock `recur` while you push.
- #678: Sol APPROVE 0/0/0 at b04ea692 (5977830820); Opus APPROVE 0/0/1 at 0c2191c0 (old, 5977231057).
- #679: Sol RC 0/3/1 at 6760ee6a (5977831040): B-679-7 pre-send marker does not fence account finalization (delete during
  post-claim/pre-reply still sends a paid create); B-679-8 unknown rejected-bind cleanup releases the one-subscription exclusion;
  B-679-10 a null pending SetupIntent (Stripe returns none when the customer already has a default card) makes an eligible native trial
  unavailable or permanently confirming. B-679-10 is the "clients with a saved card cannot start a trial" gap from the handoff: fix it
  with more functionality, never less (attempt-owned SetupIntent presented in the native sheet; lift the trial end only on that
  intent's success; one trial per client per coach; a customer default card is never this attempt's consent). C-679-3 -> report.
  Opus RC 0/2/1 at f48fa8f0 (5977231156): Sol says Opus B-679-8/9 are closed at round 5; confirm with the tests.
- Dead Opus lens AUD-OPUS-R12R5-117 left probes on audit/AUD-OPUS-R12R5-117/679-probes (commit 86ebd91a on 6760ee6a; lane run
  37187184830, 2 failed at head): "Opus B-679-10 a client whose customer already has a default card and a trial package can start the
  plan: no SETUP_UNAVAILABLE on a first or a later attempt" and "Opus B-678-2 the generic default-card update carries the trial-end
  lift: a default-card update on a paid plan never touches cancel_at_period_end". Treat both as findings: verify, fix (#678 for
  B-678-2), and make those probes pass.
- Replay every prior probe from both lenses on #678/#679 (threads + audit/* branches) and do the money self-check (_COMMON_118 6).
- If notify/fees.txt shows a new fees top while you work, merge it into #678 then #679 (merge-only) before your final push.
- When #678 and #679 are READY at green heads: write notify/recur.txt "recur R2 top: #679 @ <sha> (B-RECUR6A-118, <time>)", release
  the lock, END. Do not touch #680/#696/#701.
Report: ops/reports/B-RECUR6A-118.md.

## AUD-OPUS-T23-118 (Claude Opus 5.5) / AUD-SOL-T23-118 (GPT-6.1 Sol) — trials T2 #672 and T3 #673
#672 @ c5e7ed8e35f1e5b88653e5605dded2af8614182d (FIX ROUND 8 READY 5977736892; 2,977 lines), #673 @
df76889fb862095170498dccb23f35db3d116690 (FIX ROUND 8 READY 5977778572; 2,627 lines over T2). Base T1 #671 c75002c9 has dual APPROVE.
Prior at 6ce54002: Opus APPROVE 0/0/6, Sol RC 0/2/1 (B-672-3 superseded trial warnings; B-672-4 email requests across timeout/retry).
Decide your lens's prior findings first, then audit both rounds deeply. The builder says two Opus probes stay red by design (C-672-7
date wording per the ruling "Oct 13 at 12:30 AM EDT"; C-671-4 direct view probe because T1 is unchanged and T3's writer holds the
contract): Opus decides that with evidence. Binding: real free trials (coach sets 0-30 days, card up front, one per client per coach,
trial-ending notice), MRR/churned_30d exclude never-billed trials. Landing context: trials land after recurring (#678-#701) and carry the
C-656-1 #680 integration list then; mobile #338 pairs. Findings about recurring code go to your report, not to these PRs.
Reports: ops/reports/AUD-OPUS-T23-118.md, AUD-SOL-T23-118.md.

## B-CM4-118 (builder, Claude Opus 5.5, T4) — coach Money M1 #674 + M3 #676 (+ M4 #677 merge-only/test move): FINISH B-CM3-117's round
B-CM3-117 died after pushing, before any comment. A push with no FIX ROUND comment is unfinished work: trust nothing until checked.
Pushed: #674 39653f80 (fcf640ed tests B-674-11 fair chargeback sweep + B-674-12 one first close; a1d6a9a7 fix; 39653f80 moves
refund-reversal-boundaries spec to #677 for size); #676 fbd6402c (c2524b2a restack merge; b1775673 test B-676-3; fbd6402c fix: tax
CSV rows from refund and chargeback events); #677 ed1546b6 (211e0eb5 restack; e9db27d7 spec moved, byte-identical; ed1546b6 service
mock answers chargeRefund.findMany). Failing-before lane runs it left: ci/B-CM3-117-674-before (runs 37186748565, 37186763956),
ci/B-CM3-117-676-before (run 37187188812).
Findings to close (read every comment): Sol RC 0/2/2 on #674 at 5bbcc92a (5977398163); Sol RC 0/1/1 on #676 at 54e61566 (5977398126);
earlier Opus RC on #674 (5976743131) and #676 (5976743259) were answered by FIX ROUND 2: confirm each closure. #677: Opus APPROVE 0/0/1,
Sol APPROVE 0/0/1 (older heads). Do: verify every pushed commit against its finding's fix rule and counterexample (owner-only authz,
reversal idempotency, coach-visible money equal to the ledger to the cent, MRR rule); check the failing-before runs fail for the
stated reason and the after runs pass; fix any gap; replay prior probes; money self-check. Sizes: #676 2,981 and #677 2,918 lines:
stay under 3,000. Post FIX ROUND 3 on #674 and #676 and a merge-only/test-move FIX ROUND on #677, each + READY at green heads.
Report: ops/reports/B-CM4-118.md.

## AUD-OPUS-FU1-118 / AUD-SOL-FU1-118 — #698 (data export order + keyset paging) and #699 (SBOM dependency check fails closed)
#698 @ ecf8da57 (base main; READY; 467 lines): deterministic latest request (tiebreaker) and keyset export pages (>500 rows could repeat
or miss). T4: privacy export completeness. #699 @ 40ce1757 (base main; READY; 221 lines): CI gate (T4: enforcement boundary; prove it
fails closed with a negative case). Reports: ops/reports/AUD-OPUS-FU1-118.md, AUD-SOL-FU1-118.md.

## AUD-OPUS-FU2-118 / AUD-SOL-FU2-118 — #700 (no emails/names/free text in logs; Apple steps iOS 18+) and mobile #368
#700 @ 66569a61 (base main; READY 05:57 PDT; 936 lines; T4 PII/logging + public privacy text). mobile #368 @ 2216ad1d (base main;
112 lines; DeleteAccountScreen "Apple Account" name and iOS-version-accurate steps). Every public sentence must be true of the code
and of Apple's current flow; the backend policy text (#611, live) and the mobile copy must say the same thing. Reports:
ops/reports/AUD-OPUS-FU2-118.md, AUD-SOL-FU2-118.md.

## B-SHEET-118 (builder, Claude Opus 5.5, T4) — mobile payment sheet P1 #342 + P2 #343 (+ P3 #344 merge-only restack)
Heads: #342 72821495 (base main, BEHIND), #343 af984441, #344 f629e0f9. Lands with recurring (backend #678-#701) and must work
against today's production backend too (guide rule 5: capability check or truthful fallback). Findings: #342 Sol RC 0/2/1
(mobile 5976926407), Opus RC 0/1/3 (5977006434; B-342-1 "nothing was charged" copy on unconfirmed codes); #343 Sol RC 0/5/0
(5976959713), Opus RC 0/1/2 (5977006549; B-343-1 "Payment received" before proof). Also map #661's reply codes (backend #661 @
c7649169 FIX ROUND 7 lists them) and the recurring codes (PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE, trial setup) to specific,
truthful copy with a working next action. Copy truth is the core: never claim charged/not charged/paid before proof. Recurring is
never one-time-only. Bring #342 up to main (merge-only) first. Restack #344 merge-only. FIX ROUND + READY on each at green heads.
Report: ops/reports/B-SHEET-118.md.

## AUD-OPUS-D12-118 / AUD-SOL-D12-118 — dunning D1 #687 and D2 #688
#687 @ f8e47bf4 (base main, BEHIND; FIX ROUND 1 READY), #688 @ b17f514c (FIX ROUND 2 READY). Prior at c2a901a8 (#687): Sol RC
(5975856225), Opus RC (5975919378); at 6627044c (#688): Sol RC 0/5/0 (5975856430), Opus RC 0/1/4 (5975919515). Decide each prior
finding (closing commit + failing-before test), then audit both heads deeply. Binding dunning rulings: retries Days 1/3/7; Day-10
lockout; 1A card update during dunning auto-charges the open invoice and unlocks on success; 2A cancel during dunning voids the invoice
and ends access now; voluntary cancel keeps access to period end; free/code grants never enter dunning. Check the D1 email copy "your
access stays on" against the Day-10 lockout (copy truth). Never-entitled check is unified by dunning (lands second vs #654/#628).
Reports: ops/reports/AUD-OPUS-D12-118.md, AUD-SOL-D12-118.md.

## B-WIZ-118 (builder, Claude Opus 5.5, T4: Stripe Connect onboarding, money setup) — mobile coach setup W1 #345 + W2 #346 (+ W3 #347 restack)
Heads: #345 a4e49588 (base main, BEHIND), #346 4522eb8e, #347 ea2c72d1. Findings: #345 Sol RC 0/3/0 (mobile 5976946494), Opus RC
0/2/3 (5977036236; B-345-1 cadence change dropped; B-329-5 create after unmount/account change); #346 Sol RC 0/2/1 (5976966221),
Opus RC 0/2/3 (5977036337). Must work against today's production backend (coach backend #674-#677 is not deployed yet: capability
check or truthful fallback). Bring #345 up to main (merge-only) first; restack #347 merge-only. FIX ROUND + READY at green heads.
Report: ops/reports/B-WIZ-118.md.

## AUD-OPUS-661-118 (Claude Opus 5.5) / AUD-SOL-661-118 (GPT-6.1 Sol) — #661 PaymentSheet + #702 (its tests-only piece)
#661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2 (base main; 2,843 lines) and #702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb (base
#661's branch agent/clinic/b-secrets-3; 513 lines). They land as one (rule 11). Operator FIX ROUND 8 moved one whole spec byte-identical
from #661 to #702 for size (B 5982239187, 5982239336); integrated tree unchanged from 5c25122d. Content statement: FIX ROUND 7
(5977850515) closing Sol B-661-3 (Sol RC 0/1/0 at c7ee15f0, 5977638148: ten never-activated rows hide the activated owner); #702
OPENING (5977876193). Opus's last APPROVE is old (957e3677). Dead Sol lens AUD-SOL-661R6-117 left probes on
audit/AUD-SOL-661R6-117/{661-selection,661-native-selection,661-native-verified}. Binding: hosted Checkout activates only via
checkout.session.completed; #661 also edits .github/workflows/ci.yml (CI gate, T4). Required checks may still be running when you start:
re-check them and the head right before posting. Recurring and the mobile sheet depend on #661's reply codes: name them in your report.
Reports: ops/reports/AUD-OPUS-661-118.md, AUD-SOL-661-118.md.

## B-LOCK-118 (builder, Claude Opus 5.5, T4: billing lockout, entitlement UI) — mobile lockout L1 #352 + L2 #353 (+ L3 #354 restack)
Heads: #352 58b80914 (base main, BEHIND), #353 e22acc84, #354 37ed3d56. Findings: #352 Opus APPROVE 0/0/6 (mobile 5977022730), Sol RC
0/1/0 (5976926738); #353 Opus RC 0/4/5 (5977022872), Sol RC 0/3/3 (5976938374). Lands after the dunning backend (#687-#691) deploys,
with the lockout flag off; must behave truthfully against today's production backend (capability check or truthful fallback, never a
lockout the server did not decide). Dunning rulings (JOBS118 D12 entry) bind the copy: retries Days 1/3/7, Day-10 lockout, card update
during dunning auto-charges and unlocks on success, cancel during dunning ends access now, voluntary cancel keeps access to period end,
free/code grants never enter dunning. Bring #352 up to main (merge-only) first; restack #354 merge-only. FIX ROUND + READY at green heads.
Report: ops/reports/B-LOCK-118.md.

## AUD-OPUS-D34-118 / AUD-SOL-D34-118 — dunning D3 #689 and D4 #690
#689 @ bb992fedf0095446f916f3261742bd262c3d94da (base D2 #688's branch; FIX ROUND 2 READY; 2,913 lines; inert client billing service
and reconciler), #690 @ 06307883100ec142aa2818fc30ee276cab26c1ec (base #689's branch; FIX ROUND 2 READY; 2,913 lines; billing
endpoints, lockout guard, webhooks, wiring). Prior: #689 Sol RC at 9e77159a (5975999246), Opus RC (5976089521); #690 Sol RC at
f72668c2 (5975999417), Opus RC (5976089623). Decide each prior finding of your lens first (closing commit + failing-before test), then
audit both heads deeply. Old red check runs in the rollup are superseded; judge the latest run per check. Binding dunning rulings are in
the D12 entry above (retries Days 1/3/7; Day-10 lockout; 1A card update auto-charges and unlocks on success; 2A cancel during dunning
voids and ends access now; voluntary cancel keeps access to period end; free/code grants never enter dunning; cancel during a dispute
cycle ends access now and never resolves the dispute). Webhook order/redelivery and lock order are the core risks. D1/D2 (#687/#688)
are being audited by AUD-*-D12-118: findings in D1/D2 code go to your report, not to these PRs.
Reports: ops/reports/AUD-OPUS-D34-118.md, AUD-SOL-D34-118.md.

## AUD-OPUS-H23-118 / AUD-SOL-H23-118 — mobile Health Connect H2 #360 and H3 #361 (T4: health data)
mobile #360 @ fde1875edc1bd5d14ac8fda4f2e68ee8b7c5ebf5 (base H1 #359's branch; #359 has dual APPROVE; 2,812 lines; HealthKit and
Health Connect sync services; FIX ROUND 1 READY), #361 @ 574b32a8ab9f2c36986c160de257340fa71cfe52 (base #360's branch; 1,793 lines;
on-device sync, copy, disconnect dialog; FIX ROUND 1 READY). Prior at 4a508d8b (#360): Opus APPROVE 0/0/2 (mobile 5976279445), Sol RC
0/1/0 (5976328100): decide your lens's prior findings first. The stack H1-H6 (#359-#364) lands as one behind the flag (off), then the
flag flips; late-data and resumable import (C-360-1/2) are a ruled follow-up before the clinic Android build, not a blocker here. Check
health data minimization, permission truth (what is read, when, and what the copy says), identity/session fences (account switch
mid-sync), and that no raw provider error or health value reaches logs (known spot: useWearableConnections.ts:120 raw error log).
Never name the clinic partner. Reports: ops/reports/AUD-OPUS-H23-118.md, AUD-SOL-H23-118.md.

## AUD-OPUS-H45-118 / AUD-SOL-H45-118 — mobile Health Connect H4 #362 and H5 #363 (T4: health data)
mobile #362 @ 439937c93ca8460aed23daef116aa49e7127efa3 (base H3 #361's branch; 2,284 lines; connect sheet and wearables screens; FIX
ROUND 1 READY), #363 @ 38ea0f81fd88ea343ac2279097e8d24f08ef3cc5 (base #362's branch; 982 lines; connect sheet race and identity suites;
FIX ROUND 1 READY). No verdicts at these heads. Same stack rules and checks as the H23 entry above (flag off, land as one, permission
and copy truth, identity fences across account switch, no raw provider errors or health values in logs). H2/H3 are audited by
AUD-*-H23-118: findings in their code go to your report. Reports: ops/reports/AUD-OPUS-H45-118.md, AUD-SOL-H45-118.md.

## B-PRIVFU2-118 (builder, Claude Opus 5.5, T4: PII in logs, public privacy copy) — backend #700 + mobile #368
Heads: backend #700 66569a616fed254e2d5022bbc277013e4652788b (base main; main moved to 2af682ca: merge main first, merge-only), mobile
#368 2216ad1dc94d280e33a39a3ae2d8b7ac197c16dc (base main). Both lenses REQUEST CHANGES:
- #700: Sol RC 0/2/1 (B 5982324455): names/free text survive error redaction; webhook event/key tokens expose private names; C-700-1
  (Sol) encoded emails in finance-federation path logs. Opus RC 0/2/5 (5982447222): B-700-1 coach-brief.service.ts:1482-1511 logs the
  coach's full name and the static guard misses that variable shape; B-700-2 emails reach logs via auth.service.ts:879 and :1474
  (Supabase error text repeats the address) and finance-admin.client.ts:166-167 (URL path with the encoded address). Opus Cs: C-700-1
  owner free-text reason logged (needs a migration: NOT in this round), C-700-2 raw exception text logged, C-700-3 names in provider
  error text not redacted, C-700-4 calorie values logged (separate decision: NOT in this round), C-700-5 webhook log has no allow-list of
  event names/keys. Fix both lenses' Bs; C-700-2, C-700-3 and C-700-5 are the same lines as the Bs: fix them too. Make the static guard
  catch the shapes both lenses' probes used (replay ops/aud-118/AUD-OPUS-FU2-118/probes/ and ops/aud-118/AUD-SOL-FU2-118/).
- #368: Sol RC 0/1/0 (mobile 5982340884) and Opus RC 0/1/3 (5982447325): B-368-1 the new Apple note promises an outcome card after
  deletion, but none appears when provider discovery is unavailable or revocation is unrequested/unknown. Fix with truthful copy for
  every outcome (C-368-1: the fallback card states removal is unconfirmed). C-368-2 (first person at :80, :138) and C-368-3 ("Apple ID"
  and first person in sign-in copy) break the owner's standing copy rule (no first person; "Apple Account"): fix them in this round.
  The mobile copy and the live backend policy text (#611) must say the same thing.
FIX ROUND + READY on both at green heads. Sizes small. Report: ops/reports/B-PRIVFU2-118.md.

## B-TR3-118 (builder, Claude Opus 5.5, T4: free trials, money, notices) — trials T2 #672 + T3 #673
Heads: #672 c5e7ed8e35f1e5b88653e5605dded2af8614182d (base T1 #671 c75002c9, dual APPROVE, do not touch), #673
df76889fb862095170498dccb23f35db3d116690. Opus APPROVE on both (#672 0/0/5 B 5982465734; #673 0/0/3 5982465887). Sol REQUEST CHANGES:
- #672 0/1/1 (5982319373): B-672-3 remains: an extension or cancellation during push preparation permits obsolete charge/date copy.
- #673 0/1/2 (5982336690): B-673-1 (new): cancellation retries can delete an already-paid subscription when its conversion webhook is
  delayed or missing. Sol's optional duplicate-cancellation clock fix sits on the same lines: fold it in.
Same-line Opus Cs to fold in only if they are the same code as a B fix: C-672-11 (a stale trial_will_end writes a "will be charged"
in-app row), C-673-2 (an older retried event rewrites an extended trial end). Everything else (C-672-10, C-673-1, carried C-672-3/5/6b)
goes to your report. C-673-3 (coach metrics count never-billed trials in MRR/churn; binding ruling) is outside these diffs: it goes on
the #680 integration list, not here.
SIZE: #672 is at 2,977 lines (23 lines headroom). New tests go to #673; if the #672 source fix needs room, move an existing whole test
file from #672 to #673 byte-identical (add it after the merge so restacks cannot delete it) and say so. Replay every prior probe from
both lenses (#672 probes run 37218788517, #673 probes run 37219356220, Sol runs 37218265800/37218424769; Opus's red-by-design C-672-7 and
C-671-4 probes stay as ruled). Money self-check per _COMMON_118 6. FIX ROUND + READY on both at green heads.
Report: ops/reports/B-TR3-118.md.

## B-DUNA-118 (builder, Claude Opus 5.5, T4: dunning, billing lockout, money copy) — dunning D1 #687 + D2 #688
Heads: #687 f8e47bf40fe81064d679fc2831cedf3b1cd90b2c (base main, BEHIND: merge main first, merge-only), #688
b17f514ccd8da195d18588ca4b7ca407a789f20e (base #687's branch). Take lock `dunning`. Both lenses REQUEST CHANGES:
- Sol #687 0/2/0 (5982357490): rejected Expo push tickets are recorded as "sent"; the email promises payment/access before success.
- Sol #688 0/2/0 (5982357473): a historical lost-dispute replay blocks later recovery; null-first capped selection hides a lock.
- Opus #687 0/1/3 (5982478903): B-687-5 reversed-payment emails tell clients a card update pays the debt and keeps access; it does neither.
  Fix the main dispute-cycle copy in the same round.
- Opus #688 0/2/3 (5982479051): B-688-6 a stale sweep worker can lock a just-reopened cycle on Day 0 with no notices sent; B-688-7 the
  Day-1 client email shows a raw `{cardLast4}` and the Day-7 coach email shows `{reason}` four times.
- Same-line Cs to fold in: C-687-6, C-688-10. Other Cs (C-687-7, C-688-8, C-688-9) go to your report. C-687-4 stays a note (OR-113-4:
  pending migration prefixes keep their numbers).
SIZE: #688 is at 2,926 lines (74 headroom): put the B-688-7 template fallback in D1 (#687) as Opus recommends; new D2 tests may go to
D5 (#691, tests-only) only if D2 would pass 3,000 (byte-identical moves, add after the merge). Copy truth is binding (dunning rulings in the
D12 entry): never promise access, payment or a charge before it is true. Replay every prior probe from both lenses
(ops/aud-118/AUD-SOL-D12-118/, ops/aud-118/AUD-OPUS-D12-118/, earlier verdict threads). Money self-check per _COMMON_118 6. Do NOT touch
D3-D5 (#689-#691): AUD-*-D34-118 found 9+ Bs there and a second builder (B-DUNB-118) takes them after you; findings you see in D3/D4 code go
to your report. FIX ROUND + READY on #687 and #688 at green heads; write notify/dunning.txt "dunning D2 top: #688 @ <sha> (B-DUNA-118,
<time>)"; release the lock. Report: ops/reports/B-DUNA-118.md.

## AUD-OPUS-H6-118 / AUD-SOL-H6-118 — mobile Health Connect H6 #364 (T4: health data; top of the HC stack)
mobile #364 @ a3206441d57ea51130490e6e54cc8228bff40687 (base H5 #363's branch; 2,882 lines; retire Samsung Health, ingest contract
test; FIX ROUND 1 READY). No verdicts at this head. Same stack rules as the H23 entry (flag off, land H1-H6 as one, permission and copy
truth, identity fences, no raw provider errors or health values in logs). Check that retiring Samsung Health removes every code path,
permission, copy line and stored connection state (existing users with a Samsung connection must see a truthful state, not a broken
one), and that the ingest contract test pins the backend contract production serves today. Also judge the H1-H6 integrated top here
(the landed tree is this head's tree). Reports: ops/reports/AUD-OPUS-H6-118.md, AUD-SOL-H6-118.md.

## AUD-OPUS-SH-118 / AUD-SOL-SH-118 — mobile payment sheet P1 #342 + P2 #343 (T4: money copy, payment flow)
mobile #342 @ 56f281ad3aa977882c962a6591d3594899cdd5a1 (base main; 2,018 lines) and #343 @ fd739d5819c232764e0389afd778860bf452b41c
(base #342's branch; 2,813 lines). B-SHEET-118 FIX ROUND 1 + READY (5982491578, 5982491752); report ops/reports/B-SHEET-118.md.
Prior verdicts to re-check closed: #342 Sol RC 0/2/1 (5976926407), Opus RC 0/1/3 (5977006434; B-342-1 "nothing was charged" on
unconfirmed codes); #343 Sol RC 0/5/0 (5976959713), Opus RC 0/1/2 (5977006549; B-343-1 "Payment received" before proof). Opus's
C-342-1 probe stays red by design (C held under the freeze). Lands with recurring (backend #678-#701) and must work against TODAY's
production backend too (no subscription-intent route there: capability check or truthful fallback, never a dead end). Check the reply
codes from backend #661 (409 PAYMENT_ALREADY_COMPLETE, PAYMENT_REFUNDED_OR_IN_REVIEW, PAYMENT_CHECKOUT_CLOSED; 503 PAYMENT_IN_PROGRESS;
PAYMENT_SUCCESS_RETRY / PAYMENT_FAILURE_RETRY) and the recurring codes (PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE, trial setup) each
map to specific, truthful copy with a working next action; trial starts never show payment-complete copy; never claim
charged/not charged/paid before proof; recurring is never one-time-only; no first person in copy. P3 #344 (e7fcc5d2) gets its own pair
later. Reports: ops/reports/AUD-OPUS-SH-118.md, AUD-SOL-SH-118.md.

## B-HC4-118 (builder, Claude Opus 5.5, T4: health data, permissions, copy truth) — mobile Health Connect H4 #362 (+ merge-only restack H5 #363, H6 #364)
Heads: #362 439937c93ca8460aed23daef116aa49e7127efa3 (base H3 #361 574b32a8, dual APPROVE: do not touch), #363 38ea0f81 (dual APPROVE
0/0/1; restack merge-only), #364 a3206441 (lenses AUD-*-H6-118 auditing it now; the operator forwards their Bs to you). Take lock `hc`.
Both lenses REQUEST CHANGES on #362; their IDs collide, so close the UNION (mapping in ops/reports/AUD-OPUS-H45-118.md):
- Sol 0/4/1 (5982471782): raw retirement-error logging; a stale account-A disconnect deletes account B's authorization; health reads
  continue after disconnect; empty-import guidance dismissed by the real parent.
- Opus 0/2/4 (5982561308): B-362-1 a first import that brings in nothing closes the sheet as if it worked (no "where to check" message;
  on iPhone this is what every category off looks like); B-362-2 Android "access is turned off" notice says "Then tap Try again" but
  no Try again button exists.
- Same-line Cs to fold in: C-362-1 (raw error to the dev logger at useWearableConnections.ts:120), C-362-2 (403 notice says "Tap
  Continue" but the button reads "Reconnect"), C-362-3 (Disconnect does not stop a running import). C-362-4 (connect sheet "We'll
  read..." first person + incomplete list, outside the diff) and the H3 copy at onDeviceCopy.ts:216-217 go to the pre-flag-flip copy PR,
  not here. C-363-1 (wrong mock field name) only if #363 needs a commit anyway.
Replay both lenses' probes (ops/aud-118/AUD-SOL-H45-118/, ops/aud-118/AUD-OPUS-H45-118/probes/; runs 37219439582, 37220060376,
37220188407). Stack rules from the H23 entry (flag off, land H1-H6 as one, identity fences, no raw provider errors or health values in
logs, permission and copy truth, no first person). Sizes: stay under 3,000 per PR. FIX ROUND + READY on #362; merge-only restack #363 and
#364 with READY (restack) comments; write notify/hc.txt "hc top: #364 @ <sha> (B-HC4-118, <time>)"; release the lock.
Report: ops/reports/B-HC4-118.md.

## AUD-OPUS-SH3-118 / AUD-SOL-SH3-118 — mobile payment sheet P3 #344 (T4: money copy)
mobile #344 @ e7fcc5d2504e8c3948494ee847e16ff4937b78c3 (base #343's branch; 2,086 lines). B-SHEET-118 restack + READY (5982498620): not
merge-only; one test-only commit moves two trial fixtures from a fixed 2026-10-10 to today + 7 because the B-343-4 fix asks the client
to review a trial date that differs from the one shown (operator accepted the commit; judge it). Same rules as the SH entry (copy truth,
#661 and recurring reply codes, today's production backend fallback, recurring never one-time-only, no first person). Find #344's
prior verdicts in its thread and check them closed. Reports: ops/reports/AUD-OPUS-SH3-118.md, AUD-SOL-SH3-118.md.

## QUEUED (operator launches as slots free, in this order)
B-DUNB-118 (after B-DUNA-118 ends): D3 #689 bb992fed + D4 #690 06307883 (both 2,913 lines). Sol RC #689 0/4/0 (5982476834: post-lock
dispute resolution, cancellation authority, out-of-band selection, lock order) and #690 0/5/1 (5982476848: invoice resurrection, dispute
serialization, unpaid grace, failure/cancel race, acknowledged persistence failure); Opus RC #689 0/1/2 (5982575687: B-689-5
client-billing.service.ts:323-330 reversed amount from the last failed renewal, not the disputed charge; minimal fix show no amount, probe
P3 failing-before) and APPROVE #690 0/0/3 (5982575812). Same-line Cs: C-690-6 lock-order inversion checkout-webhook-handler:891-904 (same
as Sol lock order B), C-690-7 payment-failed check/write not atomic (same as Sol failure/cancel race). Others to report: C-689-3, C-689-4,
C-690-5, C-690-2 (Sol). Restack on B-DUNA's D2 top first. Then dunning lens pairs on D1-D4 + D5 (#691 + #642).
B-RECUR6B-118 (#680 + #696/#701 after B-RECUR6A ends; dead Sol lens AUD-SOL-R34R5-117 probes on audit/AUD-SOL-R34R5-117/680-authority,
run 37187197172: B-680-2 residual, B-680-5 x2); fees lens pairs (F2+F3, F4+F4b,
F5+F6 deltas) after B-FEES15; recurring lens pairs after B-RECUR6B; coach pair after B-CM4; AUD pair D5 (#691 + #642); HC pair H6 (mobile #360-#364); wizard pair; N1-N4.
