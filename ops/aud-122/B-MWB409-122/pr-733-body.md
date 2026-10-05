## Summary

Opus P12-120 B-355-1 / B-356-1 (backend half), job B-MWB409-122 (agent 122) = B-MWB409-120.

The global `HttpExceptionFilter` (`main.ts`) sends only the fixed envelope plus the allowlisted details of a coded 4xx (`src/filters/error-details.ts`, the recurring error-details contract). The workout-builder head conflicts were not on that allowlist, and the two autosave ones set no `code`, so the app never received `head_revision_index` and `lock_token`:

- `autosave_lock_stale` is the answer to the first autosave of every editing session (the app does not know the token yet), so no autosave ever completed.
- `undo_head_moved` lost the head and token, so Undo said "nothing was undone" even when the first attempt had worked.

Evidence: backend lanes 37343254265 (production) and 37343228885 (main).

## Change

- `src/filters/error-details.ts`: extends the existing allowlist (no new pass-through mechanism). Exactly three codes, exactly two fields, each shape-checked:
  - `head_revision_index`: safe integer >= 0
  - `lock_token`: `LOCK_TOKEN_RE` (16 lowercase hex), imported from the autosave DTO
  - codes: `autosave_lock_stale`, `autosave_conflict_retry`, `undo_head_moved`
- `workout-builder-autosave.service.ts`: the two autosave 409 bodies now set `code` (= `error`), typed as `AutosaveConflictDto`; the undo body is typed as `UndoHeadMovedDto`. Nothing else in the service changes.
- `workout-builder-autosave.dto.ts`: `MwbHeadConflictCode`, `MwbHeadConflictDto`, `UndoHeadMovedDto`; `AutosaveConflictDto` gains `code`.
- Controller: the Swagger 409 text now says what the body carries.

The token is the same HMAC token the same authorised coach already gets on every 200; the 409 is thrown after the access check. No ids, versions, revision ids or PII pass.

HTTP body the app now gets (envelope keys always present):
`{ statusCode: 409, code, message, error, timestamp, path, [request_id], head_revision_index, lock_token }`, with `code` = `error` = the conflict code.

Unchanged: a Postgres serialization conflict (P2034 / 40001) stays a plain 409 with message `autosave_conflict_retry` and no head or token.

## Tests

`test/mwb-head-conflict-409-http.spec.ts`, over real HTTP through the real controller, service, feature guard, RolesGuard and global filter (in-memory Prisma double):
- each of the three codes carries the head and token, and the key set is exactly envelope + the two fields;
- the first-session flow: a placeholder token gets `autosave_lock_stale`, the app adopts the head and token, and the retry saves (200, head + 1);
- other errors stay envelope-only: another code, the old uncoded body, the right code with wrong shapes or internal fields (`plan_id`, `version`, `head_revision_id`), a 5xx, and the P2034 path.

Failing before: with the `src/` changes reverted, the three positive cases fail and the five strip cases pass (local single-spec run through heavy.sh).

Size: 459 changed lines (1,500 rule).

Mobile follow-up (growth-project-mobile #355/#356, B-PRG2-122): `AutosaveConflictSchema` is `.strict()`, so it rejects any filter body (envelope keys). It should read `code`/`error` + the two fields without `.strict()`.
