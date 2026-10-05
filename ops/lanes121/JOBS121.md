# JOBS121 — agent 121 wave 1 (owner EXECUTE 12:35 PDT 10-05; 15 slots). Read _COMMON_121.md first, then ONLY your entry.
Background for every entry: the matching agent 120 entry in TGP_SOURCE_OF_TRUTH.md section A9.2 (named below) and the reports it cites
in /home/user/workspace/ops/reports/. Heads verified by the operator at 12:36 PDT. b = growth-project-backend, m = growth-project-mobile.

## Lens pairs (Claude Opus 5.5 + GPT-6.1 Sol, independent; T4)

### AUD-OPUS-CM10-121 / AUD-SOL-CM10-121 — coach stack delta at FIX ROUND 6 heads (money, Connect transfers/reversals)
Heads: b#674 3a07a0de45f431ca9f1f5b9a2ff1710d554e52cb (base main, behind; 2,995/3,000), #676 fadb2960bdce1c1b700eafc1f9da02c520ea021f
(merge-only restack), #677 e3940bd0aa4f306b5da0ddf707017a33b73de5ed (merge-only restack), #703 ebde8b3b5b499f40974c3f32dc925618c81d2c89
(tests-only, 11-case regression spec). Background: A9.2 "B-CM9-120" and "AUD-*-CM8-120"; ops/reports/B-CM9-120.md,
AUD-OPUS-CM8-120.md, AUD-SOL-CM8-120.md. Verify the fixes for your own lens's CM8 findings (Sol: head-slice publication/recovery, full
owner source-post recovery, prior-operation refund starvation; Opus: B-674-15 own-operation check before computing what is owed) and
B-674-1/B-674-16; replay your CM8 probes in CI lanes; review the full delta since the CM8 heads (e35c37a1 / 0ee4933d / b17888ab /
88940c3f). #676/#677: byte-identity of own content vs their DUAL APPROVE heads (tree check). One verdict comment per PR at the exact head.
After you post, say in your final answer whether #674 can take a main merge as a pure merge-only round (main is about 29 commits ahead).

### AUD-OPUS-PUSH4-121 / AUD-SOL-PUSH4-121 — push notifications #692 + #693 (PII on lock screens, consent, delivery, migration)
Heads: b#692 346cf4a8ee462c8f241de65df6ffda95988257f3 (base main, behind; 910), #693 cc0a167fcf977e1452e8f94f72aa72d83ec648d0 (base #692;
FIX ROUND 6 READY comment 6000796965; 2,965/3,000). Background: A9.2 "AUD-*-PUSH3-120" and "B-PUSH3-120"; ops/reports/B-PUSH2-120.md,
B-PUSH3-120.md. Opus: full PUSH3 lens on #692 and #693 (Opus has no verdict at these heads; replay your PUSH probes; Opus U2/U3 are ruled
Cs). Sol: you already APPROVE #692 at 346cf4a8 (6000373524): do a #693 delta since 53796f1e focused on reopened B-648-8 (lease authority
and token/outbox existence re-checked after the last await, inside the fence; lost lease or erased row = zero provider calls); replay
your PUSH3 probe 1 (the builder's variant counts the replica's own reads: you judge). Rulings: reminder pushes show no name; hidden
behind the in-app twin only if stored within 1 hour; merge #692 then #693 back to back; deploy after #693 with migration 20270307000000.

