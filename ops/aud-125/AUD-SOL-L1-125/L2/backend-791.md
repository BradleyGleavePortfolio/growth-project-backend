AUDIT GPT-6.1 Sol — growth-project-backend#791 @ 4c74404e1642ac47f34ad7516c458b11c04fdee0 — VERDICT: APPROVE

A=0 B=0 C=0.

A free-to-paid package edit now clears only that coach/package's `free` profile and invite-code bindings in the same price-change transaction, leaving explicit prepaid bindings and existing clients' grants untouched ([free-offer predicate and scoped binding release, packages.service.ts:179–215](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4c74404e1642ac47f34ad7516c458b11c04fdee0/src%2Fpackages%2Fpackages.service.ts#L179-L215), [transactional update:594–625](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4c74404e1642ac47f34ad7516c458b11c04fdee0/src%2Fpackages%2Fpackages.service.ts#L594-L625)).

The guard recognizes both one-time and recurring paid offers and does not clear a deliberate free binding on an already-paid offer or on a name-only edit, as exercised by the regression ([binding-release regression](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4c74404e1642ac47f34ad7516c458b11c04fdee0/test%2Fpackage-free-invite-binding-release.spec.ts)).

Build-and-test, R75, schema parity, live checks and CodeQL are green at this head, with no new launch-blocking finding in this money delta ([build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37532944290/job/112506626558), [R75](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37532944130/job/112506626595), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-backend/runs/112513360483)).

The separate paused-subscription pricing predicate is covered by the b#778/FIX-Q1 review and is not duplicated as a new blocker here ([pricing PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/778)).
