# R1 Audit PR #372 — BUG-R3 Package Archive Guard

VERDICT: DIRTY

## Executive summary

PR #372 correctly implements the BUG-R3 runtime guard: it preserves re-archive idempotency, counts only active `ClientPurchase` entitlements for the target package, throws the required structured `ConflictException`, leaves the controller/dependencies/schema untouched, and includes the requested five service-level test cases.

However, the PR is not merge-clean because `npx tsc --noEmit` fails on the newly added test file with two `TS7006` implicit-`any` errors. This is a committed TypeScript failure and blocks a CLEAN verdict.

## Hard gates

| Gate | Result | Evidence |
| --- | --- | --- |
| File scope | PASS | `git diff origin/main..HEAD --name-only` returns exactly `src/packages/packages.service.ts` and `test/packages-archive-guard.spec.ts`. |
| Zero schema mutation | PASS | `git diff origin/main..HEAD -- prisma/` is empty; `sha256sum prisma/schema.prisma` is `f4a70e7064d874426b1ca9c57e3f7addc36d72ca33b2076f70ca513285cb416a`. |
| Guard placement | PASS | In `archive()`, `if (row.archived_at) return row;` appears before the `clientPurchase.count()` guard, and the guard appears before the `coachPackage.update()` write. |
| No owner override | PASS | No role/owner bypass is present; the guard throws unconditionally when the active count is greater than zero. |
| Correct count query | PASS | The guard calls `this.prisma.clientPurchase.count({ where: { package_id: packageId, entitlement_active: true } })`. |
| Error shape | PASS | The thrown body contains `error: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS'`, `message`, and `active_subscriber_count: activeCount`. |
| Controller untouched | PASS | Controller diff is empty. |
| Zero new dependencies | PASS | `package.json` and `package-lock.json` diffs are empty. |
| Forbidden model-token scan | PASS | PR diff and touched-file scan returned 0 matches. |
| Author + commit format | PASS | PR commit author is `Dynasia G <dynasia@trygrowthproject.com>` and the commit has a title-only message. |

## Soft checks

| Check | Result | Evidence |
| --- | --- | --- |
| R69 no silent skips | PASS | No `it.skip`, `describe.skip`, `xit`, or `xdescribe` found in changed files. |
| E2E/service test cases | PASS | New spec has 5 cases: 0 active archives, all inactive archives, 1 active blocks with count 1, N active blocks while excluding inactive, already archived returns idempotently without count check. |
| R70 fail-fast lane | PASS | Equivalent lane passed: 3 suites, 15 tests, 15/15 passing. |
| TypeScript clean | FAIL | `npx tsc --noEmit` exits 2 with `TS7006` at `test/packages-archive-guard.spec.ts:178:33` and `test/packages-archive-guard.spec.ts:211:24` because callback parameter `r` implicitly has `any` type. |
| `ConflictException` import | PASS | Service import from `@nestjs/common` includes a single `ConflictException` entry. |
| Success response shape | PASS | Success path still returns `this.prisma.coachPackage.update(...)`, i.e. the updated `CoachPackage` row. |

## Findings

### DIRTY-HIGH — New test file breaks TypeScript no-emit

`npx tsc --noEmit` fails on the new test file:

```text
test/packages-archive-guard.spec.ts(178,33): error TS7006: Parameter 'r' implicitly has an 'any' type.
test/packages-archive-guard.spec.ts(211,24): error TS7006: Parameter 'r' implicitly has an 'any' type.
```

The errors are in the two `prisma._rows.find((r) => ...)` callbacks. Since this is new committed code and the required TypeScript check is red, the PR cannot be CLEAN.

## Verification commands run

- `git diff origin/main..HEAD --name-only`
- `git diff origin/main..HEAD -- prisma/`
- `sha256sum prisma/schema.prisma`
- `git diff origin/main..HEAD -- src/packages/packages.controller.ts`
- `git diff origin/main..HEAD -- package.json package-lock.json`
- PR diff/touched-file forbidden model-token scan
- skip scan for changed files
- `npm ci`
- `npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts test/diagnostic-prompt-doctrine.spec.ts --runInBand`
- `npx jest test/packages-archive-guard.spec.ts --runInBand`
- `npx tsc --noEmit`