### AUD-OPUS-SCHA-121 / AUD-SOL-SCHA-121 — scheduling split, first full review (access control, concurrency, schema)
Queue, in order: SCHA = b#712 7fd99dce284405f018c545d31cdc1d3d25432f68 (1/9 foundation, base main), #713 a7c8b33afbac44f3086036eb59ca617809320411,
#714 55dfbdce84b644f2c25826e11040a9ef8b597e0f, #715 8040f14912b9bca649f0578685cc9056fdc9fd84, #716 31318708e96c29b73ae4d1e9eb64fe34f87f6deb;
then SCHB = #717 112e0452a473d2ab7226750a80e03043812a9470, #718 6feb18bb9b259c662230fb1e79ff3a4cddc290ea, #719
c79c3e67efca90eddcdb89f3a2dc5ff0591ce3b2, #720 c2b271936f47ecf1827f7a46607d29add381579f, #653 9a23e3b2471794a1356d9939cc4e06682f1ea7ec.
Background: A9.2 "AUD-*-SCHA-120 and AUD-*-SCHB-120" and "Scheduling day-1 jobs"; ops/reports/B-SPLIT-SCHED-120.md. Judge the stack as a
whole and each piece as safe alone (lands as one train). Verify migration 20270222000000 commutes with the applied 20270301000000 and that
`prisma migrate deploy` applies it on a database already holding 20270301000000 (CI lane). Production preflight already run by the
operator 12:09: 0 overlapping active pairs, 0 inverted ranges. Coaches decide their times (S-AVAIL comes later); no onboarding gate.
Post SCHA verdicts as you finish each PR, then continue with SCHB. If your context runs low, finish the PR in hand, write HANDOFF.

### AUD-OPUS-INV3-121 / AUD-SOL-INV3-121 — invite codes #658, then messaging MSG3 #708-#711
1) b#658 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0 (base main, behind; 2,960/3,000; FIX ROUND 1 5999613642). Background: A9.2
"AUD-*-INV3-120" and "B-INV2-120"; ops/reports/B-INV2-120.md. Prior RC: Opus 5964473420, Sol 5964522757: verify each of your own A/B.
Accepted operator decisions: sub-coaches see only codes they issued; successor_code inside the PR's own unapplied migration;
expected_code required on coach-link rotate; signup records deleted on erasure. 2) Then MSG3: wait until B-MSG-FIN-121 posts READY FOR
AUDIT on b#708-#711 (poll PR comments every 5 minutes, at most 60 minutes; if not READY by then, end with HANDOFF). Background: A9.2
"B-MSG2-120". Full first review of #708 (schema + CoachMessage RLS idempotent block, down.sql marker) and #709-#711 (core service,
actions/inbox, routes); community-live-tests must be green on all four.

## Builders (Claude Opus 5.5)

### B-SPLIT-ROMANCHATS-121 — split m#331 Roman chats (5,067) into pieces under 1,500 and fix its A/B (owner 11:52: FIRST job; day 1)
Head 5b58a1218acb1f5ba15cada8b8eaf8b78c75a058 (branch agent/clinic/roman-chats-mobile, base main, DIRTY: src/services/authActions.ts).
Verdicts: Sol BLOCK at c621770f and again at 5b58a121, Opus RC at c621770f: read all three in full. Background: A9.2 "Roman day-1 jobs".
Merge main into the content first, resolve conflicts once (list every resolved hunk), then split into pieces each under 1,500 changed
lines (tests count), inert/data layer first, then screens, tests with the code they cover; fix every A/B in the piece that owns the code
(say per piece which lines differ from the original and why). Branches agent121/romanchats-split-<k>-<name>, bottom on main, each on the
previous; title "ROMANCHATS split <k>/<N>"; body: tier header, contents, tree-equality proof vs original+main (plus listed fixes), prior
verdict links. Post FIX ROUND 1 (OPENING, B-SPLIT-ROMANCHATS-121, agent 121) + READY FOR AUDIT on each piece; comment on #331 that it is
superseded (do not close it). Binding: Roman chats are kept until the client deletes them or the account; coaches never see client chat
text; notes survive chat deletion; flag EXPO_PUBLIC_FF_ROMAN_CHAT stays as is (operator flips later). Daily-cap pop-up work is NOT yours
(M-ROMANCAP later) unless #331 already contains it.

