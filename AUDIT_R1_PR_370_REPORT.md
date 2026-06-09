VERDICT: DIRTY (5 issues, 1 critical)

## DIRTY-CRITICAL

1. `src/community/notifications/community-notifications.service.ts:82-97`, `src/community/notifications/community-notifications.service.ts:179-182` — push privacy does not consult `User.lockscreenPrivacy`; it accepts an optional caller override, otherwise defaults to privacy-on, and the only `User` field selected before push is `expo_push_token`. This violates hard gate 4: push notification rendering must consult `User.lockscreenPrivacy` and use generic copy when it is true.

## DIRTY-MAJOR

1. `/home/user/workspace/v1-4-jest-full-run1-2026-06-09T17:37:45+00:00.log` — the full-suite artifact is red: `Test Suites: 8 failed, 7 skipped, 332 passed, 340 of 347 total` and `Tests: 543 failed, 90 skipped, 5 todo, 4280 passed, 4918 total`. The failed suites are RLS suites (`test/rls-tier1-policies.spec.ts`, `test/rls-tier2-policies.spec.ts`, `test/rls-tier2-sessions-policies.spec.ts`, `test/rls-tier3-nutrition-policies.spec.ts`, `test/rls-tier3-workouts-policies.spec.ts`, `test/rls-tier4-learning-analytics-policies.spec.ts`, `test/rls-tier5-policies.spec.ts`, `test/rls-helper-search-path.spec.ts`), not the five grandfathered suites in `docs/PRE_EXISTING_TEST_FAILURES.md`. This violates R66 full-suite evidence expectations.

2. `src/community/community-events.ts:70` — `community.digest.queued` is defined and tested as a telemetry event, but there is no implementation of `queueCommunityDigest()` or any capture call for that event. Evidence: `rg -n 'queueCommunityDigest|digestQueued|community\.digest\.queued|digest\.service' src test docs` only found the constant/test and existing imports of `DigestService`, not a new emitter. This violates the brief's telemetry table row requiring `community.digest.queued` from a digest service extension.

3. `src/community/realtime/community-realtime.service.ts:146-157`, `src/community/notifications/community-notifications.service.ts:247-254` — telemetry failure payloads set `error_code` to raw exception messages. The telemetry contract asks for an error code, and the soft PII gate requires PostHog payloads to avoid user-authored content, email addresses, and names; raw exception strings are not sanitized and can carry sensitive details from lower layers.

## DIRTY-MINOR

1. `src/community/reactions/community-reactions.service.ts:184`, `src/community/reactions/community-reactions.service.ts:202` — `emitReactionChanged(..., responseKind, ...)` is called with `t.targetType`, so the broadcast payload field `kind` duplicates target type instead of a reaction-kind discriminator. This is not a text leak, but it drifts from the documented `{ targetType, targetId, kind, delta }` reaction contract.

## CLEAN-VERIFIED

### Hard gates

1. **Zero schema mutation — PASS.** `git diff origin/main..HEAD -- prisma/` produced no output. `sha256sum prisma/schema.prisma` returned `f4a70e7064d874426b1ca9c57e3f7addc36d72ca33b2076f70ca513285cb416a  prisma/schema.prisma`.

2. **Entitlement guards pin — PASS.** `git diff origin/main..HEAD -- test/entitlement-guards-mounted.spec.ts` produced no output. Counting `label:` entries inside `PAID_ROUTES` returned `17`.

3. **No user-authored body in broadcast payloads — PASS for content privacy.** Broadcast call-site payloads contain ids/timestamps/enums only: message created `{ id, cohortId, authorId, createdAt }`, message updated `{ id, cohortId, updatedAt }`, post created `{ id, workspaceId, authorId, createdAt }`, post updated `{ id, workspaceId, updatedAt }`, moderation `{ actionId, wsId, targetType, targetId, action }`, and reactions `{ targetType, targetId, kind, delta }`. Minor semantic drift on reaction `kind` is listed above.

4. **Lock-screen privacy fallback — FAIL / DIRTY-CRITICAL.** `rg -n -i 'lock.*screen|lockscreenPrivacy|lockscreen_privacy' prisma/schema.prisma src test` found no schema field and showed `resolveLockscreenPrivacy()` only using an optional input override or `return true`; the push recipient query selects only `{ expo_push_token: true }`.

