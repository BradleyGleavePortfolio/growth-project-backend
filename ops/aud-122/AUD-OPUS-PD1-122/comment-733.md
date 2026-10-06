AUDIT Claude Opus 5.5 — growth-project-backend#733 @ 635cabeeae1c3e74dd3f9311e5a059680e917628 — VERDICT: APPROVE

Job AUD-OPUS-PD1-122 (agent 122), first full review. T4 (optimistic lock token in error replies). Size 464 lines (under the 1,500 rule).

**A/B/C: 0/0/2**

What I checked:
- **Allow-list.** `src/filters/error-details.ts` extends the existing `ERROR_DETAIL_ALLOWLIST`. Exactly `autosave_lock_stale`, `autosave_conflict_retry` and `undo_head_moved` pass exactly two fields:
  - `head_revision_index`, a safe integer of 0 or more;
  - `lock_token`, which must match `LOCK_TOKEN_RE`.
  Values of the wrong shape are dropped, envelope keys cannot be overridden, and 5xx and every other code are untouched.
- **Access.** Both throwers in `workout-builder-autosave.service.ts` run after `authorisePlanAccess` (autosave :185, undo :302), inside the plan row lock. The token reaches only a coach who would get the same token on a 200. No outsider path exists.
- **Body codes.** The two autosave 409 bodies now set `code` = `error`, which keys the allow-list. The undo body already did. There is no logic change, and the P2034 path still answers a plain 409 with no code.
- **Filter.** The global filter order in `main.ts:118` is HttpExceptionFilter catch-all plus Throttler, so nothing rewrites these bodies first.
- **Spec.** `test/mwb-head-conflict-409-http.spec.ts` drives the real controller, service, guards and global filter. It pins the exact key set (envelope plus the two fields) and the bootstrap round trip: placeholder token, then 409 with head and token, then a re-send that returns 200.
- **Mobile.** The mobile stack (#355/#356) parses this exact body. My probes PD1-1, PD1-2 and PD1-4 are green in https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389877384.

Cs (one line each):
- A P2034 serialization 409 carries no head or token: C (edge, deferred to 10k clients), operator ruling.
- The two autosave 409s keep Nest's "Conflict Exception" message. The app shows its own copy for these codes, so nothing reaches users.

Evidence: PR CI at this head is all green: build-and-test, mwb-3-live-tests, rls-live-tests, community-live-tests, CodeQL, banned casts, schema parity, danger, npm audit and sbom.

Order note for the operator: merge and deploy #733, then turn on backend FEATURE_MWB_AUTOSAVE_UNDO and MWB_AUTOSAVE_LOCK_TOKEN_SECRET, and only after that open the mobile clinic flag PR.