### B-MSG-FIN-121 — close out B-MSG2 on b#708-#711 (CoachMessage RLS), then mobile inbox M-MSG-121 (day 1)
Heads: #708 80995735bda6b58f15a92a7da5fd657a305f6890 (base main, behind, 554), #709 d03813215e208fb47021dc6723444b7613d157eb (1,141),
#710 ec99aba001033f1fe182c7d91a27024c4d52f5dd (1,092), #711 56cabb77ced80841870cd5f6c64a5b4f0df4e0e9 (388; Schema parity failed because a
runner died in npm ci: rerun the failed job). B-MSG2-120 pushed these at 11:47-11:49 and died before commenting (its drafts are lost).
Background: A9.2 "B-MSG2-120" (rulings D1-D3) and "M-MSG-120". Step 1: verify #708's migration change matches ruling D1 exactly (enable +
force RLS, create production's exact coach_message_participant_access policy only if absent, down.sql drops it only if this migration
created it) and that #709-#711 are pure merge-only restacks (tree check); fix anything wrong. Update #708 from main as a merge-only round
if it stays byte-identical, then restack upward merge-only. All checks green on all four (community-live-tests included). Post FIX ROUND 2
(B-MSG-FIN-121, agent 121) on #708 and RESTACK comments on #709-#711, each ending READY FOR AUDIT. Step 2 (second PR set): M-MSG-121 mobile
inbox on the new routes per A9.2 "M-MSG-120" gaps, on mobile main b79ca594, flag-gated (messaging_core_v2), PRs under 1,500 each, draft
until #708-#711 are approved; READY FOR AUDIT when green.

### B-TR9-121 — trials train: #671 conflict refresh, finish READY over #671-#707 (money, access; stack lock: trials)
Heads: #671 ea7a97409f92a02bae5d10f811870753d9d8c4db (base main, DIRTY: .github/workflows/ci.yml), #672
b0654c805c9ffd530b4cd0c1215fd4ed15bdc0e9 (2,959), #673 14b7a7a28d2d5ebcfcf3d27a0845053057d4e682 (FIX ROUND 12, 2,996/3,000: no room), #706
9567f8bd8373afb333840089b217a6a250079cdd (tests), #707 81ec275680942482fd10e0836dd46967e5e03f74. Background: A9.2 "B-TR8-120", "B-TR7-120";
ops/reports/B-TR8-120.md, B-TR7-120.md. Work: merge main into #671 and resolve ci.yml once (list the hunks), restack #672 -> #707 merge-only
where possible; complete the PR bodies; replay the T5 probes on #707 and all prior lens probes on the train; ONE SHARED TRIAL RULE (one trial
per client per coach, any kind; claimed in the webhook at trial start; only the winning purchase gets the marker; a losing purchase gets no
access and owes a cancellation); Stripe draft fence finalize-then-void accepted. New tests go to #706 (never grow #673). FIX ROUND / RESTACK
comments, READY FOR AUDIT on all five once CI is green. Production native-trial count is 0 (operator read 12:0x).

### B-DUND2D-121 — dunning D2d PR on #705 with the remaining #705 fixes (money, access, disputes; stack lock: dunning)
Heads: #687 d86b31a67e1d89352c3e92dde674cb4d45a25a1a (FR4 READY), #688 2662d01a82c267f00af27566e3984d58fb0996d1, #704
764af2e1df66612c503427016f83c3d1776cfdc0, #705 2a03d7dd1d39e2553df10f4d7e10ecdb025807aa (1,425; IN PROGRESS). Background: A9.2
"B-DUNR2-120" and agent 120 wrap-up notes; ops/reports/B-DUNR2-120.md (D2d plan), AUD-SOL-D6-120.md, AUD-OPUS-D6-120.md. Open: Sol
B-705-2..5, Opus B-705-1..3. Rulings: lost closure leaves a coach-restarted plan's access unchanged; re-buying allowed, restart refuses when
another live plan exists for that package; pause check ignores FEATURE_DUNNING_V2; D2d may add migration 20270318000000 (nullable
DunningState.billing_paused_at, DunningDisputeObligation.restarted_at; additive, down.sql); ClientBillingLease serialization; restart
overlapping an in-flight pause returns billing_busy; re-pause sweep stays behind the flag; R-DISPUTE-PAUSE binding (dispute or inquiry
pauses billing and ends access; coach restarts; full refund on recurring pauses too). New PR on branch agent121/dunning-split-2d-restart-fixes,
base #705, under 1,500. Replay both lenses' D6 probes. FIX ROUND 1 (OPENING ...) + READY FOR AUDIT; note on #705 that its fixes continue
in D2d. The stack lands as one (C-688-12).

