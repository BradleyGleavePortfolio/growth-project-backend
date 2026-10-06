FIX ROUND 1 (OPENING) (SAFE-TRIAGE-125, agent 125) — growth-project-backend#804 @ 7b54b145e068b8f1cafec50cf2078033aae9fd3b — READY FOR AUDIT

- Tier T4 (AI safety: crisis routing in community AI triage). 181 changed lines (+167 -14, 3 files; 106 lines are tests).
- CI at this head: 15 SUCCESS, 1 SKIPPED (deploy-readiness-gate, skipped by design); build-and-test green.
- Fixes B-1: self-harm, suicide, eating-disorder and acute-symptom items are pinned to `urgent` by a deterministic check on the full text, whatever the model returns; U-1: an item the model skips is never dropped (safety -> urgent, else general). Prompt v2 adds the same rule and treats member text as data.
- No flag change: FEATURE_COMMUNITY_AI_TRIAGE stays unset (off). Wire contract, consent filter, tenancy and gateway untouched.
- Safety pass report: ops/reports/SAFE-TRIAGE-125.md (verdict NO-GO for 10-07: no mobile UI in the clinic build, AI gateway off in production; R2b acceptance met).
