# PII and RLS

The marketplace mixes a fully public surface (browse/detail) with PII and
financial tables (applicant profiles, applications, offers). Two layers keep them
apart: **Row-Level Security** at the database, and a **PII-omission allow-list**
at the application boundary. Both are described against the source that ships
them.

The RLS spine is migration
[`20261220000000_talent_marketplace_rls`](../../prisma/migrations/20261220000000_talent_marketplace_rls/migration.sql)
(TM-1). It creates five tables and applies RLS using the spine idiom verbatim
from the contracts migration:

- `app.is_owner()` and `app.current_user_id()` helpers gate every policy.
- A `service_role` PERMISSIVE `ALL` policy (Primitive A) is the trusted
  server-side bypass.
- Anonymous callers (NULL `current_user_id()`) see zero rows except where a
  policy explicitly grants public read.

## Application-layer PII omission

RLS is the backstop; the application layer never relies on it alone for the
public surface. The public read path
([`public-listing.service.ts`](../../src/talent-marketplace/public-listing.service.ts))
maps every row through an explicit allow-list (`toCard` / `toDetail`) defined in
[`public-listing.dto.ts`](../../src/talent-marketplace/public-listing.dto.ts).
The raw `JobListing` entity is **never** spread into a response, so `hirer_id`,
`idempotency_key`, and any future internal column cannot leak. Adding a field to
`PublicListingCardDto` / `PublicListingDetailDto` is deliberate — the comment in
the DTO requires confirming a field is non-PII first.

The JSON-LD builder
([`job-posting-jsonld.ts`](../../src/talent-marketplace/job-posting-jsonld.ts))
is PII-free by construction: it consumes only the public detail DTO, never the
entity.

## RLS by table

### JobListing — public-read, hirer write-scope

- **SELECT** (`p_joblisting_select`, granted to `public`): a row is visible when
  `app.is_owner()`, OR `status = 'published'`, OR the caller is the owning hirer
  (`hirer_id = app.current_user_id()`). So anyone — including anon — reads
  published listings; the owning hirer additionally reads their own draft/closed
  rows; no one else sees non-published rows.
- **INSERT / UPDATE**: write-scoped to the owning hirer (`hirer_id =
  app.current_user_id()`), with the UPDATE `WITH CHECK` preventing a row from
  being re-owned to another `hirer_id`. Verified-hirer gating itself lives in the
  TM-2 service layer (`HirerVerifiedGuard`), not in RLS.

The application layer re-applies `status: 'published'` explicitly in `browse` and
`detail` as defence-in-depth, so a missing or mis-scoped policy can never widen
public visibility.

### Applicant (PII) — self read/write, head-coach read

- **SELECT**: the applicant themselves (`user_id = app.current_user_id()`), or
  the head coach of that applicant **once** they are flipped to a non-archived
  sub-coach — reusing the existing `TeamSubCoachAssignment` non-archived `EXISTS`
  predicate verbatim. Anon sees zero; cross-applicant reads are denied (IDOR /
  PII).
- **INSERT / UPDATE**: write-scoped to `user_id = self`; UPDATE `WITH CHECK`
  pins `user_id` so a profile cannot be re-owned.

### Application (PII) — applicant + hirer read

- **SELECT**: the applying user (`applicant_user_id`) or the owning hirer of the
  listing (`hirer_id`). Anon sees zero; cross-principal reads denied.
- **INSERT**: only the applying user (`applicant_user_id = self`) — hirers never
  create applications.
- **UPDATE**: the applying user may withdraw their own application; the owning
  hirer may advance pipeline status on applications to their listing. The
  `WITH CHECK` keeps both columns owner-pinned.

### CoachOffer (financial) — head-coach + applicant read

- **SELECT**: the offering head coach (`head_coach_id`) or the applicant the
  offer was made to (`applicant_user_id`). Anon sees zero; cross-coach reads
  denied.
- **INSERT**: only the offering head coach (`head_coach_id = self`).
  Head-coach-only gating is enforced in the (future) TM-12 service layer.
- **UPDATE**: the head coach may withdraw/edit their own offer; the applicant may
  accept/reject an offer made to them. The atomic accept-with-withdraw-others
  step runs as `service_role`.

### MarketplaceMutationIdempotency — service-role only

The idempotency ledger carries **RESTRICTIVE deny-all** policies for both `anon`
and `authenticated`, which AND with any permissive grant. Only `service_role`
(Primitive A) can read or write it — the TM-4 mutation engine. No client
principal can ever touch the ledger.

## Where this lands for the apply funnel (TM-5)

TM-5 is **merge-ready, awaiting operator PII sign-off** (PR #435; ADR-0002
decision 8 requires operator sign-off for PII/auth-surface PRs). The tables and
RLS above are already on `main` (TM-1), so the apply funnel writes into a fully
RLS-scoped schema: a minted pre-coach user can insert only their own `Applicant`
and `Application` rows, and the public surface continues to expose nothing beyond
the published-listing allow-list. The funnel does not relax any policy described
here.

## Foreign-key delete posture

User deletes `RESTRICT` against live marketplace rows (`JobListing.hirer_id`,
`Application.applicant_user_id`/`hirer_id`, `CoachOffer` principals) so a delete
fails loudly rather than orphaning PII or financial state. `Applicant.user_id`
cascades (the profile is owned by the user), and the `Application → CoachOffer`
FK cascades so an offer cannot outlive its application.