### B-HC12-121 — Health Connect follow-up before the clinic build (C-370-2 + C-370-3), then the ingest flag PR (health data)
Mobile main b79ca594 has H1-H8. Background: A9.2 "B-HC12-120"; ops/reports/AUD-OPUS-H9-120.md. PR 1 (mobile, base main, under 1,500):
C-370-2 batch per data type per day and honour 429 Retry-After with resumable progress (backend limit 60/min); C-370-3 dedupe overlapping
sleep sessions per night before posting (probe: 330 + 180 minutes for one night must count once). Failing-before probes in a CI lane,
then green. FIX ROUND 1 (OPENING ...) + READY FOR AUDIT. PR 2 (backend, base main, one line + gate text): set FEATURE_WEARABLES_INGEST_POST
to "true" in .github/fly-env-desired-state.json and update docs/runbooks/launch-flags.md + the gate entry; test/ci/fly-env-manifest.spec.ts
must pass; open as draft with READY FOR AUDIT (the operator applies it later through fly-env-sync; never run any workflow yourself).
Ticket only (no build): backend replace for rewritten Health Connect records (C-370-1).

### B-SPLIT-COACHLESS-121 — split b#657 coachless / featured coach / coach-code redemption (3,184) (auth, money-adjacent; day 1)
Head c25960a8b82ed4dd6bea0b7da9f1d77ce783078d (branch annex/a1-coachless-be, base main, DIRTY: .github/fly-env-desired-state.json,
.github/workflows/ci.yml, docs/runbooks/launch-flags.md). Never reviewed. Background: A9.2 "Annex day-1 jobs" (common split rules) and
"B-SPLIT-COACHLESS-120". Merge main first, resolve once (list hunks), split into pieces under 1,500 (branches agent121/coachless-split-<k>-<name>,
title "COACHLESS split <k>/<N>"), tree-equality proof vs original+main, FIX ROUND 1 (OPENING ...) + READY FOR AUDIT per piece, superseded
comment on #657 (do not close). Overlap rule with #658: whichever lands second maps code_revoked / code_expired / code_exhausted in
ATTACH_TO_COACHLESS. Report the mobile day-1 gaps (file paths) without building them. Flags unchanged.

### B-SPLIT-BCAST-121 — split b#659 broadcasts (3,929) and fix its A/B findings (day 1)
Head fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf (branch annex/a4-broadcasts-be, base main, behind). Opus REQUEST CHANGES (5964501283), Sol
BLOCK (5964574829) at this head: read both in full. Background: A9.2 "Annex day-1 jobs" and "B-SPLIT-BCAST-120". Merge main, split into
pieces under 1,500 (branches agent121/bcast-split-<k>-<name>, title "BCAST split <k>/<N>"), fix every A/B in the piece that owns the code
(per piece: which lines differ from the original and why), failing-before probes for each B, FIX ROUND 1 (OPENING ...) + READY FOR AUDIT
per piece, superseded comment on #659 (do not close). Report mobile day-1 gaps (file paths) without building them. Flags unchanged.

## Wave 1b (owner 12:39: "if sandbox isnt stressed, add more lanes (audits if tight, builders if very open)")

### AUD-OPUS-L3-121 / AUD-SOL-L3-121 — mobile lockout m#352/#353/#354 at FIX ROUND 2 heads (billing lockout, dispute copy; T4)
Heads: m#352 c89f719cd8f5863c4150af1da5b96e273df319d6 (base main, behind; 2,586), #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85 (2,723),
#354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649 (1,119, merge-only restack: tree check of own content). Background: A9.2 "AUD-*-L3-120" and
"B-LOCK2-120"; ops/reports/B-LOCK2-120.md and the prior L-round lens reports. B fixed: B-352-2/3/7, B-353-2/3/6/7. Binding: dispute
(including inquiries) pauses billing and ends access, the coach decides on restarting; a failed refund after access ended alerts the coach
only; Opus B-352-7 forbids "settle" in copy (Sol updates its old 119 probe 1 to the new wording instead of failing for it). Mobile: lenses
run probes only in mobile CI lanes. One verdict per PR at the exact head.

