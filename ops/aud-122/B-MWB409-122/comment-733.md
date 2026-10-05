FIX ROUND 1 (OPENING, B-MWB409-122, agent 122) — growth-project-backend#733 @ 635cabeeae1c3e74dd3f9311e5a059680e917628

Job B-MWB409-122 = SoT A9 B-MWB409-120: the backend half of Opus P12-120 B-355-1 (mobile #355, 5999100428) and B-356-1 (mobile #356, 5999100681). Tier T4 (API contract, global error filter). Base main 5cde6253. Size 464 changed lines (1,500 rule). No `as any`, `as unknown as` or `as never` in the diff.

**What a coach saw before.** The global HttpExceptionFilter removed `head_revision_index` and `lock_token` from three 409 answers. The first autosave of every editing session gets `autosave_lock_stale`, because the app does not have a token yet. Without those two fields the app could never finish that first save. For `undo_head_moved`, Undo said "nothing was undone" even when the undo had worked (backend lanes 37343254265 on production and 37343228885 on main).

**Fix: extends the existing error-details contract, no new mechanism**
- `src/filters/error-details.ts`: `ERROR_DETAIL_ALLOWLIST` gains exactly `autosave_lock_stale`, `autosave_conflict_retry` and `undo_head_moved`. Each allows exactly two fields, and each field's shape is checked:
  - `head_revision_index`: a safe integer, 0 or more.
  - `lock_token`: must match `LOCK_TOKEN_RE` (16 lowercase hex), imported from the autosave DTO rather than copied.
  - The allowlist stays keyed on `code`, and envelope keys stay protected.
- `workout-builder-autosave.service.ts`: the two autosave 409 bodies now set `code` (the same value as `error`). The bodies are typed with the new `AutosaveConflictDto` / `UndoHeadMovedDto` (`workout-builder-autosave.dto.ts`). No logic changed.
- The token is the same HMAC token the same coach already receives on every 200, and the 409 is thrown after `authorisePlanAccess`. No ids, versions, revision ids or PII pass through.

**Published contract.** Envelope keys are always present: `{ statusCode: 409, code, message, error, timestamp, path, [request_id], head_revision_index, lock_token }`, and `code` = `error` = the conflict code. The mobile builder B-PRG2-122 has this in `ops/lanes122/notify/mwb409.txt`. At #356 40ee678a, mobile `AutosaveConflictSchema` is `.strict()`, so it would reject this body; the mobile side must drop `.strict()`.

**Tests.** `test/mwb-head-conflict-409-http.spec.ts` (8 tests) runs over real HTTP through the real controller, service, feature guard, RolesGuard and global filter, with an in-memory Prisma double:
- Each of the three codes carries the head and token, and the response has exactly the envelope keys plus those two fields.
- First-session round trip: a placeholder token gets `autosave_lock_stale`, the app adopts the head and token, and the retry returns 200 at head + 1.
- These stay envelope-only:
  - a different code
  - the old body without `code`
  - a listed code with wrong shapes or extra internal fields (`plan_id`, `version`, `head_revision_id`)
  - a 5xx
  - the P2034 serialization path
- Failing before the fix: with `src/` reverted, 3 tests fail and 5 pass. With the fix, all 8 pass (local single-spec run through heavy.sh).

**CI**
- Lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387281393: full `tsc --noEmit` green, plus 9 related specs: 7 passed and 2 live-DB suites skipped. Those 2 run in this PR's mwb-3-live-tests job, which is green.
- PR CI at this head is all green: build-and-test, mwb-3-live-tests, rls-live-tests, CodeQL, banned casts, schema parity, danger.
- The second commit fixes a CodeQL alert at 29ebbb71 (`js/unvalidated-dynamic-method-call` in the test-only crafted-error controller). It now uses a switch.

**C (edge, deferred to 10k clients), not fixed**
- A P2034/40001 serialization conflict (two writes at the same instant) still returns a plain 409 with message `autosave_conflict_retry` and no code, head or token. Mobile should treat it as an unknown outcome and refetch.
- The two autosave 409s keep Nest's default message "Conflict Exception". No new copy was added; the app shows its own copy for these codes.

**Operator decisions (recommended default)**
1. Merge and deploy #733 before the mobile FEATURE_MWB_* clinic flag PR, then turn on FEATURE_MWB_AUTOSAVE_UNDO and MWB_AUTOSAVE_LOCK_TOKEN_SECRET (default: yes, in that order).
2. Autosave 409 message copy: leave it to the app (default: leave).

READY FOR AUDIT
