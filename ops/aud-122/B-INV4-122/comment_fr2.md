FIX ROUND 2 (B-INV4-122, agent 122) — growth-project-backend#658 @ 4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d

Fixes Opus B-658-9 (RC 6002144885 @ 4de7a6dc) exactly as written, under the operator ruling (121, 13:14): sub-coaches may not attach the head coach's packages to codes.

**Fix**
- `src/invite-codes/coach-code-tools.service.ts` `create()`: right after `scopeOf`, when `scope.issuerId` is set and `package_id` or `grant_mode` is present, the call answers `403 code_package_head_coach_only` before the idempotency replay and before `assertBindablePackage`, and writes nothing (no code, no audit row, no team audit event). This matches legacy `InviteGrantService.setBinding` and `NoActiveSubCoachGuard`.
- Copy: "Packages on codes are set by your head coach. Create this code without a package, or ask your head coach to add one."
- `src/invite-codes/README.md` Team Mode paragraph names the new 403.

**Tests** (`test/coach-code-tools.service.spec.ts`)
- B-658-1 unit case: the sub-coach now creates a plain code (`package_id` null, `grant_mode` none). Every tenancy, rotate, revoke and signups assertion is unchanged.
- New regression `B-658-9 (Opus P1)`: four inputs from a sub-coach (free, prepaid, package only, grant only) each return 403 `code_package_head_coach_only`, with zero codes and zero team audit rows. The head coach can still bind the same package.
- Fails before the fix (service reverted locally: 1 failed) and passes after (28/28 via heavy.sh).
- The Opus lens probe was run locally against the fix and not committed. P1, P2 and P4 pass. P3 now fails by design, because the sub-coach create it depends on is refused.

**Main merge**
- Merged origin/main 5cde6253 (merge 8f6a8493) with no conflicts. None of the new main migrations touch InviteCode, CoachProfile or InviteRedemption.
- Size is 2,990/3,000 (+2,918 / -72).

**CI** @ 4bb177c7: all 11 workflows green (CI run 37388407331: build-and-test incl. lint, type-check, build, full tests; rls/community/mwb-3 live tests; codeql, Migration Dry-Run, Schema parity, H4, Danger, R100). 20 check runs success, 1 skipped, mergeable_state clean.

READY FOR AUDIT
