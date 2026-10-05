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