5. **Three flags OFF in prod — PASS.** `community.service.ts:115-117` exposes `/community/me` flags by checking `process.env.FEATURE_COMMUNITY_REALTIME === 'true'`, `FEATURE_COMMUNITY_PUSH === 'true'`, and `FEATURE_COMMUNITY_TELEMETRY === 'true'`; `CommunityRealtimeService` and `CommunityNotificationsService` use the same strict true checks. No `.env` defaults set these flags on.

6. **Zero new dependencies — PASS.** `git diff origin/main..HEAD -- package.json package-lock.json` produced no output. Lockfile counts: `@supabase/supabase-js=1`, `expo-server-sdk=1`, `posthog-node=1`.

7. **Forbidden model-name grep — PASS.** Case-insensitive diff grep for the forbidden model-name returned count `0`.

8. **Author + commit format — PASS.** `git log origin/main..HEAD --pretty='%an <%ae> | %s'` returned five commits, all `Dynasia G <dynasia@trygrowthproject.com> | community: v1-4 realtime push telemetry`. `commits=5 body_lines=10 expected_lines=10`, so each commit has subject plus blank only.

### Soft checks

9. **R69 no silent skips — PASS.** `git diff -U0 origin/main..HEAD | rg '^\+.*(\.skip\(|xit\(|xdescribe\(|testPathIgnorePatterns|eslint-disable|describe\.skip|it\.skip)'` produced no output. Diff-context mentions of `describe.skip` are existing `liveDbUrl() ? describe : describe.skip` lines, not newly added lines.

10. **R66 full suite intent — FAIL / DIRTY-MAJOR.** Full-suite logs exist in `/home/user/workspace/`: `v1-4-jest-full-run1-2026-06-09T17:27:16+00:00.log`, `v1-4-jest-full-run1-2026-06-09T17:37:45+00:00.log`, and `v1-4-jest-full-run2-2026-06-09T17:44:04+00:00.log`. The complete run with summary is red: `8 failed, 7 skipped, 332 passed, 340 of 347 total` suites.

11. **R70 fail-fast lane — PASS.** `npm run` has no `test:fail-fast` script. The authoritative R70 command from the brief was run: `npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts test/diagnostic-prompt-doctrine.spec.ts --runInBand`; result: `Test Suites: 3 passed, 3 total` and `Tests: 15 passed, 15 total`. The fallback pattern lists 5 files and, after Prisma client generation for local test setup, ran `5 passed, 5 total` suites and `34 passed, 34 total` tests.

12. **Channel naming sharding — PASS.** The brief specifies `community:<scope>:<id>[:<sub>]` and cohort `community:cohort:${cohortId}:messages:${shard}` with shard in `[0,4)`. Code in `src/community/community-events.ts:26-35` matches: user, cohort, workspace, event, challenge, moderation channels; `CommunityRealtimeService.communityCohortShard()` returns `h % 4`.

13. **PostHog event naming — PARTIAL FAIL / DIRTY-MAJOR.** Event constants match the brief's namespace: `community.realtime.broadcast_sent`, `community.realtime.broadcast_failed`, `community.push.sent`, `community.push.skipped`, `community.digest.queued`, `community.push.delivery_failed`, and `community.realtime.subscriber_count_unknown`. However, `community.digest.queued` has no emitter implementation.

14. **PII in PostHog payloads — FAIL / DIRTY-MAJOR.** Success/skip payloads are IDs/enums/counts only, but failure payloads use raw exception messages as `error_code` in realtime and push services, which is not sanitized.

15. **Idempotency / replay safety — PASS with concern.** Push has `CommunityNotificationsService.idempotencyKey()` derived from `(kind, recipientId, targetType, targetId)` and checks existing `Notification.payload.idempotency_key` before send. Realtime emits are fire-and-forget pings with no durable side effects. Concern: the push check is `findFirst` on JSON payload, not a unique constraint, so concurrent duplicate sends are not atomically collapsed.

## NOTES FOR FIXER

1. Add a real `User` privacy read path for community push rendering. If the schema truly lacks the field, resolve the product/schema mismatch explicitly before claiming this gate is satisfied.
2. Produce a clean R66 full-suite artifact, or document a precise accepted baseline showing the RLS failures are pre-existing and no worse than main.
3. Implement the `community.digest.queued` capture path or remove it from the v1-4 contract/tests if it is out of scope.
4. Replace raw exception-message telemetry values with bounded, allowlisted error codes.
5. Fix reaction broadcast `kind` so it matches the documented contract or amend the contract/test to the intended refetch-only payload.