### AUD-OPUS-RA-121 / AUD-SOL-RA-121 — Roman A1 b#667 + A2 b#665, first full review (AI, PII, consent, health data; T4)
Heads: b#667 bacd83e10ff0e00dc5165dd223da8b4745e3c82a (A1 context core, base main, behind, draft; 1,832), #665
eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5 (A2 context, base #667, draft; 2,282). Never reviewed at these heads (parent #651 had RC from both;
read those verdicts for history). Background: A9.2 "Roman day-1 jobs" and agent 120 wrap-up notes; docs/roman-client-context.md in #667;
handoffs/op-115/reports/B-SCHED-ROMAN-115.md (tgp-agent-context). Binding: OR-115-1 neutral roman.safety_route action + restricted reason
code; OR-115-2 crisis templates without box-2 consent; Roman never reads CoachingSession private notes, bloodwork, purchases/invoices or
other users' rows; coaches never see client chat text, Roman memory, prompts or reasoning (owner 11:22); AI chats kept until the client
deletes them or the account. Day-1 requirement (owner 11:40-11:41): every Roman turn debits the coach's CoachAIBudget (src/ai-credits,
recordUsage) AND passes the client daily cap: report where in #667-#670 this happens or that it is missing (a missing debit is a B on
the PR that owns the turn path). Drafts: post verdicts anyway (the operator marks them ready when approved).

### AUD-OPUS-RB-121 / AUD-SOL-RB-121 — Roman B b#666 (safety router + reply post-check) + C1 b#668 (live-turn wiring), first full review (T4)
Heads: b#666 0ec835ca1cc9697bde71e6c67ed627ea3a000691 (base #665, draft; 1,735), #668 fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f (base #666,
draft; 2,159; CI unstable: report which checks fail and whether they are the by-design reds that #669 carries). Same background, bindings and
day-1 AI-budget requirement as the RA entry above (read it). #668 is where live turns are wired: the CoachAIBudget debit + client daily cap
must be on every live turn (crisis turns exempt from the cap); a missing debit is a B here. Owner wording for the daily cap pop-up (mobile,
later job): "You've used your maximum AI allotment today."; backend must return distinct codes for daily cap (ROMAN_CAPACITY_REACHED /
AI_DAILY_QUOTA_EXCEEDED) and coach pool empty.

### AUD-OPUS-RADJ-121 / AUD-SOL-RADJ-121 — Roman approve-to-adjust b#655 + mobile m#337, first full review (T4)
Heads: b#655 bf9120c1178c28b54256d41afed05a25578353f3 (base main, behind; 2,058), m#337 63be101394d996bd4475a8ad86c400925997092c (base main,
behind; 1,051). Never reviewed. Background: A9.2 "Roman day-1 jobs"; TGP_SOURCE_OF_TRUTH A6.4 and A7.2 (Roman v1.1 plan, decisions 1-9).
Binding (owner 11:22): coaches see what Roman wants to do (his proposals) and approve to adjust; never his memory, playbook, prompts or
reasoning, and never client chat text. FEATURE_ROMAN_ADJUST_ENABLED stays off until landed (operator flag PR later). Check consent (box 2)
gating, tenancy (a coach acts only on own clients, sub-coach rules), idempotency of approve/reject, audit trail without health labels in
action names, and truthful mobile copy (no first person, no generic errors).

## Wave 2 builders (12:55)

