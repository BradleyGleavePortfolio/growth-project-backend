# FLEET — agent 120 (times PDT 10-05 from `date`)

Wave 1 launched 09:28 (15 agents; routing: T4 builders Claude Opus 5.5; lens pairs Claude Opus 5.5 + GPT-6.1 Sol)
| Job | Model | Subagent id | PRs | Status |
|---|---|---|---|---|
| AUD-OPUS-661D-120 | claude_opus_5_5 | lens_opus_661_702_muvgroab | b#661 bc399edd, b#702 9ddda117 | running |
| AUD-SOL-661D-120 | gpt_6_1_sol | lens_sol_661_702_muvgroak | b#661, b#702 | running |
| B-CM7-120 | claude_opus_5_5 | builder_coach_stack_muvgroar | b#674 9e8a3a6b, #676, #677, #703 | running |
| B-DUNMR-120 | claude_opus_5_5 | builder_dunning_refresh_muvgroay | b#687 f3c7fd37, #688, #704, #705 | running |
| B-TR7-120 | claude_opus_5_5 | builder_trials_t5_muvgrob4 | b#707 ffed434e, then #671 refresh -> #707 | running |
| B-LOCK2-120 | claude_opus_5_5 | builder_mobile_lockout_muvgrobb | m#352 ac244d22, m#353 05d84f27, m#354 | running |
| AUD-OPUS-H7-120 | claude_opus_5_5 | lens_opus_health_connect_h7_muvgrobh | m#369 3252ec79 | running |
| AUD-SOL-H7-120 | gpt_6_1_sol | lens_sol_health_connect_h7_muvgrobo | m#369, m#362 261e7d4c | running |
| AUD-OPUS-W12D-120 | claude_opus_5_5 | lens_opus_wizard_w1_w2_muvgrobu | m#345 ed29833c, m#346 26cf23b7, m#347 delta | running |
| AUD-SOL-W12D-120 | gpt_6_1_sol | lens_sol_wizard_w1_w2_muvgroc1 | m#345, m#346, m#347 delta | running |
| AUD-OPUS-P12-120 | claude_opus_5_5 | lens_opus_programs_p1_p2_muvgroc7 | m#355 902c64a6, m#356 40ee678a | running |
| AUD-SOL-P12-120 | gpt_6_1_sol | lens_sol_programs_p1_p2_muvgroce | m#355, m#356 | running |
| AUD-OPUS-P34-120 | claude_opus_5_5 | lens_opus_programs_p3_p4_muvgrock | m#357 b364b9ea, m#358 4dcf0aff | running |
| AUD-SOL-P34-120 | gpt_6_1_sol | lens_sol_programs_p3_p4_muvgrocs | m#357, m#358 | running |
| B-HC10-120 | claude_opus_5_5 | builder_health_connect_h8_muvgrod0 | new m PR H8 on #369 | running |

Wave 1 results so far (PDT)
- AUD-SOL-W12D-120 DONE: #345 APPROVE 0/0/0 (5998775552); #346 RC 0/1/2 B-346-3 (5998775024); #347 restack APPROVE (5998774888).
- AUD-SOL-P12-120 DONE: #355 RC 0/1/0 (5998781633); #356 RC 0/2/2 (5998828937).
- AUD-SOL-P34-120 DONE: #357 RC 0/4/1 (5998892359); #358 RC 0/4/0 (5998829473).
- AUD-SOL-661D-120 DONE: #661 RC 0/1/1 B-661-14 (5998892091); #702 APPROVE 0/0/0 (5998892592).
- AUD-SOL-H7-120 DONE: #369 RC 0/1/2 B-369-2 (5998888199); #362 conditional APPROVE 0/0/1 in H1-H7 (5998888651).

Wave 2 launched 09:48-09:50
| AUD-OPUS-PUSH-120 | claude_opus_5_5 | lens_opus_push_p1_p2_muvhei8j | b#692 27156167, b#693 13417e7b | running |
| AUD-SOL-PUSH-120 | gpt_6_1_sol | lens_sol_push_p1_p2_muvhei8s | b#692, b#693 | running |
| B-SPLIT-SCHED-120 | claude_opus_5_5 | split_scheduling_pr_634_muvhei8z | b#634 e18e8055 -> pieces < 1,500 | running |
| B-SPLIT-MSG-120 | claude_opus_5_5 | split_messaging_pr_660_muvhfn22 | b#660 60556485 -> pieces < 1,500 | running |
| B-INV2-120 | claude_opus_5_5 | fix_invite_codes_pr_658_muvhfn2b | b#658 08534e17 | running |

