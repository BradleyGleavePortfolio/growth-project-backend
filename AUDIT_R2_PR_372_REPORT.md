# R2 Audit PR #372 — BUG-R3 Package Archive Guard

Auditor: R31 (fresh GPT-5.5 R2 auditor)
PR head audited: `e3ca9aeb4590c1e3733f378846b6dc2f969f1c8c`
Branch audited: `fix/bug-r3-package-archive-guard` (detached HEAD at audit start)
Prior R1 verdict: DIRTY due to two `TS7006` implicit-any errors in `test/packages-archive-guard.spec.ts`.

## Verdict

CLEAN

The R1 TypeScript blocker is fixed, and all hard gates re-verified clean after dependency bootstrap with `npm ci`.

## Hard gates

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | `npx tsc --noEmit` | PASS | Exited 0 after `npm ci`; no TypeScript errors, including no errors in `test/packages-archive-guard.spec.ts`. |
| 2 | Package archive guard Jest | PASS | `npx jest test/packages-archive-guard.spec.ts --runInBand`: 1 suite passed, 5/5 tests passed. |
| 3 | R70 fail-fast lane | PASS | `npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts test/diagnostic-prompt-doctrine.spec.ts --runInBand`: 3 suites passed, 15/15 tests passed. |
| 4 | File scope | PASS | `git diff origin/main..HEAD --name-only` returned exactly `src/packages/packages.service.ts` and `test/packages-archive-guard.spec.ts`. |
| 5 | Schema SHA | PASS | `sha256sum prisma/schema.prisma` returned `f4a70e7064d874426b1ca9c57e3f7addc36d72ca33b2076f70ca513285cb416a`. |
| 6 | Zero deps | PASS | `git diff --exit-code origin/main..HEAD -- package.json package-lock.json` exited 0. |
| 7 | Author | PASS | `git log origin/main..HEAD --pretty='%an <%ae>'` returned only `Dynasia G <dynasia@trygrowthproject.com>` for both commits. |
| 8 | Commit format | PASS | Both commits have title-only messages; body blocks were empty. |
| 9 | Forbidden token | PASS | `git diff origin/main..HEAD | grep -i sonnet` returned no matches (`grep` exit 1). |
| 10 | Entitlement guards untouched + count | PASS | `git diff --exit-code origin/main..HEAD -- test/entitlement-guards-mounted.spec.ts` exited 0; `npx jest test/entitlement-guards-mounted.spec.ts --runInBand` passed 17/17 tests. |
| 11 | Guard logic intact | PASS | `archive()` preserves idempotent already-archived early return, then counts active entitlements with `this.prisma.clientPurchase.count({ where: { package_id: packageId, entitlement_active: true } })`, throws `ConflictException` with `error`, `message`, and `active_subscriber_count`, and only then updates `archived_at`/`is_active`. |
| 12 | R69 no silent skips | PASS | `git diff -U0 origin/main..HEAD | rg '^\+.*(\.skip|xit|xdescribe|testPathIgnorePatterns)'` returned no matches (`rg` exit 1). |

## R1 blocker re-check

R1 reported two `TS7006` errors for untyped callback parameter `r`. The current test file has explicit annotations at both former failure sites:

```ts
expect(prisma._rows.find((r: any) => r.id === pkg.id).archived_at).toBeNull();
prisma._rows.find((r: any) => r.id === pkg.id).archived_at = archivedAt;
```

`npx tsc --noEmit` now exits 0.

## Guard implementation details verified

`src/packages/packages.service.ts` `archive()` currently performs:

```ts
const row = await this.requireOwnedPackage(coachUserId, packageId);
if (row.archived_at) return row;

const activeCount = await this.prisma.clientPurchase.count({
  where: { package_id: packageId, entitlement_active: true },
});
if (activeCount > 0) {
  throw new ConflictException({
    error: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS',
    message: `This package has ${activeCount} active subscriber(s). Cancel their subscriptions before archiving.`,
    active_subscriber_count: activeCount,
  });
}

return this.prisma.coachPackage.update({
  where: { id: packageId },
  data: { archived_at: new Date(), is_active: false },
});
```

This matches the required count guard and structured 409 body, with no role/owner bypass.

## Commands run

```text
npm ci
npx tsc --noEmit
npx jest test/packages-archive-guard.spec.ts --runInBand
npx jest test/doctrine-cleanup.spec.ts test/invariants/locked_defaults.spec.ts test/diagnostic-prompt-doctrine.spec.ts --runInBand
npx jest test/entitlement-guards-mounted.spec.ts --runInBand
git diff origin/main..HEAD --name-only
sha256sum prisma/schema.prisma
git diff --exit-code origin/main..HEAD -- package.json package-lock.json
git log origin/main..HEAD --pretty='%an <%ae>'
git log origin/main..HEAD --format='COMMIT %h%nTITLE %s%nBODY_START%n%b%nBODY_END'
git diff origin/main..HEAD | grep -i sonnet
git diff --exit-code origin/main..HEAD -- test/entitlement-guards-mounted.spec.ts
git diff -U0 origin/main..HEAD | rg '^\+.*(\.skip|xit|xdescribe|testPathIgnorePatterns)'
nl -ba src/packages/packages.service.ts | sed -n '270,312p'
nl -ba test/packages-archive-guard.spec.ts | sed -n '150,225p'
```

## Notes

Before `npm ci`, `npx tsc` and Jest could not run because dependencies were absent (`typescript`/`ts-jest` unavailable). After `npm ci`, all required verification commands passed. The working tree was clean before writing this audit report.
