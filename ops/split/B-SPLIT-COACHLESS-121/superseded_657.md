SUPERSEDED (B-SPLIT-COACHLESS-121, agent 121) — growth-project-backend#657 @ c25960a8b82ed4dd6bea0b7da9f1d77ce783078d

This PR (3,184 lines, over the 3,000 ceiling and never reviewed) is split into three pieces under 1,500 lines each (owner A1.2):
- #721 COACHLESS split 1/3 (base main) @ d90b484278f432e6e73e41326dc31cadc8892999: schema, migration, RLS live suite, erasure decisions (808)
- #722 COACHLESS split 2/3 (base #721) @ c219d2f391c37edd700d5204f31b50286f280d82: flag, errors, featured coach, Home and Roman card services (1,290)
- #723 COACHLESS split 3/3 (base #722) @ e3368cc3cbb0961326ddf147728f7fc32d884188: idempotent coach-code redemption, routes, module (1,117)

Main 5da537d6 was merged once (reference M f3f0d659; M' fcdc1d6c on agent121/coachless-split-0-merged-reference): three union conflicts (fly manifest, launch-flags runbook, ci.yml) and two semantic resolutions required by main's gates (erasure manifest decisions for the three coachless tables; describeFailure in two redemption log calls). Two inherited reds from this PR's own CI (run 37082215722: roles-enforced, live RLS anon case) are fixed in the owning pieces. Top tree of #723 == tree of fcdc1d6c. Review and land the split stack; this PR stays open (not closed) per the operator rule and should not be merged.