### B-LOCK3-121 — mobile lockout FIX ROUND 3 on m#352/#353, restack #354 (billing lockout, dispute copy; T4; stack lock: lockout)
Heads: m#352 c89f719cd8f5863c4150af1da5b96e273df319d6, #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85, #354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649.
Sol L3 verdicts (12:51): #352 RC 0/2/2 (6001848621: B-352-3 native PaymentSheet lease through completion/teardown with owner recheck and
operation-session fence; B-352-9 inquiry copy must not claim a bank reversal), #353 RC 0/1/3 (6001849106: B-353-8 same for banner,
lockout screen, UpdateCard), #354 APPROVE 0/0/0. Report ops/reports/AUD-SOL-L3-121.md; probes ops/aud-121/AUD-SOL-L3-121/. Opus L3
(AUD-OPUS-L3-121) is still reviewing: start on Sol's Bs now, poll #352-#354 comments every 5 minutes for the Opus verdict, and fold its
Bs into the same round before you push (if Opus has not posted 40 minutes after you start, push Sol's fixes as FIX ROUND 3 and do Opus's
as FIX ROUND 4). Copy rule: neutral dispute/inquiry wording unless a trusted field proves money was withdrawn; keep the three facts
(access ended, billing paused, coach decides on restarting), no card or automatic fix, never "settle", no first person, no generic errors.
Failing-before probes in a mobile CI lane, then green. Fix round comments + READY FOR AUDIT; #354 restack merge-only. Background: A9.2
"B-LOCK2-120", ops/reports/B-LOCK2-120.md.

### B-ROMAN-AFIX-121 — Roman A1 b#667 + A2 b#665 FIX ROUND 1 (AI, PII, health data; T4; stack lock: roman)
Heads: b#667 bacd83e10ff0e00dc5165dd223da8b4745e3c82a, #665 eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5 (drafts; #666-#670 sit on top: restack
them merge-only after your fixes, never edit their content). Sol RA verdicts (12:5x): #667 RC 0/3/1 (6001851969: exact date of birth
disclosed, incomplete screening marked complete, escaped context exceeding its hard cap), #665 RC 0/4/1 (6001852378: competing-provider
double counting, silent wearable truncation, UTC/local workout-date errors, assignment limits hiding future sessions). Report
ops/reports/AUD-SOL-RA-121.md; probes ops/aud-121/AUD-SOL-RA-121/. Opus RA is still reviewing: start on Sol's Bs, poll for the Opus
verdict every 5 minutes and fold its Bs in before you push (40-minute rule as in B-LOCK3-121). The coach-pool debit and per-client daily
cap belong to #668 (another job), not to you. Keep each PR under its size cap (#665 is 2,282 of 3,000; #667 1,832): new tests go in the
PR that owns the code. Failing-before probes in a backend CI lane. FIX ROUND 1 (OPENING, B-ROMAN-AFIX-121, agent 121) + READY FOR AUDIT;
RESTACK comments on #666-#670. Background: A9.2 "Roman day-1 jobs".

