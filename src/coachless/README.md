# Coachless Home (A1-COACHLESS)

Gives a client with no coach a complete Home plus one clear way to get a coach: enter a coach
code. Kill switch: `FEATURE_COACHLESS_HOME` (only the value `"true"` turns it on; unset means
off). When the flag is off, every client route returns `404 coachless_disabled`. The mobile flag
key is `coachless_home`, and it is true only for students when the env is on.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /coachless/home` | client | Banner (`title`, owner `offer_text`, `code`), Roman card (`text`, `code`) or the reason it is hidden, featured coach card with its package. `eligible:false` once a coach is attached. |
| `POST /coachless/coach-code/check` | client | Instant validation for the code sheet. Writes nothing. Returns `{valid:true, coach}` or `{valid:false, code}`. The coach card (here, on redeem and on the featured coach) also carries `headline` (K1 headline, else K1 bio, or null) and `specialties` (K2 keys, max five, or []) — COACH-CARD-134. |
| `POST /coachless/coach-code/redeem` | client | Attaches the client to the coach. Requires an `Idempotency-Key` UUID header. Returns the coach card plus `next.featured_package` / `next.packages_available` for the attach screen. |
| `POST /coachless/roman-card/seen` | client | Records one impression (the frequency cap). |
| `POST /coachless/roman-card/not-now` | client | Persists "Not now", which snoozes the card and, after `roman_max_not_now`, hides it for good. |
| `GET /admin/featured-coach/coaches` | owner | Coach list for the in-app editor: every coach account with its active packages (the same set the PUT accepts). |
| `GET/PUT /admin/featured-coach` | owner | Reads and edits the featured coach, code, package, banner title, offer text, Roman copy, accepting switch and caps. The change is audited as `featured_coach_config.updated`. `create_code_if_missing` mints a vanity code (for example `GP-BRADLEY`) for the featured coach. |

All copy (banner title, offer text, Roman pitch) and the featured code come from
`FeaturedCoachConfig`. None of it is in the code. The config is cached for 30 seconds, and a save
invalidates the cache.

## Redemption

`CoachCodeRedemptionService` delegates the write to the single canonical attach writer,
`InviteCodesService.attachUserToCoachByCode`. That writer handles tenancy (no re-parenting a
client of another coach), seat accounting and the redemption analytics.

The service adds:

- **Ledger.** `CoachCodeRedemption` with a unique `(user_id, idempotency_key)`.
- **Retries.** A retry with the same key replays the stored response with `replayed:true`. A key
  reused for a different code returns `422 idempotency_key_reused`. Failed keys, and claims stuck
  `in_progress` for 60 seconds, can be reclaimed.
- **Specific error codes.** `code_invalid`, `code_expired`, `code_revoked`, `code_exhausted`,
  `code_email_mismatch`, `coach_not_accepting`, `already_attached`, `role_cannot_redeem`,
  `account_not_found`, `idempotency_key_required`, `idempotency_key_reused`,
  `redemption_in_progress`, and `redemption_failed` (which carries `request_id`).

## Roman card

The Roman card is scripted. It uses no AI and has no consent dependency. It is shown only when
all of these hold:

- the owner enabled it;
- pitch copy exists;
- the featured coach is accepting (owner switch on, active subscription, code valid);
- the client has no coach.

Caps, all editable by the owner:

- one impression per `roman_min_hours_between`;
- at most `roman_max_per_week` per rolling 7 days;
- "Not now" snoozes for `roman_snooze_days`;
- after `roman_max_not_now` "Not now"s, the card never returns.

## Data and RLS

Migration `20270301000000_coachless_featured_coach` creates three tables, all with RLS enabled
and forced, anon revoked and denied, and writes allowed only to `service_role`:

- `FeaturedCoachConfig` is a singleton that only the owner can read.
- `CoachCodeRedemption` and `CoachlessPromptState` can be read only by their own user.

The live proof is `test/rls/coachless-rls.spec.ts`.
