# C1-S1: durable owned setup, not an accepted import run

Status: local candidate; not consumer-frozen, merged, deployed or product-accepted.
Contract version `2.0.0-c1-s1.0` is a prerelease identifier, not the integrated
recovery contract. The existing recovery/identity and forward-2.x dependencies
must be reconciled before consumers.

## Authority and donor provenance

This slice follows the setup recovery boundary in the Roman-led plan:
https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/160928b98c57a6034cd8b7bcfba537e81c63f054/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md

Base: `925780e0a1906593e5383c618311b6b17364b8dc`.
Recovered donor C1a: `10ed890a7bfdfe778c552a31d3cf67d0470d2e32`,
tree `404dd55d2fde7ab9fab46fb4ea1d27a9d79a7556`.
Recovered donor C1b: `f7c61ef409488dffc8d0ef3f2342b127f845c00e`,
tree `660e436ecbf911b6984b40ed43d135e3dc308378`.
Their DTOs, owned session route, ownership predicates, intent echo and regression
assertions are reused. Their pair-row-only persistence and nontransactional init
are replaced; source recovery is not acceptance.

## Contract

- `POST /api/extension/pair/init`: existing `chosen_platform`, optional UUIDv4
  `setup_nonce`. Persist the nonce in account-scoped non-secret client storage
  before requesting init. Same owner/nonce/platform returns the same live code,
  ID and expiry. Different platform with the same nonce returns
  `409 setup_nonce_conflict`, without mutation.
- Missing nonce remains legacy non-idempotent init; no automatic promotion of
  client-generated Scout intent strings to server-owned runs.
- `POST /api/extension/pair/current {}` reads current owned setup.
  `{setup_nonce}` recovers an exact older attempt without knowing its server ID.
  This also recovers an expired attempt after a lost init response.
- `POST /api/extension/pair/session {import_intent_id}` reads known owned setup.
  Both reads return only status, ID and chosen platform; no tokens/code. Unknown,
  foreign or inactive-owner reads are 404. Existing roles, throttle and dark
  pairing-prefix guard apply. Current/session/init/redeem responses are no-store.
- Replaying an expired, used, locked, superseded or retired challenge returns
  `410 setup_challenge_unavailable`. It does not extend TTL or silently mint a
  replacement. Recover the reference using current with the saved nonce; an
  explicitly new attempt uses a new nonce.
- Error envelopes remain unchanged. The shared filter does not carry arbitrary
  ID fields, so exact-nonce current lookup—not an error-body extension—provides
  recovery.

## Persistence, concurrency and authority

`ImportIntent` stores setup identity separately from `ExtensionPairCode`.
Account/nonce uniqueness and a partial unique index enforce at most one current
setup per coach. A composite foreign key prevents foreign-owner challenge links.
Intent deletion cascades to its challenge, never the reverse.

All new-binary init paths serialize on the authenticated active coach/owner row.
Nonce lookup, supersession, intent/code creation and old-unused-code expiration
are one transaction. Code collisions alone retry, outside the aborted transaction,
within the existing five-attempt budget. ID/nonce/other constraint failures
propagate, not disguised as code collisions. PostgreSQL lock/statement timeouts
are 2/4 seconds; Prisma transaction timeout/maxWait are 5 seconds.

Redeem still uses the existing Supabase token authority and mint-before-claim.
The conditional code claim and durable paired marker now commit together under
the same owner lock; eligibility is checked again after mint. No token storage,
token replay, new credential issuer or executor is introduced.

`paired` means code consumed. It proves neither receipt of the credential reply,
a currently valid extension connection, accepted Start, active execution, nor
native completion. Losing/orphaned Supabase mints and lost redeem replies remain
unsolved. Source principal/workspace evidence, connection-specific revocation
and in-flight refresh fencing remain auth/lifecycle prerequisites.

## Compatibility, retention and rollback

The migration is additive: legacy codes keep NULL intent links. A legacy-shaped
writer can still insert and an old client can ignore additive response fields.
Old binaries do not participate in the new owner lock and may expire challenges
outside the transaction. Advertise no nonce-recovery capability until all
pairing writers have upgraded; do not infer mixed-binary semantic safety from
schema compatibility.

Intent persists after challenge deletion; hard owner deletion cascades. No reaper
or automated intent deletion is added. Code retirement/recycling, legacy
code-status behavior after retirement, and approved retention/erasure policy are
activation blockers. This candidate does not solve finite code-space capacity.

After issuing even one intent, retain schema and use compatible forward repair.
The down migration locks the tables and refuses to erase issued IDs. Its successful
use is limited to empty-intent disposable/pre-use proof. Application rollback
does not authorize deletion or imply continued availability of new read routes.
The emptiness query sets transaction-local `row_security = off`, which rejects
an RLS-filtered query rather than disabling or bypassing RLS. A non-bypass owner
therefore fails closed, including for an empty table; ownership alone is not
proof of complete visibility. Enabled/forced RLS and role privileges are unchanged.

## Verification and release boundary

Real PostgreSQL tests are in `test/rls-c1-setup.spec.ts`; they require a separately
acknowledged local disposable cluster and check the actual server data directory
before resetting three fixture tables. No fallback to application database URLs,
implicit skip, or mock substitute is allowed. The fixture uses the actual base
pair-code DDL and this migration, plus a minimal User/Role dependency; it is not
a rehearsal of every backend migration or a deployed-binary compatibility test.
Tests use a BYPASSRLS service role and hostile-permissive-policy probes for anon
and authenticated roles. Local evidence does not establish hosted CI selection.

Native-family writing, reconciliation, Start/cancel/deadline, commit epochs,
Roman/extension consumers and production activation are excluded. Full G2
staged identity precedes integrated G3 acceptance. This source candidate does
not authorize main merge, which may trigger deployment, or any flag change.
Applicable Tier-4 exact-head independent assurance remains required:
https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/160928b98c57a6034cd8b7bcfba537e81c63f054/AGENT_RULES.md