### B-ROMAN-BFIX-121 — Roman B b#666 + C1 b#668 FIX ROUND 1, #669 C2 fix commit, restack #666-#670 (AI, safety, money; T4; roman upper stack)
Heads: b#666 0ec835ca1cc9697bde71e6c67ed627ea3a000691 (1,735), #668 fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f (2,159), #669
6386c00b2bdbb2c120a5f173dea4753574d415e8 (907: failing-before tests only, red by design), #670 fb67101934becfb8536664df008129061c013dde
(1,135, golden-set eval). Split of ownership on the Roman stack: B-ROMAN-AFIX-121 owns #667/#665 content; YOU own #666/#668/#669/#670
content AND their restack: after AFIX posts READY on #665, merge the new #665 head into #666 and restack upward (one push per PR per round).
Sol RB verdicts (12:5x): #666 RC 0/3/1 (6001863666: acute anaphylaxis routing miss, formatted calorie-floor bypass, negated injury-stop
instruction accepted); #668 RC 0/3/1 (6001863676: missing coach-pool gate/debit, wrong client daily quota code, mixed kcal field/date
provenance). Report ops/reports/AUD-SOL-RB-121.md. Also ops/lanes121/notify/AUD-SOL-RA-121-budget-boundary.md: no CoachAIBudgetService
/ recordUsage anywhere in RomanService/RomanModule, and the daily cost cap (roman.service.ts:1183-1255) aggregates all clients instead of
per client. Opus RB is still reviewing: start on Sol's Bs, poll for the Opus verdict every 5 minutes and fold its Bs in before you push
(40-minute rule as in B-LOCK3-121). #669: write the fix commit per handoffs/op-115/reports/B-SCHED-ROMAN-115.md in tgp-agent-context
(source branch agent115/roman-651-r2-wip-unsplit @ 675cf045), including the disclosed T4-gate ci.yml step for the spend-admission live spec;
#669 and #670 go green. Day-1 AI budget (owner 11:40-11:41): every live Roman turn checks and debits the coach's CoachAIBudget (src/ai-credits,
recordUsage) and passes a per-client daily cap; crisis turns exempt from the cap; distinct error codes for client daily cap
(ROMAN_CAPACITY_REACHED for Roman, AI_DAILY_QUOTA_EXCEEDED elsewhere) and coach pool empty; report the configured cap value and env name.
Size: #668 has 841 lines of room and #669 has 2,093 (all grandfathered to 3,000): put tests with the code they cover. Failing-before probes
in a backend CI lane. FIX ROUND 1 (OPENING, B-ROMAN-BFIX-121, agent 121) + READY FOR AUDIT on #666/#668/#669, RESTACK on #670. Flags
unchanged (FEATURE_ROMAN_CHAT_ENABLED stays excluded until the operator's flag PR). Background: A9.2 "Roman day-1 jobs".

## Wave 3 (13:05; sandbox iowait back to 25%, 5.8 GB disk free)

### B-PROG2-121 — mobile programs P1 m#355 + P2 m#356 FIX ROUND (stack lock: programs; parallel with B-PROG4-121)
Heads unchanged since agent 120 wrote the job: #355 902c64a64156255ce9ce54147db896ac2142a954 (base main, behind; 1,716), #356
40ee678adf7a70bdfa18c49cafdbd64a2dc589a5 (1,501). Your job text is A9.2 "B-PROG2-120" in TGP_SOURCE_OF_TRUTH.md (read it word for word;
replace agent 120 with agent 121 and ops/lanes120 with ops/lanes121). Coordination file: ops/lanes121/notify/programs.txt. The backend
409 fix is B-MWB409-121 (running in parallel): mobile reads the fields it will return and fails truthfully until then.

### B-PROG4-121 — mobile programs P3 m#357 + P4 m#358 FIX ROUND (stack lock: programs-p34; parallel with B-PROG2-121)
Heads: #357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381 (2,421), #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 (1,323). Your job text is A9.2
"B-PROG4-120" (word for word; agent 121, ops/lanes121; coordination file ops/lanes121/notify/programs.txt written by B-PROG2-121).

### B-MWB409-121 — backend: keep head index + lock token in MWB autosave/undo 409 replies (T4: API contract, error filter)
Your job text is A9.2 "B-MWB409-120" (word for word; agent 121). New PR on backend main, under 1,500 lines. When READY, write
ops/lanes121/notify/mwb409.txt with the PR number and head so B-PROG2-121 can read the field names.

### B-SCHED-FIX-121 — b#643 (BOOKING_REMINDERS_ENABLED) + m#341 (device time zone, tap opens session, quiet hours) FIX ROUNDS
Heads: b#643 f21b3c632a80037c852f91e5d41e33d31d99ef9e (base main, behind; one manifest line; RC both 5960175016 / 5960179586), m#341
7c791bb3 (base main, behind; 1,966; RC Sol 5972146496 / Opus 5972160274). Background: A9.2 "Scheduling day-1 jobs"; TGP_SOURCE_OF_TRUTH
A7.4 (BOOKING_REMINDERS_ENABLED must be the literal "on"). Read all four verdicts in full and fix every A/B. #643 stays a manifest +
runbook/gate PR (no workflow run by you); it applies only after the scheduling pieces b#712-#720 deploy, so the gate text must say so.
m#341 must work with the new backend scheduling API in b#712-#720 (approved by Sol at 13:01; Opus reviewing). Failing-before probes
in CI lanes. FIX ROUND comments + READY FOR AUDIT. Keep m#341 under 3,000 (grandfathered).

### AUD-OPUS-SCHM1-121 / AUD-SOL-SCHM1-121 — mobile scheduling K1 m#365 + K2 m#366, first full review (T3/T4: booking, time zones)
Heads: m#365 cceeb33a (full sha via gh; base main, behind; 2,025), m#366 fa7744cc (base #365; 1,680). Never reviewed. Background: A9.2
"Scheduling day-1 jobs"; backend API in b#712-#720 (Sol APPROVE all nine 13:01). Binding: coaches decide their times and availability
(owner 10:32); no onboarding gate (owner 10:33); truthful copy when a coach has no bookable types or hours (not an empty picker); no
first person, no generic errors; times shown in the device time zone. Probes only in mobile CI lanes. One verdict per PR at the exact head.

## Wave 4 (13:43; fleet cap 13, credits 28k/45k at 13:37)

### B-SCHED2-121 — scheduling train FIX ROUND: lock-screen privacy (B-714-1, B-653-1) + push-sender routing, in #653 (T4: PII on lock screens)
Train: b#712 7fd99dce -> #713 a7c8b33a -> #714 55dfbdce -> #715 8040f149 -> #716 31318708 -> #717 112e0452 -> #718 6feb18bb -> #719 c79c3e67
-> #720 c2b27193 -> #653 9a23e3b2471794a1356d9939cc4e06682f1ea7ec (full shas via gh). Verdicts: Sol APPROVE #712-#720, RC #653 0/2/1
(6001979762); Opus APPROVE #712/#713/#715-#720, RC #714 0/1/1 (6001957114) and #653 0/2/1 (6002182391). Reports
ops/reports/AUD-SOL-SCHA-121.md, AUD-OPUS-SCHA-121.md. Open Bs: B-714-1 and B-653-1 (booking and expiry pushes put the client's name and
the coach-written session-type name on the lock screen) and Sol's two #653 Bs (stale deadline; duplicate-notice lease: apply the
owner edge-case freeze, _COMMON_121 item 13: fix only if normal use, else list as C). Operator rulings: B-653-2 (missing live-Postgres
test) is C (edge); #653's migration keeps 20270226000000; the train lands as one (A5 rule 11), so fix B-714-1 in #653 (top piece), not
in #714 (no restack of #715-#720 for content); lock-screen copy is generic per notification type, no names, no coach-written text
(standing push ruling: reminder pushes show no name; details only inside the app). Push notifications b#692/#693 land BEFORE this train
(merging when GitHub runs CI): once b#692 is on main, merge main into #712's branch (resolve once, list hunks), restack #713 -> #653
merge-only (one push per PR), and route every booking/expiry push through the push sender from #692/#693 only (no second sender). If b#692
is not on main when your fixes are ready, push the #653 fixes first and do the main merge + routing as a second push when it lands.
Failing-before probes in a backend CI lane. FIX ROUND 1 (OPENING, B-SCHED2-121, agent 121) + READY FOR AUDIT on #653; RESTACK comments
on #712-#720 if restacked; one line on #714 saying B-714-1 is fixed in #653.

### AUD-OPUS-MSG3-121 / AUD-SOL-MSG3-121 — messaging backend b#708-#711, first full review (T4: RLS, messaging) — landing today
Heads: b#708 07d16d82 (schema + CoachMessage RLS, base main), #709 d9cf7ad9 (core service), #710 3572b209 (actions + inbox), #711 db7fa3bf
(routes) — full shas via gh; verify unchanged before posting. Builder report: ops/reports/B-MSG-FIN-121.md (D1 RLS check, tree checks,
local evidence 37/37). Background: TGP_SOURCE_OF_TRUTH A9.2 "B-MSG2-120" (rulings D1-D3). The owner edge-case freeze (_COMMON_121
item 13) applies in full: a B must happen in normal use and touch money, private data, safety, data loss, reachable security, store/legal,
a false claim or a core-flow dead end; everything else is "C (edge, deferred to 10k clients)". Judge the stack as one train (lands as
one, A5 rule 11) and each piece as safe alone. Some required checks may still be queued or re-running because of GitHub's runner
incident: say which, and do not block for queued checks (the operator merges only once they are green). One verdict per PR at the exact
head. Budget: finish within 45 minutes; read-only, one CI lane at most, single-spec heavy.sh fallback after 20 minutes queued.
