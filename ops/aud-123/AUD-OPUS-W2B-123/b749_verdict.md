AUDIT Claude Opus 5.5 — growth-project-backend#749 @ ef3bdb4abe994ed46b5416a14249a7fbe71736ff — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), queue R3C item 3 (READY FOR AUDIT comment 6009823835). Full review of the 110-line diff at the exact head against main. All required checks green at this head (build-and-test, community-live-tests, rls-live-tests, mwb-3-live-tests, banned casts, Danger, Schema parity, CodeQL, npm audit; deploy-readiness-gate skipped as usual). No new casts to any/unknown/never, no empty catch, no schema change.

**A: 0 | B: 0 | C: 1**

### Checked
- Access: `GET /admin/featured-coach/coaches` sits on `FeaturedCoachAdminController` (class guards `JwtAuthGuard, OwnerGuard`) with `@Roles('owner')`, so only the platform owner sees the coach list (names, emails, business names, active packages). No client or coach can reach it. It is a static path with no clash with the existing `GET /` and `PUT /`.
- Consistency: candidates are `role: 'coach', deleted_at: null` users, and packages use the same filter as `activePackageOf` (`is_active: true, archived_at: null`), which the PUT uses to validate `package_id`. The editor therefore never offers a package the PUT would refuse. Read-only: no write, no audit row needed.
- Bound: 200 coaches (launch size), sorted by name then id; packages are fetched in one query and grouped in memory.

### C (one line)
- C-749-1: only `role: 'coach'` accounts are candidates (no sub_coach, no owner-role account), which matches the PUT's `featured_coach_invalid` rule; the owner needs a separate coach account to be featured (builder's documented default).
