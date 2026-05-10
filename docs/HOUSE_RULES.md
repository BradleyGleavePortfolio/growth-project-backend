# House rules — growth-project-backend

This file is the canonical doctrine for code, copy, and commit
discipline on this repository. Every PR must comply.

It is owned by Bradley Gleave and updated as the rules evolve.
Last revised: 2026-05-10 (Sprint B v2.1).

## Code discipline

- Strict TypeScript posture. No `any`. No `@ts-ignore` and no
  `@ts-expect-error` without an inline justification comment that
  names the constraint and the planned fix.
- Lint must pass. `no-empty` is `error` with `allowEmptyCatch: false` —
  every `catch` must either rethrow, log, or annotate.
- Every PR carries an updated README section or a standalone RFC
  document. The PR body alone does not satisfy the rule.

## Copy discipline

- No emoji. Anywhere. Includes commit messages, PR bodies, code
  comments, log lines, error strings, and user-facing copy.
- No exclamation points. Anywhere. Same scope as the emoji rule.
- No marketing superlatives in user-facing copy. Plain English.
  "Approximately 11x" is fine; "incredible 11x" is not.

## Forbidden token list

The following tokens are forbidden in source code, comments, copy
strings, DB enum values, and DTOs. Any occurrence in a PR is a
review blocker.

- `Income` (the word, not domain terms like `debt_to_income` or
  `savings / income` which are accepted finance terminology — the
  rule is meant to catch marketing copy like "manage your income"
  rather than well-named ratio fields)
- `netWorth`
- `confetti`
- `trophy`
- `revolutionary`
- `gamechang*` (any inflection — `gamechanger`, `gamechanging`)

The forbidden list is doctrine, not currently enforced by ESLint.
Adding a `no-restricted-syntax` rule is a separate decision: today
the rule is enforced by code review and by this document.

### Carve-outs and exceptions

The following tokens are explicitly permitted because they name
load-bearing parts of the product domain:

- `finance` — TGP is a multi-pillar product spanning fitness,
  finance, and business coaching. The federation surface
  (`/federation/insights/finance-summary`), the cross-pillar
  insights envelope (`status: 'finance_unavailable'`), and the
  user-facing copy ("connect your finance account to unlock
  cross-pillar insights") all reference this pillar by name.
  Banning the token would force renames on every cross-pillar
  surface and produce worse copy. The token stays.

The carve-out applies repository-wide. There is no need to escape
`finance` in tests, controllers, services, types, or docs.

## Brand

- Oxblood `#4A0404` is the brand accent. Backend repo rarely needs
  it; when it does (e.g. PDF stylesheet for a coach report), use
  the exact hex literal once and reuse via constant.

## Migrations

- Additive only. No `DROP TABLE` / `DROP COLUMN` / data-destructive
  `ALTER COLUMN` against tables with rows in production.
- Migration directory names are `YYYYMMDDHHMMSS_short_slug`. Do
  not reuse a timestamp prefix that already exists on `main` —
  Prisma keys on the full directory name, but two migrations
  sharing a numeric prefix make `_prisma_migrations` listings hard
  to read and break tooling that sorts by prefix alone.
- Every new table gets indexes that match its read patterns. FK
  cascade behavior is `CASCADE` for owned children (e.g. plan
  exercises) and `RESTRICT` where archive-not-delete is the
  expected lifecycle (e.g. meal templates referenced by daily
  plans).
- Reversibility is documented at the bottom of each migration as
  a `DROP TABLE … CASCADE;` block in reverse order.

## Auth and tenancy

- `JwtAuthGuard` is global via `APP_GUARD`. Public routes use the
  `@Public()` decorator.
- `CoachGuard` is per-route. Every route under a coach surface
  (`/coach/...`, `/workout-plans`, `/coach/clients/:id/...`) must
  carry `@UseGuards(JwtAuthGuard, CoachGuard)`. Tenancy
  (coach-can-only-touch-their-own-clients) is enforced inside the
  service, but the role boundary is enforced by the guard.
- Tenancy guards in services use the 404-not-403 convention: a
  cross-tenant lookup returns `NotFoundException`, not
  `ForbiddenException`, so the existence of a row owned by
  another tenant is not leaked.

## Testing

- Jest config: `roots: ['<rootDir>/test']`. Colocated specs in
  `src/**/*.spec.ts` are NOT picked up by `npm test` today. New
  tests go in `test/`. (This is a known wrinkle; fix is
  out-of-scope for Sprint B.)
- Each new controller class ships with at least one guard test
  and at least one happy-path test. Tenancy edge cases are
  covered when the service is non-trivial.
