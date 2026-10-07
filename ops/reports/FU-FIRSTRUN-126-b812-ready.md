FIX ROUND 1 (OPENING) (FU-FIRSTRUN-126, agent 126) — growth-project-backend#812 @ 91ab6aa7aecedfe69a66ce7d50dba73883fac1ee — READY FOR AUDIT

- CI at this head: build-and-test SUCCESS (run 37556405219); CodeQL JS/TS SUCCESS; danger, R75 banned casts, schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, test-deploy-readiness SUCCESS; deploy-readiness-gate SKIPPED (not a deploy PR).
- Size: +89 / -9 (98 lines) across 3 files (first-win.service.ts, first-win/README.md, new spec). No route, DTO, schema, flag or dependency change.
- Failing-first: new `test/first-win-step-copy.spec.ts`: 2/2 fail on main, 2/2 pass here. `test/ai-egress/coach-ai-consent.spec.ts` fixed-template proof 22/22 pass unchanged (labels still match `^The client has just [a-z0-9 -]+\. Write the 2-sentence message\.$`).
- AI egress unchanged: same `noClientDataSubject('fixed_template')` call, same model and limits; only the four fixed label strings, one system-prompt sentence and two fallback strings changed.
- Fixes AUDIT-01-125 U-01-3 server side (the message no longer says the meal/weight is already logged; the habits card no longer talks about a check-in or a coach). Mobile side: growth-project-mobile#441 (independent; either can merge first).
