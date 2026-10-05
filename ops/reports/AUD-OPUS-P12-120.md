# AUD-OPUS-P12-120 — Opus lens, mobile programs P1 #355 + P2 #356 (first review)

Job: AUD-OPUS-P12-120, agent 120, lens Claude Opus 5.5. Started 09:29 PDT 10-05.
Heads: #355 902c64a64156255ce9ce54147db896ac2142a954 (base main 367e6c48, BEHIND), #356 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5 (base #355 branch).
Claims: ops/lanes120/claims/mobile-355-902c64a6-opus, mobile-356-40ee678a-opus.
Lens notes: ops/aud-120/AUD-OPUS-P12-120/.

## Status
- In progress: reading PR bodies, comments, diffs.

## HANDOFF
- Next: full review of both diffs, probes in mobile CI lane, verdicts at exact heads.

## Progress 09:47 PDT
- Read: _COMMON_120/119/118/116, AGENT_RULES (LAW), MERGE_DEPENDENCY_GUIDE, PR bodies + READY comments (operator 116, 02:26 UTC 10-04). No prior lens verdicts on #355/#356. #328 approvals do not carry (HANDOFF_AGENT_116 section 4).
- Tier graded: T4 (G1 handles client names/emails, unassign removes client workouts, idempotent creates; G2 is coach workout content inside a T4 stack).
- Probes launched (CI lanes):
  - mobile #355 probe run 37343148250 (branch audit/AUD-OPUS-P12-120/355-1)
  - mobile #356 probe run 37343202834 (audit/AUD-OPUS-P12-120/356-1)
  - backend main ee55f814 envelope probe run 37343228885 (audit/AUD-OPUS-P12-120/be1-1)
  - backend production f48267f9 envelope probe run 37343254265 (audit/AUD-OPUS-P12-120/be2-1)
- Candidate findings (pending probe results): HttpExceptionFilter strips head_revision_index/lock_token from autosave_lock_stale and undo_head_moved 409s (autosave bootstrap and undo fence cannot work live); in-flight idempotent 409 classified as definite; retry-path definite refusal claims nothing was undone; clinic eas.json flips flags against flag-off backend; programs_unavailable copy claims templates still work.
