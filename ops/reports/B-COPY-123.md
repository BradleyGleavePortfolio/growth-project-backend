# B-COPY-123 — F4 public pages copy (agent 123)

Builder: Claude Opus 5.5. Started 22:07 PDT 10-05 (time box 30 min, ends 22:37).
PR: growth-project-backend#755 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/755
Branch `agent123/b-copy-public-pages`, head `3076cab9871f8d76bce703f0bd59431d8858b849` (rebased on main 9b78afd5).
One commit, author/committer Bradley Gleave, no co-author. 7 files, +115 / -22.

## Fixed
- B-STORECOPY-2: `src/public-pages/public-pages.html.ts` no-code /signup -> packet copy ("Create an account" + open-signup body), CTA "Contact support" (subject "Signup help"); valid-code branch unchanged. `trust-pages.html.ts` /status bullet -> "signup information and coaching invitations."
- B-STORECOPY-3: `help-pages.html.ts` FAQ question "Is there a coach app?" + packet answer; `docs/help/faq.md` mirror.
- B-PRIVACY-1 policy part (b#747 merged on main): `COMMUNITY_VISIBILITY_TEXT` + `LEADERBOARD_VISIBILITY_TEXT` (S-PRIVACY replacement, verbatim, split in two bullets) used in /privacy "Who can see your data" (kept "Coaches can sort the members ...") and /consumer-health-privacy "Categories we share" (replaces "only the health information you choose to post there").
- m#390 sentence: `COMMUNITY_ZERO_TOLERANCE_TEXT` added to /terms Acceptable use, word for word from CommunityTermsGate.tsx (m#390 head f55cc61b).
- POLICY_LAST_REVIEWED and HELP_LAST_REVIEWED -> 2026-10-05.

## Tests (heavy.sh, one file at a time)
New/updated assertions fail on main src (8 failures across the 3 specs) and pass here: public-pages 12/12, trust-pages 47/47, help-pages 21/21. Also green: help-delete-account 15, support-email.guard 7, privacy-owner-answers 7, privacy-round8-retention 15, privacy-restore-split 4. eslint changed files clean. (Prettier is not a gate; those files were already non-prettier on main.)

## CI
At 3076cab9: 15 SUCCESS, 1 SKIPPED (deploy-readiness-gate). build-and-test SUCCESS: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37417426842/job/112119030544
Opening comment (READY FOR AUDIT, 22:28 PDT): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/755#issuecomment-6010001625

## Cs (not fixed)
- C-1 /signup valid-code branch body and CTA still use first person ("we will help", "Email us"); copy rule nit, not in item list.
- C-2 /download/ios and /download/android still say "in private review ... If your coach has invited you"; update when store listings go live.
- C-3 /terms intro still says "written as a company policy draft" (S-IOSREV C-4).
- C-4 docs/help/faq.md:98-101 30-day deletion mirror (C-STORECOPY-1), docs only.

## HANDOFF
- State: DONE at 22:28 PDT. b#755 open at 3076cab9871f8d76bce703f0bd59431d8858b849, CI green, opening comment posted (READY FOR AUDIT). Not merged, not deployed.
- A/B/C: fixed 4 item-list Bs (B-STORECOPY-2, B-STORECOPY-3, B-PRIVACY-1 policy part, m#390 terms sentence); 4 Cs listed above.
- Worktree /home/user/workspace/wt/B-COPY-123 removed; branch lives on origin. No locks or claims held; no ci/* or audit/* branches created.
- Next: two lenses audit #755 (operator assigns). If a fix round is needed: `git -C /home/user/workspace/growth-project-backend worktree add /home/user/workspace/wt/B-COPY-123-2 origin/agent123/b-copy-public-pages`, link deps, fix, one push.
- Mobile Trust Center "Who can see your data" community/leaderboard line (S-PRIVACY mobile part) is NOT in this PR (backend only); still open for a mobile builder if the operator wants it in the 10-07 build.
- Notify: /home/user/workspace/ops/lanes123/notify/B-COPY-123.txt
