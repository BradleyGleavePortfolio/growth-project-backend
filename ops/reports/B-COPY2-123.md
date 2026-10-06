# B-COPY2-123 — F10 public pages copy round 2 (agent 123)

Builder: Claude Opus 5.5. Started 09:27 PDT 10-06 (time box 25 min, ends 09:52).
PR: growth-project-backend#756 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/756
Branch `agent123/b-copy2-public-pages`, head `ac907a09083879b3ad5c4ef45a54f8461b018458` (on main e9b82e13).
One commit, author/committer Bradley Gleave, no co-author. 7 files, +93 / -26 (119 changed lines).

## Fixed (the four Cs from B-COPY-123)
- C-3 /terms intro: removed "They are written as a company policy draft, and counsel review is recommended." (`trust-pages.html.ts` termsContent intro).
- C-2 /download/ios, /download/android: "in private review ... leave us your email and we will notify you" -> "The iPhone app is not on the App Store yet. It can be downloaded there once the listing is live. For questions in the meantime, contact support." (Android: Google Play). CTA "Contact support", mailto subject "iPhone app" / "Android app".
- C-1 /signup with code: "Open The Growth Project app on your phone and enter the invite code below during setup to connect with your coach. If your coach shared a link, open it on your phone to launch the app. For help with setup, contact support and include the code." CTA "Contact support"; subject "Invite <code>" kept.
- C-4 docs/help/faq.md (and docs/help/support-boundaries.md, same thirty-day claim): 14-day cancellable grace period, word for word with the rendered /help/faq and /help/support (which already said 14). Real window: `DELETION_GRACE_DAYS` default 14 (`src/account-deletion/account-deletion.service.ts:172-175`, `.env.example:734`).

## Tests (heavy.sh, one file at a time)
Fail on main src: public-pages 2, trust-pages 1, help-delete-account 1. Pass here: public-pages 14/14, trust-pages 48/48, help-delete-account 16/16, support-email.guard 7/7, help-pages 21/21. eslint changed files clean.

## CI
At ac907a09: all checks green except two that are red on main e9b82e13 as well (not caused by this diff):
- build-and-test: 1 failed test, test/booking-lock-screen-push.spec.ts (24h reminder says "today" instead of "tomorrow"; clock-dependent), 874 suites passed. PR job https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37496448128/job/112382103458 ; same failure on main https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37494141389/job/112374203140
- npm audit: new critical GHSA-pqg4-j6r4-53mv on shell-quote 1.10.0 (dev-only, via @flydotio/dockerfile). Same on main https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37494141350/job/112374203384
Both are required checks, so they block merging every backend PR until fixed on main.
Opening comment (READY FOR AUDIT, 09:45 PDT): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/756#issuecomment-6021014415

## Cs (not fixed, outside the item list)
- C-1 /help/faq "Why does my account say Client instead of Coach?" says "Promotion to coach is manual at sign-up. Reply to your welcome email and we will promote it within one business day." Signup lets a person pick coach at creation (`auth.dto.ts:22`, `intended_role`), so the answer looks stale; mirror in docs/help/faq.md:17. Needs a check of the real path before rewording.
- C-2 The company-drafted / "counsel review is recommended" footnotes on /privacy, /consumer-health-privacy and /terms (the /terms one adds "before relying on it as a binding agreement") are kept; tests pin them (`trust-pages.spec.ts:395-410`). Owner call whether to drop them.

## Operator decisions needed
1. Main is red on two required checks (booking-lock-screen-push clock-dependent test; shell-quote critical advisory). Recommended default: one small backend PR that pins the test clock in booking-lock-screen-push.spec.ts and adds a time-boxed dev-only audit exception for shell-quote (same pattern as braces OR-114-2), or bumps it if a patched version exists.
2. /help/faq "Client instead of Coach" answer (C-1 above). Recommended default: fold into the next copy PR after checking the real coach-role path.

## HANDOFF
- State: DONE at 09:46 PDT. b#756 open at ac907a09083879b3ad5c4ef45a54f8461b018458, opening comment posted (READY FOR AUDIT). Not merged, not deployed.
- A/B/C: fixed the 4 item-list Cs (terms draft line, download pages, invite signup copy, docs 30-day mirror); 2 new Cs listed above; 0 new Bs.
- CI: green except build-and-test and npm audit, both red on main for reasons outside this diff (see CI).
- Worktree /home/user/workspace/wt/B-COPY2-123 removed; branch lives on origin. No locks or claims held; no ci/* or audit/* branches created.
- Next: two lenses audit #756 (operator assigns). Fix round: `git -C /home/user/workspace/growth-project-backend worktree add /home/user/workspace/wt/B-COPY2-123-2 origin/agent123/b-copy2-public-pages`, link deps, fix, one push.
- Notify: /home/user/workspace/ops/lanes123/notify/B-COPY2-123.txt
