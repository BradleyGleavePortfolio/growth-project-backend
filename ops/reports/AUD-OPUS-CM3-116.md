# AUD-OPUS-CM3-116 (lens Claude Opus 5.5, agent 116 wave) — report

Job: (1) delta audit of backend #675 (coach Money M2, idempotent package create) at FIX ROUND 1 head e45b06f9; (2) stay up to
90 min for backend #676 (coach Money read API) FIX ROUND from B-CM1-116 and audit that head against this lens's prior verdict
(AUD-OPUS-CM1-116). Notes/probes: ops/aud-116/AUD-OPUS-CM3-116/. Disk at start 75 percent. No heavy local work (lens rule).

## backend #675 @ e45b06f9c797e2b1fc4bded653c826e9b78bda98 — APPROVE 0/0/1
Claim: ops/lanes116/claims/backend-675-e45b06f9-opus (03:36 UTC 10-04).
Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/675#issuecomment-5976333807 (body kept in
ops/aud-116/AUD-OPUS-CM3-116/verdict-675-e45b06f9.md). Head re-verified right before posting.
Delta d1c98430..e45b06f9 = 2 commits, 6 files (new package-idempotency.filter.ts; controller UseFilters line; service fingerprint +
replayCreate; 3 specs); every line read. Rest of the PR unchanged since this lens's line-by-line audit at d1c98430 (evidence reuse).
BEHIND main a5b605d1 (#664, #652): no file overlap, merge-tree clean -> later update-branch is merge-only.

Prior findings decided:
- B-675-1 CLOSED: wire 422 carries package_id (filter :40-66, controller :50, service :348-367). Only live packages of the caller's
  current catalog are named; anything else 410.
- C-675-3 CLOSED: archived -> 410 IDEMPOTENT_PACKAGE_REMOVED (service :351-358).
- C-675-2 CLOSED: packageCreateFingerprint (service :120-131, :271-276); injective (same key set per createData row; defaults depend
  only on identity keys).

Probes (CI lane; audit branches deleted after, runs kept):
- https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175221476 (green, 40/40), head + probe
  audit-opcm3-675-wire.spec.ts: (a) 21-request battery over real HTTP with both main.ts global filters, head wiring vs pre-PR
  wiring (class metadata rewritten to [PackageValidationFilter]): all statuses/bodies identical except the 422 = pre-PR body +
  package_id only; (b) cross-coach matrix (other coach same key, sub-coach own key space, moved sub-coach 410 no id, moved back):
  every UUID in every body belongs to the caller's current catalog; (c) literal stored hashes for two bodies.
  (First run 37174997613 red only because my one-time literal body lacked the DTO-required billing_type; fixed and rerun.)
- https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175231157 (green, 63/63), e45b06f9 merged with
  #672 e06b5b13 (only conflict: two import lines in packages.controller.ts, kept both; service auto-merges keeping the fingerprint):
  pre-#672 keys (seeded with the literal hashes) replay 201 for recurring and one-time; trial_days 0/null still replays;
  trial_days 7 -> 422 with package_id; a post-merge key stores the same hash; b-trials-package-rules + the PR's 3 specs pass.
  (First run 37175008769 red for the same billing_type probe mistake.)
- https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37175081559 (green, 7/7), mobile #345 a4e49588
  createPackageOnce vs the exact wire bodies: 201 replay keeps the package; 422+package_id adopts + one PATCH, then no further
  sends; 410 same-tap fresh start under a new key, one new package; 409 rethrown, same key kept, "still being saved" copy; 400
  IDEMPOTENCY_KEY_INVALID clears the intent; control: pre-fix 422 without package_id loops on the same key (now unreachable).

New: C-675-4 (optional copy): service :356 "has since been removed" is inaccurate for a moved sub-coach (package exists in the old
catalog); :364 puts "(package_id)" in prose. Mobile never shows either. Fix rule: "is no longer in this catalog"; drop the parenthesis.

Operator notes: #672 refresh = import-line conflict only, keep the requestHash fingerprint line (proven above). After #678 lands,
moving IDEMPOTENCY_KEY_REUSED { package_id: uuid } into ERROR_DETAIL_ALLOWLIST is optional cleanup; the filter stays correct
(other 422s go through the allow-listed HttpExceptionFilter).

## backend #676 — (pending: waiting for B-CM1-116 FIX ROUND ... READY FOR AUDIT)

#676 was not audited and has no verdict. The owner ordered a pause at 21:04 PDT before the builder posted FIX ROUND ... READY FOR AUDIT. At 04:01 UTC the head was cf5ef18b6d6f892ce6d7b975539f4ea31730286e: still a draft, checks pass=7/pending=3/skipping=1. A code-reading draft is in /home/user/workspace/ops/aud-116/AUD-OPUS-CM3-116/draft-676-cf5ef18b-notes.md.

## PAUSE STATE
- PRs and heads audited:
  - backend#675 @ e45b06f9c797e2b1fc4bded653c826e9b78bda98: APPROVE, A/B/C = 0/0/1 (C-675-4, optional copy). Posted at https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/675#issuecomment-5976333807 (body: /home/user/workspace/ops/aud-116/AUD-OPUS-CM3-116/verdict-675-e45b06f9.md).
  - Note: #672 has since moved to 4fa2fe4a. packages.service/controller/dto are byte-identical to e06b5b13, and the merge still has only the packages.controller.ts import conflict, so the #672 merge probe still holds.
- backend#676 @ cf5ef18b (claimed: claims/backend-676-cf5ef18b-opus): no verdict posted. The draft notes file is above.
  - Closed by reading the code only: B-676-1, B-676-2, C-676-2 and the MRR/trial ruling all look fixed. No probe has run yet.
  - Candidate B-676-3 (not probed): the seller tax CSV double-counts client_refunded on a head-coach-split refund. The head_coach_split posting is stamped with new Date() (#674 transfer-orchestrator.service.ts:298), and buildMoneyCsv keys reversal rows on p.at (:866-876).
  - Candidate C findings: churned_30d counts trial cancellations and cancel-then-trial clients; a legacy-split edge case; a stale docstring.
- Probe files: none are committed for #676 and no CI runs are in flight. The old probe to rerun is /home/user/workspace/ops/aud-116/AUD-OPUS-CM1-116/audit-cm1-676-window-cents.spec.ts.
- Branches: no audit/AUD-OPUS-CM3-116/* or ci/* branches remain on the backend or mobile remotes (checked with ls-remote).
- Worktrees still present: /home/user/workspace/wt/AUD-OPUS-CM3-116-1 and -2 (backend) and -3 (mobile). They are not needed for #676 and should be removed with `git worktree remove --force` (no node_modules were linked).
- Exact next step to resume:
  1. Poll `/home/user/workspace/ops/prstate.sh backend 676` and the comments for "FIX ROUND ... #676 ... READY FOR AUDIT". If the head moved, claim the new head8.
  2. Add a worktree at the head and commit the 5 probes listed in the draft notes, including the head-coach CSV probe with +1 s latency.
  3. Run them through `ci_lane.sh backend <wt> audit/AUD-OPUS-CM3-116/676-postings <specs>`.
  4. Finalize the findings, re-check the head, post the verdict, then delete the audit branch and remove the worktrees.

## HANDOFF
- #675: APPROVE 0/0/1 posted at e45b06f9 (link above). #675 is BEHIND main, so a merge-only delta follows.
- #676: NOT audited (paused). Resume from PAUSE STATE. The draft is at /home/user/workspace/ops/aud-116/AUD-OPUS-CM3-116/draft-676-cf5ef18b-notes.md.
- Operator decision: should churned_30d exclude trials that never billed? Recommended default: yes, exclude them.