Waiting for a slot (entries ready in JOBS120.md): B-WIZ3-120 and B-PROG2-120 and B-PROG4-120 (after the Opus verdicts), B-661R2-120,
B-HC11-120, B-SPLIT-COACHLESS-120, B-SPLIT-BCAST-120.

Operator actions
- 09:44 deleted 37 leftover ci/* branches from agents up to 119 (owner decision 4); kept ci/fly-deploy-fail-loud-on-missing-token
  (1 unmerged commit from April) and every -120 lane.
- 09:27 RESTACK NOTE posted on b#661 (5998643247) and b#702 (5998643507).
- 09:29 deploy dispatched: backend main ee55f814 (recurring R1-R5) with -f migrations=apply-migrations, fly-deploy run 37341231516;
  09:33 DEPLOYED (success; /health ok; /readyz db up; migrations 20270225000000 + 20270311000000 applied 09:32:52).
  production environment approved 09:29:49.

Queue (next when slots free / gates open)
- #661/#702 dual APPROVE -> merge #702 into b-secrets-3, then #661 to main (match-head) -> main CI -> deploy (no migrations).
- Coach lens pairs (CM-A: #674+#676, CM-B: #677+#703) after B-CM7 READY.
- Dunning lens pairs (D-A: #687+#688, D-B: #704+#705) after B-DUNMR READY; then B-DUNB-120 (#689/#690 onto #705; C-680-18/19 if
  not already in D2; dispute event time as closedAt in D4); then D5 #691 + #642.
- Trials lens pair (#707 FR + #671 refresh delta + restack deltas) after B-TR7 READY; then land T1-T5 as one; then mobile #338.
- C-344-12 gate builder (backend planView locked/dispute_paused on top of #705 + mobile panel copy on top of #344) after B-DUNMR.
- HC: on dual APPROVE of #369 and Sol APPROVE of #362 -> land H1-H7 as one (adapt op119/land_hc.sh) -> lens pair for H8.
- Wizard W3 #347 full review/fix after W12D; money mobile #348-#351 after the coach deploy.
- Sheet m#342-#344: dual APPROVE; HOLD per both lenses' landing rule: lands as one with the recurring deploy, D4 #690, the native
  card-update composition, final-main Analyze, and C-344-12 as the D2c gate.
- Rule 12 candidates (operator): m#312 (approved f8375ca6; head 8016a79e main merge), m#335 641fe891, b#642 4fee3c02.

## 09:47 DRAIN to 7 (owner 09:47): no launches until active <= 7; then cap 7.
- AUD-OPUS-H7-120 DONE 09:52: #369 APPROVE 0/0/2 (5999043389; C-369-4/5). Split with Sol RC -> B-369-2 fix routed 09:53 to the running
  HC builder B-HC10-120 (drain: no new agent), then H8 continues on top.
- AUD-OPUS-W12D-120 DONE 09:5x: #345 APPROVE 0/0/1, #346 APPROVE 0/0/1 (C-346-7 = same lines as Sol B-346-3), #347 restack APPROVE.
  #345 dual APPROVE at ed29833c; #346 split (Sol RC) -> B-WIZ3-120 queued (also W3 #347 known items). Wizard lands with #348-#351 after coach deploy.
- AUD-OPUS-P34-120 DONE: #357 RC 0/1/7 (5999063942), #358 RC 0/2/4 (5999064225). B-358-1 root cause in #355 (B-PROG2). Backend
  FEATURE_MWB_TEMPLATES/AUTOSAVE_UNDO/NAMED_REGIMES are unset in fly-env-desired-state.json: flip PR when programs land (queue).
- AUD-OPUS-P12-120 DONE: #355 RC 0/3/1 (5999100428), #356 RC 0/2/3 (5999100681). Operator accepted defaults: backend 409 fix PR
  (B-MWB409-120 queued), clinic flag flips removed from #355, shared helpers fixed in #355.
- AUD-SOL-PUSH-120 DONE: #692 RC 0/1/0 (5999124539), #693 RC 0/4/2 (5999124426) -> B-PUSH2-120 queued (after Opus push).
- AUD-OPUS-661D-120 DONE: #661 RC 0/1/7 B-661-15 (5999168270, same defect as Sol B-661-14), #702 APPROVE 0/0/1 (5999168870). B-661R2-120 queued first.
- B-CM7-120 DONE 10:0x: #674 e35c37a1, #676 0ee4933d, #677 b17888ab, #703 88940c3f READY (B-CM7-1 fixed). CM8 lens pair queued (one pair, all four).
- B-LOCK2-120 DONE 10:0x: m#352 c89f719c, #353 9d47045b, #354 68c7f080 READY. L3 lens pair queued.
- 10:03 DRAIN REACHED 7 active. Cap 7 from now.
- B-TR7-120 DONE: #707 8fc2660b FR2 READY, #671 ea7a9740 refresh READY, #672 b0654c80 restack READY; #673 restack stopped (recurring conflict) -> B-TR8-120 queued (one shared trial rule, owner asked).
- 10:10 launched B-661R2-120 (fix_661_card_secrets_muvi9io1, claude_opus_5_5). Active 7.
- B-DUNMR-120 DONE: #687 f3c7fd37, #688 21714f7b, #704 49d0b66e, #705 5138947c READY (A C-680-18 fixed). D6 lens pair queued; operator accepted B-DUNMR decisions 1-4.
- 10:13 launched AUD-SOL-CM8-120 (lens_sol_coach_stack_cm8_muvidaez, gpt_6_1_sol). Active 7: Opus push, B-HC10, B-SPLIT-SCHED, B-SPLIT-MSG, B-INV2, B-661R2, Sol CM8. Next slots: Opus CM8, Sol D6, Opus D6, B-PUSH2, L3 pair, B-TR8, B-MWB409, B-PROG2, B-PROG4, B-WIZ3, Roman, annex splits.
- AUD-OPUS-PUSH-120 DONE: #692 APPROVE 0/0/2, #693 RC 0/1/9 (B-693-1 Android channel). 
- 10:14 launched B-PUSH2-120 (fix_push_prs_692_693_muvieja1). Active 7. m#341 (device time zone for quiet hours) noted for day 1 with push (Opus decision 3).
- B-INV2-120 DONE: #658 4de7a6dc FR1 READY (B-658-1/6/7 fixed). INV3 lens pair + M-INV-120 mobile queued; decisions 1-4 accepted.
- 10:28 launched AUD-OPUS-CM8-120 (lens_opus_coach_stack_cm8_muvixfvm). Active 7: B-HC10, B-SPLIT-SCHED, B-SPLIT-MSG, B-661R2, Sol CM8, B-PUSH2, Opus CM8.
- 10:31 owner: scheduling day 1 + S-AVAIL (coach calendar required); shared trial rule; CAP 7 for agent 120.
  Launch queue at cap 7 (next free slot takes the top): Opus D6 -> B-TR8 -> L3 pair -> B-MWB409 -> B-PROG2 -> B-ROMAN-C2 ->
  B-SPLIT-COACHLESS -> B-SPLIT-ROMANCHATS -> B-SCHED-FIX -> Roman RA/RB pairs -> INV3 pair -> B-WIZ3 -> B-PROG4 -> B-SPLIT-BCAST ->
  scheduling lens pairs -> S-AVAIL -> M-INV -> RADJ pair. Builders for stacks that come back RC jump the queue (in-flight before new).
- B-SPLIT-MSG-120 DONE: #708 5c9c6a0e, #709 87f0bfff, #710 47b528ce, #711 5a7c41e8 (tree == #660+main). Prod CoachMessage RLS ON+FORCED (checked 10:38). B-MSG2-120 + M-MSG-120 queued.
- 10:34 launched AUD-OPUS-D6-120. Active 7.
- B-HC10-120 DONE: #369 a2bfe2fa FR2 READY (B-369-2 fixed), #370 c7014623 H8 OPENING READY. H9 lens pair queued (jumps queue: H1-H7 lands on #369 dual approve).
- 10:40 launched AUD-SOL-H9-120 (lens_sol_health_connect_h9_muvjd06r). Active 7: B-SPLIT-SCHED, B-661R2, B-PUSH2, Opus CM8, Sol D6, Opus D6, Sol H9. Next: Opus H9, B-TR8, L3 pair, B-MSG2, B-MWB409, B-PROG2, ...
