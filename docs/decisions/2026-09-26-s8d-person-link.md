# S8-D / S8-E + D-S8-LINK: imported `Person` → signed-up account

- **Status:** T4 decision record and slice plan (identity, account linking, schema, security).
  Drafted for independent T4 review and Bradley's sign-off. It changes no code, schema or API,
  claims nothing has run, and grants no builder, PG slot or review. Nothing in §2-§6 is built.
- **Date:** 2026-09-26. **Decision owner:** Bradley Gleave (repo owner). D-S8-2 and D-S8-LINK
  below are his decisions, quoted verbatim; everything else in this record is the executing
  parent's derivation from them and from the tree, and §7 lists what could not be derived.
- **Read tree:** backend `integration/importer` at `dda794d7e8bee0482a7ad373795fcc51dcf54bb5`
  (S11-B r2). Unprefixed `path Lx` means that tree. Mobile paths are the `mobile` checkout at
  `affc2818` and are named, not line-cited.
- **Sources:** "S8-DOC" = `docs/decisions/2026-09-24-s8-native-contract.md`; "S9-DOC" =
  `docs/decisions/2026-09-25-s9-reconciliation.md`; "S11-DOC" =
  `docs/decisions/2026-09-26-s11-journey.md`; the owner decision file
  `private-evidence/execution/fa72efb2/OWNER_DECISION_S8D_2026-09-26.md` ("OWNER").
- **Build rule (OWNER):** graded T4; slices sequenced after S11-A2's migration-count pin;
  production enablement remains owner-reserved.

## 1. Decision

### 1.1 Owner decision (verbatim, OWNER 2026-09-26 17:44Z)

> "I like the linking decision - log it as official Bradley decision - EXECUTE"

Decided by Bradley Gleave (owner), 2026-09-26 17:44Z. Supersedes the D-S8-2 interim for its end
state. The decided text (OWNER, reproduced without change):

**D-S8-2 = option (a):** client-owned native records may belong to an imported Person (nullable
`person_id` beside the User FK, family by family); the coach roster shows imported Person rows as
"imported, not yet joined" until they join. No login User is minted for an imported person (D2
stands); email is never an identity or linking key (D2 stands).

**D-S8-LINK** (linking an imported Person to the account of the human who signs up):

- **L1** Never automatic. No link by email, name, phone or any fuzzy match; suggestions may be
  shown to the coach, never applied.
- **L2** Main path: coach taps Invite on an imported Person → single-use, expiring, revocable
  invite bound to exactly that Person, sent to a contact the coach confirms (held on the invite,
  not as identity).
- **L3** Verified contact: the client chooses email OR phone, but only among the contacts the
  coach holds for that Person; one-time code verification of that channel is required. A contact
  typed in by the claimant is never accepted for the claim.
- **L4** Client confirmation ALWAYS required ("Coach X brought over your history: … Is this
  you?"). "No" leaves it unlinked and notifies the coach.
- **L5** Fallback (client joined another way): coach may approve a suggested match; the client
  must still confirm (two-sided).
- **L6** Integrity: one Person ↔ at most one account per coach; never across coaches/tenants;
  every link/unlink audited; records are handed over (re-owned), never copied; replays idempotent.
- **L7** Undo: for 30 days after linking, EITHER the client or the coach can unlink. Only imported
  records return to the Person; anything logged after joining stays with the client; the other
  side is notified; re-linking needs a fresh invite + fresh client confirmation. After 30 days the
  coach cannot unlink alone; client data rights (deletion/export) and admin support apply.
- **L8** Merges (already-a-client, or the same person imported from two platforms): two-sided
  confirmation, same rails.

Bradley's earlier answers that this decision fixed (OWNER 17:41Z, verbatim): "1.) verify email OR
phone, let them decide? 2.) Always have client confirmation required 3.) Yes, 30 days to undo VIA
coach side? Or client/coaches both can unwind linkage?" — resolved as L3 (client picks the channel
among coach-held contacts), L4, and L7 (both sides within 30 days).

### 1.2 What it supersedes in S8-DOC

| S8-DOC text                                                                                                                                                                                         | Effect of this decision                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-S8-2 interim, option (b): S8 writes only coach-owned families; client-owned history is `unresolved:no_native_client_principal` (S8-DOC L72-74)                                                    | Superseded for the end state by option (a). The interim stays the truthful reported outcome until S8-E ships a person-owned native writer for a family; no family reports `complete` before its writer lands.                                         |
| "Reserved to Bradley, option (a)" (S8-DOC L84-87) and "S8-D (roster bridge) and S8-E (client-owned writers) stay blocked on this decision" (L88-89)                                                 | Decided. S8-D and S8-E are unblocked, sequenced in §6.                                                                                                                                                                                                |
| §4.1 qualifier: "until S8-D, imported clients are not shown in the `User`-based coach client list … `roster_bridge_pending`" (S8-DOC L372-374)                                                      | Stands until slice S8-D2 (§6) lands; then the qualifier is retired at the three places that emit or pin it (`src/scout/reconciliation/facts.service.ts` L145-148; `src/scout/scout-roster.dto.ts` L42; `src/scout/scout-roster.service.ts` L175-178). |
| §4.5 client-owned families "blocked on D-S8-2; recorded for S8-E" (S8-DOC L440-462)                                                                                                                 | Unblocked. §4.5's column rules and constraints remain S8-E's per-family contract; §2 below adds the owner column, the exactly-one-owner constraint and the provenance rule they must honour.                                                          |
| D-S8-3 "Email is never an identity or linking key" (S8-DOC L102); D2 comment "linked to an AuthPrincipal only later, via an explicit credential-verified claim" (`prisma/schema.prisma` L6943-6950) | Confirmed, not changed. The claim in §3 is that credential-verified claim. Email/phone appear only as a delivery contact on an invite and as a one-time-code channel, never as a key.                                                                 |

Nothing else in S8-DOC (D-S8-1, D-S8-3, D-S8-4, §3, §4.2-4.4) is touched.

## 2. Data model

### 2.1 Client-owned tables that gain `person_id`

Every client-owned native table today carries a required FK to `User`:

| Model                     | Owner column today                                                | Children (inherit ownership through the parent, no `person_id`) | Native uniqueness to honour                                               |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `WorkoutSession`          | `user_id String` + `user User` (`prisma/schema.prisma` L864-865)  | `ExerciseSet.workout_id` (L881-882)                             | none; hot index `(user_id, date)` L876                                    |
| `WeightLog`               | `user_id` (L932-933)                                              | —                                                               | none; index `(user_id, date)` L940                                        |
| `Habit`                   | `user_id` (L1038-1039)                                            | `HabitLog.habit_id` (L1049-1050)                                | none                                                                      |
| `CheckIn`                 | `user_id` (L1104-1105); optional `coach_id` (L1106)               | —                                                               | `@@unique([user_id, date])` L1129; indexes L1131-1132                     |
| `ClientWorkoutAssignment` | `client_id` + `client User` with `onDelete: Cascade` (L2327-2328) | `ClientWorkoutAssignmentSnapshot` (L2352)                       | `idempotency_key @unique` L2336, `ai_draft_id @unique` L2348; index L2354 |

This is the full S8-E native target list from S8-DOC §4.5 (L448-461). The other client-owned
canonical families S8-DOC names (notes, goals, measurements, profile; L442-444) have no
person-capable native destination at this base (`UserProfile` is 1:1 with `User`, L755-758) and
stay `unresolved:no_native_client_principal` / `unresolved:no_native_destination:<family>` (S8-DOC
§3.7) until a destination exists (§7 OQ-9).

Change per table (S8-D3, §6):

- `user_id` (or `client_id`) becomes nullable; add `person_id String?` with
  `person Person? @relation(...)`, `onDelete: Restrict` (a Person with owned rows is never
  silently dropped; erasure is an explicit path, §2.3).
- **Exactly-one-owner CHECK**, hand-written SQL because Prisma cannot express it (precedent: the
  S8-B shape CHECKs in `prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql`
  L141-149): `CHECK (("user_id" IS NULL) <> ("person_id" IS NULL))` (`client_id` for
  assignments). No row is ever ownerless or double-owned; a link or unlink flips the pair inside
  one UPDATE.
- Indexes mirroring the hot paths: `(person_id, date)` on `WorkoutSession`, `WeightLog`,
  `CheckIn`; `(person_id)` on `Habit`; `(person_id, scheduled_for)` on
  `ClientWorkoutAssignment`.
- `CheckIn`: a partial unique `(person_id, date) WHERE person_id IS NOT NULL` so the
  one-per-day rule (L1129) also holds for person-owned rows (a PostgreSQL unique index treats
  NULLs as distinct, so the existing `(user_id, date)` key alone would not constrain them).
- Type ripple: the generated `user_id: string` becomes `string | null` on these models. At this
  base the models are touched from 16 / 10 / 5 / 19 / 8 non-spec files respectively
  (`rg -l "\.workoutSession\." src` etc.); the builder must compile-fix reads without changing
  behaviour for user-owned rows. Counted in S8-D3's LOC (§6).

### 2.2 RLS and tenant rules

- Existing policies on these tables compare `"user_id" = app.current_user_id()`
  (`prisma/migrations/rls_fitness_backend.sql` L136-146; `CheckIn` also admits the row's
  `coach_id`, L123-132). With `user_id` NULL the predicate is NULL → deny, so person-owned rows
  are unreadable to `anon`/`authenticated` by construction (fail-closed); the header (L1-6)
  records that the application connects as `service_role` and the policies protect direct
  access. **No new permissive policy is added for `person_id`.** Coach access to person-owned rows
  is server-side only, through code that asserts `person.coach_id = caller` the way the roster
  reader does (`src/scout/scout-roster.service.ts` L32-34, L203-208).
- `Person` itself stays `service_role`-only with RESTRICTIVE deny-all to `anon` and
  `authenticated` (`prisma/migrations/20261223000200_scout_reconstruction/migration.sql`
  L76-86). Every new table in §2.4-2.5 copies that posture exactly.
- Tenant rule (L6): a `Person` belongs to one `coach_id` (`schema.prisma` L6961, unique
  external_ref L6971). A link may only bind it to a `User` whose `coach_id` (L164) is that coach,
  or is NULL and becomes that coach inside the link transaction (the same attach that
  `attachUserToCoachByCode` performs, `src/invite-codes/invite-codes.service.ts` L606-609, minus
  the code). A `User` attached to another coach is refused (§7 OQ-4). Owners are refused, as
  today (L563-568).

### 2.3 `Person` states and transitions

`PersonState` is `InvitePending | Invited | Claimed | Suspended | Deleted` (`schema.prisma`
L6951-6957); today only the default (`InvitePending`, L6965) and the roster's `Deleted` exclusion
(`scout-roster.service.ts` L207) are used. `Person` keeps **no** contact, email or account column
except the link pointer below (D2 comment L6943-6950 stands).

Add `Person.linked_user_id String?` (indexed, not unique: the current active account; NULL unless
`Claimed`). It is redundant with the active `PersonLink` (§2.5) and exists so that roster reads
and the XOR flip need no join; the link transaction writes both or neither. Cardinality is
enforced on `PersonLink` (§2.5), not here, so that the L8 merge case stays expressible (OQ-1).

| From            | To              | Trigger                                                                                                                     | Slice |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| `InvitePending` | `Invited`       | Coach mints a `PersonInvite` (L2)                                                                                           | D4a   |
| `Invited`       | `InvitePending` | The only open invite expires, is revoked, or the client answers "No" (L4); coach notified on "No"                           | D4    |
| `Invited`       | `Claimed`       | Link transaction commits (L2-L4)                                                                                            | D4b   |
| `InvitePending` | `Claimed`       | Coach-approved match confirmed by the client (L5) or merge (L8) — no invite row                                             | D6    |
| `Claimed`       | `InvitePending` | Unlink by client or coach within 30 days (L7); after that only admin; re-link needs a fresh invite and a fresh confirmation | D5    |
| any but Deleted | `Suspended`     | Coach or admin freeze; no invite can be minted or claimed while suspended (trigger set is OQ-8)                             | D4a   |
| any             | `Deleted`       | Erasure. Terminal. Excluded from roster (L207). A `Claimed` Person cannot be deleted while it has an active link (OQ-7)     | —     |

Reconstruction replays keep upserting `display_name` (`src/scout/reconstruct/families.ts`
L98) and never touch `state` or `linked_user_id`.

### 2.4 `PersonInvite` and `PersonInviteChallenge` (new; not the existing `InviteCode`)

Why not reuse `InviteCode` (`schema.prisma` L729-753): it is a coach-attach code, not a
Person-bound claim. Its only recipient binding is `intended_email` compared against the redeemer's
**login** email (`invite-codes.service.ts` L583-592), which (i) is email-as-linking-key, forbidden
by L1/L3 and D-S8-3 (S8-DOC L102), and (ii) is checked before that email is verified — `register`
creates the `User` row and returns `requires_verification: true` (`src/auth/auth.service.ts`
L132-156) and `signupWithCode` attaches the coach in the same call (L928-936). Its `GP-XXXXXX`
code is a 30-bit space defended by throttles alone (`src/invite-codes/README.md` "Code shape";
`generateCode` L81-88), and `acceptByToken` distinguishes not-found / revoked / expired / used in
its messages (L886-903), which a Person-bound claim must not do. What **is** reused: the
per-coach `assertCoachCanAcceptClients` gate (L65-76), the email transport and template
(`EmailTemplateKey.COACH_INVITES_CLIENT`, `src/email/email.types.ts` L16; send precedent
`_sendInviteEmail` L793-832 with an idempotency key per invite row L816-819), the sub-coach
attribution pattern (`invited_by_user_id`, L734-740), and the atomic single-use claim pattern of
`ExtensionPairCode` (`src/extension-pair/extension-pair.service.ts` L319-327) with its per-row
`failed_attempts` lockout (`schema.prisma` L6748-6751; `REDEEM_MAX_FAILED_ATTEMPTS = 5`, service
L41).

`PersonInvite` (service_role only; RLS as §2.2):

| Column                                                                             | Rule                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `coach_id`, `person_id` (FK Person, Restrict)                                | Bound to exactly one Person (L2). `coach_id` is the bearer coach, re-asserted against `person.coach_id`.                                                                                                            |
| `created_by_user_id`                                                               | Head coach or sub-coach who tapped Invite (attribution as `InviteCode.invited_by_user_id`, L734-740).                                                                                                               |
| `token_hash` `@unique`                                                             | sha256 of a ≥128-bit `crypto.randomBytes` URL token. The raw token is returned once to the sender path and never stored or logged (R30 precedent, `auth.service.ts` L310).                                          |
| `contact_email`, `contact_phone` (nullable, at least one)                          | The contacts the coach **confirmed** for this Person (L2, L3). Held on the invite only; scrubbed to NULL when the invite reaches a terminal status. Never copied to `Person` or `User`; never used as a lookup key. |
| `sent_via` (`email` \| `phone`), `sent_at`, `send_status`                          | Delivery of the invite link itself; `send_status` is the transport's truthful outcome (`sent` \| `logged` \| `failed`, as the bulk invite reports, `invite-codes.service.ts` L619-634).                             |
| `status` (`open` \| `claimed` \| `declined` \| `revoked` \| `expired`)             | Partial unique `(person_id) WHERE status = 'open'`: at most one open invite per Person.                                                                                                                             |
| `expires_at`                                                                       | Required. Default 14 days as `InviteCode` (L143, L841-843); OQ-5.                                                                                                                                                   |
| `revoked_at`, `revoked_by_user_id`, `claimed_at`, `claimed_link_id`, `declined_at` | Terminal stamps; `claimed_link_id` → the `PersonLink`.                                                                                                                                                              |
| `failed_attempts`                                                                  | Per-invite counter for wrong-token / wrong-code attempts that find the row; at 5 the invite is locked (`status = revoked`, reason `locked`) and must be re-minted — the pairing precedent (service L32-41).         |

`PersonInviteChallenge` (one-time code, service_role only):

| Column                                      | Rule                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `invite_id` (FK, Cascade), `coach_id` | One challenge per (invite, claimant) at a time; earlier open challenges are voided on resend.                                                                              |
| `claimant_user_id`                          | The authenticated `User` who asked for the code. The verified challenge is usable **only** by this user (§3.2 step 3).                                                     |
| `channel` (`email` \| `phone`)              | Chosen by the client from the invite's non-null contacts; the request body carries the enum only, never a contact value (L3 by API shape).                                 |
| `code_hash`                                 | HMAC-SHA256 (server key) of a 6-digit `crypto.randomInt` code (`extension-pair.service.ts` L389-391); constant-time compare on verify.                                     |
| `expires_at`                                | 10 minutes (OQ-5). `sent_at`, `send_status` as above.                                                                                                                      |
| `failed_attempts`, `verified_at`            | Lockout at 5 wrong codes voids the challenge and charges the invite's counter; `verified_at` set once; a verified challenge expires 15 minutes after `verified_at` unused. |

### 2.5 `PersonLink` — the audit and undo record

Insert-only except for the unlink stamps; written **in the same transaction** as the re-own
(§2.7), so it is the durable audit even if the general audit write fails —
`AuditService.write` deliberately swallows its own errors (`src/audit/audit.service.ts`
L168-172, L185-215), so it is the secondary record, not the primary one (L6 "every link/unlink
audited").

| Column                                                                                                  | Rule                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `coach_id`, `person_id` (FK Restrict), `user_id` (FK Restrict)                                    | The tenant, the Person and the account. `coach_id = person.coach_id` re-asserted.                                                                                                                                                                |
| `path` (`invite` \| `coach_approved_match` \| `merge`)                                                  | L2-L4, L5, L8 respectively.                                                                                                                                                                                                                      |
| `invite_id` (nullable FK), `challenge_id` (nullable FK)                                                 | Set on `path = invite`.                                                                                                                                                                                                                          |
| `verified_channel`, `verified_contact_digest`                                                           | Channel and sha256 of the contact that was verified — never the raw contact (digest precedent: `ScoutRunDeclaration.account_scope_id_digest`, `schema.prisma` L7046-7047). NULL on `coach_approved_match`/`merge` unless OQ-6 decides otherwise. |
| `client_confirmed_at`, `coach_confirmed_at`                                                             | Both required before `linked_at` on `coach_approved_match` and `merge`; `client_confirmed_at` alone on `invite` (the coach confirmed by minting).                                                                                                |
| `linked_at`, `undo_deadline_at`                                                                         | `undo_deadline_at = linked_at + 30 days` (L7), computed once and never moved.                                                                                                                                                                    |
| `records_moved` Json                                                                                    | Per-table counts `{moved, skipped}` written by the link transaction (§2.7). Counts only, no ids or contents.                                                                                                                                     |
| `unlinked_at`, `unlinked_by` (`client` \| `coach` \| `admin`), `unlink_reason`, `records_returned` Json | Set once by the unlink transaction. `coach` is refused after `undo_deadline_at` (L7).                                                                                                                                                            |
| `merged_into_link_id` (nullable)                                                                        | On `path = merge`: the earlier active link this one joins (L8 two-platform case).                                                                                                                                                                |

Uniqueness: partial unique `(person_id) WHERE unlinked_at IS NULL` (one active link per Person,
L6). The account-side rule "at most one Person per account per coach" is a partial unique
`(coach_id, user_id) WHERE unlinked_at IS NULL AND path <> 'merge'`; how L8's two-platform merge
coexists with L6's wording is OQ-1 — the DB rail above is the recommended reading, not a decision.

Secondary audit: `AuditService.write` with actions `person.link.invited`, `.declined`,
`.linked`, `.unlinked`, `.merge_proposed`, `.match_proposed`, `.revoked`; `tenant_coach_id`,
`target_type = 'person'`, `target_id = person.id`, `target_user_id = user.id`, metadata = ids and
counts only (the service's own PII rule, L160-165).

### 2.6 What "imported" means (L7)

A native row is **imported** iff an `ImportNativeProvenance` row names it: `native_kind` = its
kind, `native_id` = its id, `outcome ∈ {created, already_present}` (`schema.prisma` L7013-7030;
uniqueness L7027; lookup index `(coach_id, native_kind, native_id)` L7028). Rows the client logs
after joining have no provenance row and therefore never move on unlink.

Add `ImportNativeProvenance.person_id String?` (FK Person, Restrict): the Person the S8-E writer
resolved as owner **at import time**, set only for client-owned kinds and never cleared. This is
the immutable "which Person did this come from" fact that the unlink needs; the owner columns on
the native row are mutable and cannot serve. Alternative rejected: a sixth column
(`imported_person_id`) on each of the five native tables — five columns duplicating what the
provenance table already is.

S8-E extends the closed CHECKs (`20270122000000_scout_native_provenance_expand/migration.sql`
L141 `native_kind`, L191 ledger `target_kind`) with `workout_session`, `weight_log`, `habit`,
`check_in`, `client_workout_assignment` (and `workout_session.exercise_set`, `habit.log` as child
kinds). `NATIVE_TARGET_KINDS` (`src/scout/reconciliation/types.ts` L81-87) and
`LEDGER_TARGET_KIND` (`src/scout/reconstruct/native/persist-outcome.ts` L14-20) grow in lockstep.

How S8-E resolves `person_id`: through the D-S8-3 key only. A staged client-owned row's
`client_source_id` role (`ScoutReconstructedEntity` soft link, `schema.prisma` L7102-7107) maps
to the Person external_ref `(coach_id, source_platform, source_person_id)` (L6969-6971). No
Person → `unresolved:relationship_pending:clients` (S8-DOC §3.5). Never by name.

### 2.7 Re-own on link, return on unlink

**Link** (one transaction, `SELECT … FOR UPDATE` on the `Person` row first):

1. Preconditions under the lock: `person.state ∈ {Invited, InvitePending}` and no active
   `PersonLink`; the invite is `open`, unexpired, unlocked, and its challenge is `verified_at`
   set for **this** `claimant_user_id` within the 15-minute window (path `invite`); the user
   exists, is not deleted/scheduled for deletion (`User` L171-176), is not `owner`, and has
   `coach_id` NULL or `= person.coach_id`.
2. `updateMany` the invite `WHERE id = ? AND status = 'open'` → `claimed`; `count !== 1` → the
   generic refusal (a lost race).
3. If `user.coach_id` is NULL: set `coach_id = person.coach_id`, `role = student` (as
   `attachUserToCoachByCode` L606-609).
4. For each of the five tables: `UPDATE … SET user_id = U, person_id = NULL WHERE person_id = P`.
   For `CheckIn`, first detect `(P, date)` rows colliding with an existing `(U, date)` row
   (L1129): they are **not** moved and are counted as `skipped` (S8-DOC §3.5
   `unresolved:native_uniqueness` semantics; never overwrite the client's own row; OQ-3 asks the
   owner whether to abort instead).
5. Insert `PersonLink` (`linked_at`, `undo_deadline_at`, `records_moved`); set
   `person.state = Claimed`, `person.linked_user_id = U`; scrub the invite's contacts.
6. After commit: notify the coach (in-app, `NotificationsService.createNotification`,
   `src/notifications/notifications.service.ts` L297-301, keyed by the coach `user_id`), audit
   secondary write, analytics without contacts.

**Unlink** (one transaction, same Person lock):

1. Active `PersonLink` exists; actor is the linked client, the Person's coach (only if
   `now < undo_deadline_at`), or admin.
2. Candidate rows = native rows `WHERE user_id = U` that have a provenance row with
   `person_id = P` and matching `(native_kind, native_id)` — joined through the L7028 index. For
   each: `SET person_id = P, user_id = NULL`. A `CheckIn` that cannot return because the Person
   still holds a `skipped` row on that date (link step 4) stays with the client and is counted
   `skipped` in `records_returned` — never overwritten. Rows without provenance (logged after
   joining) stay.
3. Stamp `unlinked_at/by/reason/records_returned`; `person.state = InvitePending`,
   `linked_user_id = NULL`; the user's `coach_id` is **not** changed (leaving the coach is a
   separate live action, OQ-4).
4. Notify the other side (both are `User`s at this point); secondary audit.

Edits the client or coach made to an imported row while linked travel with the row back to the
Person (the row is handed over, not copied, L6); whether that is wanted is OQ-2.

### 2.8 Idempotency and concurrency

| Case                                           | Rail                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirm replayed (same user, same invite)      | Active `PersonLink(person, user)` already exists → 200 with the same link id; the move `updateMany` finds 0 rows. No second audit row. (L6 "replays idempotent")                                                                                                                                                                                                                        |
| Two claimants on one invite                    | Person `FOR UPDATE` serialises; the loser sees `status <> 'open'` or `state = Claimed` → generic refusal, invite `failed_attempts` charged.                                                                                                                                                                                                                                             |
| Claim vs coach unlink                          | Same Person lock; unlink needs an active link, claim needs none — exactly one wins; the other reads the committed state.                                                                                                                                                                                                                                                                |
| Claim vs import pass writing person-owned rows | The S8-E writer reads the Person under `FOR SHARE` in its per-row transaction (the engine already runs one transaction per row with P2002 retry-once, `families.ts` L40-41, and S11-B r2 retries raw serialization failures, `dda794d7`). If `state = Claimed` it writes `user_id = linked_user_id` directly and still stamps `provenance.person_id = P`, so a later unlink returns it. |
| Claim vs revoke                                | Revoke is `updateMany WHERE status = 'open'`; the claim's step 2 is the same guard; one wins.                                                                                                                                                                                                                                                                                           |
| Invite re-mint while one is open               | Partial unique on `(person_id) WHERE status='open'` → 409; coach must revoke first (revocation is a distinct audited act).                                                                                                                                                                                                                                                              |
| Re-link after unlink                           | Fresh invite + fresh challenge + fresh confirmation (L7). The old `PersonLink` stays as history.                                                                                                                                                                                                                                                                                        |

## 3. Link flow against the existing machinery

### 3.1 Reuse vs new

| Concern          | Existing                                                                                                                                                                                                  | Disposition                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account creation | `register` (Supabase native signup, email verification pending, `auth.service.ts` L112-131), Google/Apple (L418, L539), `signupWithCode` (L900-944)                                                       | Reused unchanged. The claim requires an authenticated `User`; it never creates one (D2).                                                                                                                                        |
| Coach attach     | `attachUserToCoachByCode` (L538-617)                                                                                                                                                                      | Not called (it needs a code and fires `INVITE_REDEEMED`); the link transaction performs the same two-column attach itself (§2.7 step 3) when `coach_id` is NULL.                                                                |
| Invite object    | `InviteCode` / default per-coach link                                                                                                                                                                     | Not reused for the claim (§2.4). A coach may still hand out the default link; a client who arrives that way is the L5 case.                                                                                                     |
| Public landing   | `GET /join/:code`, `GET /invite/:code` HTML (`src/invite-landing/invite-landing.controller.ts` L30-41, throttled 60/min)                                                                                  | New `GET /join/p/:token` (or mobile deep link) that renders §3.3's pre-verification disclosure only. Same throttle posture.                                                                                                     |
| One-time code    | No SMS transport exists in the backend (`rg -i twilio` and `rg -i sms` find only a redaction pattern, `src/common/redact-secrets.ts` L52). Email: `EmailService.send` (`src/email/email.service.ts` L118) | Email OTP: new template, existing transport. Phone OTP: new transport and a paid dependency → owner-reserved spending; slice D7 (§6). Until D7 lands the choice set is whatever the coach holds that the system can deliver to. |
| Supabase OTP     | `generateLink({type:'magiclink'})` + `verifyOtp` mints a **session** for a user's login email (L333-355)                                                                                                  | Not applicable: it verifies the login email, which is not the coach-held contact (L3) and would be email-as-key.                                                                                                                |
| Notifications    | `createNotification(input, tx?)` keyed by `user_id` (L297-301)                                                                                                                                            | Coach notifications always possible; client notifications only once the client is a `User` (always true at link/unlink time). Imported Persons receive nothing in-app (no principal).                                           |
| Audit            | `AuditService.write` (L185-215)                                                                                                                                                                           | Secondary (§2.5).                                                                                                                                                                                                               |
| Roster reads     | `ScoutRosterService.getRoster` (§5); `CoachService.getClients` reads `User role=student` (`src/coach/coach.service.ts` L133-150)                                                                          | §5.                                                                                                                                                                                                                             |
| Data rights      | Account deletion deletes these tables by `user_id` (`src/account-deletion/account-deletion.service.ts` L790-795); data export module `src/data-export/**`                                                 | After link, imported rows are the client's and fall under both (L7 after 30 days). Behaviour of an account deletion **inside** the 30-day window is OQ-7.                                                                       |

### 3.2 Main path (L2, L3, L4) — endpoints are illustrative names, contract regen is S8-D4's job

1. **Coach → Invite.** `POST /scout/persons/:personId/invites` (JWT + `Roles('coach')`, same
   guards as the roster reader, `src/scout/scout-roster.controller.ts` L82-84). Body:
   `{contact_email?, contact_phone?, send_via}`. Server asserts `person.coach_id = caller`,
   state not `Suspended/Deleted/Claimed`, `assertCoachCanAcceptClients`, no open invite; mints
   the token; sends the link via `send_via`; `state → Invited`. Response has no token — it goes
   only to the contact. Coach may `DELETE …/invites/:id` (revoke) at any time.
2. **Client opens the link.** `GET /person-invites/:token` (public, throttled): returns
   `{coach_display_name, coach_business_name, channels: [{channel, masked}]}` or one generic
   `{valid:false}` for every failure (not found / expired / revoked / claimed / locked are
   indistinguishable, the `previewCode` posture, `invite-codes/README.md` "Security and tenancy
   rules"). Masking: `j***@e***.com`, `+1 *** *** 1234`. **Not** disclosed here: the Person's
   name, any record counts, the coach's other clients.
3. **Client authenticates** (existing signup/login). Then `POST /person-invites/:token/challenge`
   `{channel}` (JWT): server sends a 6-digit code to the invite's stored contact for that channel
   and records `claimant_user_id = req.user.id`. Any `contact` field in the body is rejected
   (400) — L3.
4. **Verify.** `POST /person-invites/:token/verify {code}` (JWT, same user): constant-time
   compare, lockout, `verified_at`. Only now the response carries the L4 disclosure:
   `{coach_display_name, person_display_name, summary: {families: [{family, count, from, to}]}}`
   — counts and date ranges from provenance and the owned rows, never row contents.
5. **Confirm.** `POST /person-invites/:token/confirm {answer: 'yes' | 'no'}` (JWT, same user).
   `yes` → §2.7 link transaction → 200 `{link_id, undo_until, records_moved}`. `no` → invite
   `declined`, Person back to `InvitePending`, coach notified (L4). Either answer closes the
   invite.

### 3.3 Fallback (L5) and merges (L8)

- **Suggestions (L1).** The coach roster may show, per imported Person, candidate students of
  the **same coach** by display-name similarity computed at read time. Suggestions are never
  persisted as links and never auto-applied.
- **L5.** `POST /scout/persons/:personId/link-proposals {user_id}` (coach): `user.coach_id =
caller` required (already this coach's client — the cross-tenant rail), creates a
  `PersonLink` with `coach_confirmed_at`, no `linked_at`; client receives an in-app notification
  and sees the L4 disclosure (§3.2 step 4 payload) in-app; `POST /person-links/:id/confirm
{answer}` from the linked client completes or declines. Whether L5 additionally requires the L3
  one-time code is OQ-6 (recommendation recorded there).
- **L8 already-a-client** is L5. **L8 same person from two platforms**: two Persons under one
  coach; the second link is proposed by the coach as `path = merge` with
  `merged_into_link_id` → the client confirms → the second Person's imported rows are re-owned
  to the same account by the same transaction. Each Person keeps its own link and undo clock.

### 3.4 Undo (L7)

- Client: `POST /me/person-links/:id/unlink` any time before `undo_deadline_at`.
- Coach: `POST /scout/person-links/:id/unlink` only before `undo_deadline_at`; after it the
  route answers 403 with a stable code (`undo_window_closed`) and the coach UI points to support.
- Admin: existing owner surfaces (`src/admin/**`), audited with `unlinked_by = admin`.
- Notifications to the other side in every case; "why" is free text from the actor, stored on
  the link, shown to the other side.

## 4. Threat model

| Threat                                                                                                                 | Rail that closes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Forwarded invite / account takeover**: the invite link reaches someone other than the person                         | The link alone claims nothing. Claiming needs a one-time code delivered to a contact the coach confirmed (L3, §2.4), so the holder must also control that channel; the claimant can never substitute a contact (API shape, §3.2 step 3). Then the human must say "yes" to "is this you?" (L4). The 30-day undo (L7) and coach notification on link give a recovery path if all three fail. Contrast: today's `intended_email` compares an unverified login email (§2.4).                                                       |
| **Contact change at the source / wrong contact on file**                                                               | The coach confirms the contact at invite time (L2). A wrong contact means the code reaches the wrong channel: the recipient sees only the masked pre-verification page (§3.2 step 2), never the Person's name or history, and cannot proceed without also being the account holder who confirms. The coach can revoke and re-mint at any time.                                                                                                                                                                                 |
| **Coach mistake** (invites or proposes the wrong client)                                                               | Two-sided: the client must confirm after seeing the disclosure (L4/L5). Either side can unlink for 30 days and only imported rows move back (L7). `records_moved` makes the scope of the mistake visible.                                                                                                                                                                                                                                                                                                                      |
| **Malicious coach** (tries to attach an imported history to an unrelated client, or to grab a client of another coach) | Cross-tenant is impossible by construction: `Person.coach_id` must equal the user's `coach_id` or the user must be unattached (§2.2); a link never changes an existing `coach_id`. Within tenant the client's confirmation is required, and the disclosure (name, counts, dates) lets the client refuse. Imported data is data the coach already holds, so the residual harm is showing it to the **wrong client**; minimum disclosure before confirmation keeps that to name + counts (OQ-10 on whether counts are too much). |
| **Enumeration** (of invites, Persons, accounts)                                                                        | ≥128-bit token, hash-stored, so guessing is infeasible regardless of throttle; every public failure collapses to one `{valid:false}`; 6-digit codes are defended by the four stacked layers already accepted for pairing (`extension-pair.service.ts` L378-388: TTL, per-row lockout at 5, per-IP throttle, constant-time compare). No route reveals whether a Person exists to a non-owner (the roster reader's uniform 404, `scout-roster.service.ts` L85-97, is the model).                                                 |
| **Replay** (confirm resent, invite email re-sent, webhook-style duplicates)                                            | Idempotent confirm (§2.8), single-use invite via `updateMany WHERE status='open'`, `EmailService` idempotency key per invite row (L816-819 pattern), challenge single `verified_at`.                                                                                                                                                                                                                                                                                                                                           |
| **Race** (two claimants; claim vs unlink; claim vs import; claim vs revoke)                                            | Person row lock serialises every state transition (§2.8); the S8-E writer reads the Person under the same lock discipline; serialization failures are retried by the engine (S11-B r2).                                                                                                                                                                                                                                                                                                                                        |
| **Cross-tenant data movement**                                                                                         | Every write is scoped by `coach_id` taken from the token; `PersonLink.coach_id = person.coach_id` re-asserted; the unlink join requires `provenance.coach_id = person.coach_id`; RLS on `Person`, invites, challenges and links is service_role-only (§2.2).                                                                                                                                                                                                                                                                   |
| **Contact PII at rest**                                                                                                | Contacts live only on the invite and are scrubbed at terminal status; `PersonLink` stores a digest; logs and analytics carry ids, never contacts or codes.                                                                                                                                                                                                                                                                                                                                                                     |
| **Audit loss**                                                                                                         | `PersonLink` is written in the link transaction; `AuditService.write` is best-effort by design (L168-172) and therefore secondary.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Privilege**: an `owner` or a coach account claiming as a client                                                      | Refused as `attachUserToCoachByCode` refuses owners (L563-568); the claimant must be `student` or unattached; a `coach`-role user cannot be linked (OQ-4 asks about coaches who are also someone's client).                                                                                                                                                                                                                                                                                                                    |

## 5. Roster: "imported, not yet joined" and the typed `person` handoff

### 5.1 The D2 finding (why roster-bearing imports cannot settle `complete` today)

`clientsFamily.persist` returns a plain `person.id` string (`src/scout/reconstruct/families.ts`
L83-102; documented "legacy result, ledger kind NULL", L157-158) and writes no provenance. The
engine therefore leaves ledger `target_kind` NULL (`src/scout/scout-reconstruct.service.ts`
L510-520). S9 classifies a `reconstructed` row whose kind is not native as bucket f
`unresolved` (`src/scout/reconciliation/reconcile.ts` L60-61, L136-146), which yields C-ID
`unresolved_identities`. Hence every run that stages `clients` rows settles at most `partial`
(recorded live in `private-evidence/execution/fa72efb2/s10d2/d2_diagnose_fix.md`, case (h)).

Everything downstream already admits `person` as a native kind: the provenance and ledger CHECKs
(`20270122000000_…/migration.sql` L141, L191), `LEDGER_TARGET_KIND.person`
(`persist-outcome.ts` L16), `NATIVE_TARGET_KINDS` (`types.ts` L83-87), and S9-B's `readPersons`
(`facts.service.ts` L1003-1015). Slice **S8-D1**: `clientsFamily.persist` returns
`{ok: true, targetId, targetKind: 'person', unresolvedChildren: 0}` and writes the
`ImportNativeProvenance` row (`native_kind = person`, `outcome = created | already_present`) in
the same per-row transaction, following the S8-C writers (`native-writers.ts` L92, L238). Two
corrections ride with it: (i) `readPersons` treats a `Deleted` Person as present because
`Person` has no `archived_at` (L1010-1012) — S8-D1 maps `state = Deleted` to `removed`
(S9-DOC bucket i); (ii) the `update: {display_name}` upsert branch (L98) is a later-pass
overwrite that D-S8-4 forbids for provenance-carrying native rows — whether to keep the accepted
byte-identical behaviour or go create-only is OQ-11; S8-D1 does not change it silently.

### 5.2 Rendering contract

Two readers exist: the importer-G intent-scoped roster (`GET /scout/reconstruct/roster`,
`scout-roster.controller.ts` L77-90; DTO fields `id, state, source_platform, source_person_id,
display_name, created_at, updated_at`, `scout-roster.service.ts` L225-233) and the coach client
list (`CoachService.getClients`, `User role = student`, L133-150). D-S8-2 (a) says the **coach
roster** shows imported Persons. Slice S8-D2:

- Coach roster response gains a sibling collection `imported_people[]` (not interleaved into
  the `User` array, so no existing consumer sees a non-User row): `{person_id, display_name,
state, source_platform, joined: false, invite: {status, sent_via, expires_at} | null,
suggestions: [{user_id, display_name}] | []}` for every Person of the coach with
  `state ∉ {Claimed, Deleted}`. `Suspended` is shown with its state. Label copy is fixed:
  "imported, not yet joined".
- A `Claimed` Person is not listed; instead the linked client's row carries
  `person_link: {link_id, linked_at, undo_until}` while `now < undo_until`, and `null` after.
- The importer-G roster keeps its shape and drops `roster_bridge_pending` (it becomes `false`,
  then the field is retired with the contract regen once mobile no longer reads it).
- Contract regeneration goes through the single generator (`scripts/importer-contract.ts` lists
  `/scout/reconstruct/roster` at L33; `docs/contracts/importer-openapi.json`), serialised with
  other lanes as S8-DOC §5 requires.
- Mobile: `src/screens/coach/ClientsListScreen.tsx` renders the new collection with the fixed
  label and an Invite CTA that opens the §3.2 step 1 form (pre-filled with nothing — the coach
  types the contact, because `Person` holds none); `CoachInvitesScreen.tsx` lists Person invites
  beside code invites; `import-journey/` shows "n imported, not yet joined" only from the server
  count. No UI states a link exists before the server says so (mission invariant: no fabricated
  server behaviour in UI).

## 6. Slice plan

Grades follow the T0-T4 routing; LOC = expected hand-written **production** lines (tests,
fixtures, generated contracts excluded). "Migration" = a new `prisma/migrations/*` directory.

| Slice  | Scope                                                                                                                                                                                                                                 | Grade | Depends on                                                     | Migration               | Prod LOC (est.)                                     | Ruling                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------- | ----------------------- | --------------------------------------------------- | ---------------------------------------- |
| S8-D0  | This decision record (+ 4-line forward pointer in S8-DOC D-S8-2)                                                                                                                                                                      | T4    | OWNER                                                          | no                      | 0                                                   | this commit                              |
| S8-D1  | Typed `person` handoff: `clientsFamily.persist` returns `person` + provenance row; `readPersons` Deleted → removed; S9 fixtures; roster-bearing runs can settle `complete` (D2 case (h) flips)                                        | T3    | S11-A2 landed (J19 step 11 reads the roster)                   | no                      | 150-250                                             | PROCEED                                  |
| S8-D2  | Coach roster `imported_people[]` + `person_link` marker; importer-G `roster_bridge_pending` retirement; contract regen; suggestions read (never applied)                                                                              | T3    | S8-D1                                                          | no                      | 250-400                                             | PROCEED                                  |
| S8-D3  | Schema: `Person.linked_user_id`; `PersonInvite`, `PersonInviteChallenge`, `PersonLink`; `ImportNativeProvenance.person_id`; nullable owner + `person_id` + XOR CHECK + indexes + partial uniques on the five tables; RLS; type ripple | T4    | **S11-A2 and S11-D proofs landed, or explicit re-pin** (below) | **yes** (one directory) | 450-650 (≈250 SQL + ≈120 prisma + ≈150 compile-fix) | PROCEED (schema-only; one migration)     |
| S8-D4a | Invite mint / list / revoke / send (email) / public preview; `Person` `InvitePending ↔ Invited`; audit; coach UI contract                                                                                                             | T4    | S8-D3                                                          | no                      | 350-450                                             | PROCEED                                  |
| S8-D4b | Challenge (email OTP) / verify / disclosure / confirm; link transaction (§2.7) incl. `CheckIn` collision handling; notifications; idempotency + race specs                                                                            | T4    | S8-D4a                                                         | no                      | 450-600                                             | PROCEED (split from a 900-1,000 line D4) |
| S8-D5  | Unlink (client, coach ≤30 d, admin); return-only-imported join; notifications; `person_link` marker semantics                                                                                                                         | T4    | S8-D4b                                                         | no                      | 300-450                                             | PROCEED                                  |
| S8-D6  | L5 coach-approved match + L8 merge (`path`, `merged_into_link_id`, two-sided confirm)                                                                                                                                                 | T4    | S8-D5; OQ-1, OQ-6 answered                                     | no                      | 300-450                                             | PROCEED                                  |
| S8-D7  | Phone channel: SMS transport + phone OTP; masked phone disclosure                                                                                                                                                                     | T4    | Owner decision on provider/spending; S8-D4b                    | no                      | 200-300                                             | BLOCKED (owner)                          |
| S8-E1a | `WorkoutSession` + `ExerciseSet` person-owned writer (S8-DOC §4.5 rules); provenance kinds CHECK expand; `person_id` resolution via D-S8-3                                                                                            | T4    | S8-D3; S8-D1                                                   | **yes** (CHECK expand)  | 300-450                                             | PROCEED                                  |
| S8-E1b | `WeightLog` + `CheckIn` writers (units §3.9; `reviewed_by_coach` contract amendment recorded explicitly, S8-DOC L457-460)                                                                                                             | T4    | S8-E1a                                                         | no                      | 250-350                                             | PROCEED                                  |
| S8-E1c | `Habit` + `HabitLog` writer                                                                                                                                                                                                           | T3    | S8-E1a                                                         | no                      | 150-250                                             | PROCEED                                  |
| S8-E1d | `ClientWorkoutAssignment` inactive import (PLAN L313; S8-DOC L241-245)                                                                                                                                                                | T4    | S8-E1a; owner confirms "inactive" semantics                    | no                      | 150-250                                             | PROCEED after OQ-12                      |
| UX-D2  | Mobile: roster imported rows + label + Invite form + invite list                                                                                                                                                                      | T2    | S8-D2, S8-D4a                                                  | —                       | 300-500                                             | PROCEED                                  |
| UX-D4  | Mobile: client claim screens (preview → verify → disclosure → yes/no) with minimum-disclosure rules                                                                                                                                   | T3    | S8-D4b                                                         | —                       | 300-450                                             | PROCEED                                  |
| UX-D5  | Mobile: undo affordances both sides, notifications copy                                                                                                                                                                               | T2    | S8-D5                                                          | —                       | 150-250                                             | PROCEED                                  |
| UX-EXT | Extension: no change required (roster and claim are mobile/web). Optional readiness-panel count "imported, not yet joined" from the server                                                                                            | T1    | S8-D2                                                          | —                       | ≤50                                                 | OPTIONAL                                 |

Single S8-E1 would be 850-1,300 lines; it is split by family above so no slice exceeds 1,000.

**Migration sequencing.** The S11 proof lane pins the schema: `EXPECTED_MIGRATIONS = 173`
(`test/utils/g2-s11-pg-harness.ts` L39; `test/utils/g2-s11-bootstrap.sh` L36, L159-160) and
"last (sorted) directory is S10-B's `20270124000000_scout_run_observation_expand`" (bootstrap
L164-165), with the prisma tree required byte-identical to `711c1f8f` (bootstrap L150-156;
guard `test/utils/g2-s11-db-guard.spec.ts` L194-195, L220-222). Any S8-D3 or S8-E1a migration
therefore breaks that lane's bootstrap until it is re-pinned. Rule: S8-D3 lands **after** S11-A2
and S11-D have taken their proofs on the 173-pin, or the parent re-pins the S11 harness
explicitly in the same landing (a T2 pin move, reviewed). S8-D1, S8-D2 ship no migration and may
land earlier, after S11-A2 (they change what J19 step 11 reads).

**Owner boundaries (unchanged):** production deployment and `FEATURE_*` values (`/api/scout/*`
is dark unless flagged, `scout-roster.controller.ts` L78-81), live source accounts, G3-AUTH,
S8-D/E principal enablement in production, CWS, branch protection, and the S8-D7 spending
decision. Every slice above is built and proven on `integration/importer` only.

## 7. Open questions (recorded, not decided)

- **OQ-1 L6 vs L8 cardinality.** L6 says one Person ↔ at most one account per coach; L8 lets the
  same person imported from two platforms merge into one account, which is two Persons ↔ one
  account under one coach. Recommended DB reading in §2.5 (per-Person uniqueness absolute;
  per-account uniqueness except `path = merge`). Owner to confirm, or to say the two Persons
  should instead be merged into one Person first (which needs a Person-merge primitive not
  designed here).
- **OQ-2 Edits while linked.** On unlink, an imported row that the client or coach edited while
  linked returns to the Person with those edits (handed over, not copied). Acceptable, or should
  edited imported rows stay with the client?
- **OQ-3 `CheckIn` collision on link.** An imported check-in on a date where the client already
  logged one cannot move (L1129). §2.7 proposes leave-with-Person + count as `skipped` and show
  it; the alternative is to refuse the link. Which?
- **OQ-4 Client already attached to another coach.** `User.coach_id` is single-valued (L164). A
  claim by such a user is refused in §2.2 (L6 never across tenants; changing coach is a live
  action). Confirm, and confirm that a `coach`-role user can never be linked as a client.
- **OQ-5 TTLs.** Invite 14 days (matches `InviteCode`), one-time code 10 minutes, verified window
  15 minutes, lockout 5. Confirm or change.
- **OQ-6 Does L5 need the one-time code?** The L5 client is already this coach's authenticated
  client; §3.3 proposes in-app confirmation only (the L3 code exists to bind a stranger to a
  coach-held contact, which L5 does not do). Confirm, or require the code on L5 as well.
- **OQ-7 Deletion inside the 30-day window.** If the linked client deletes their account within
  30 days, account deletion today deletes these rows by `user_id` (`account-deletion.service.ts`
  L790-795). Should imported rows first return to the Person (unlink-then-delete), or go with
  the account? Related: may a `Claimed` Person be erased while linked?
- **OQ-8 `Suspended`.** What sets and clears it (coach action, admin, automatic after N failed
  claims)? Not derivable from the tree; today no code sets it.
- **OQ-9 Families without a native destination.** Notes, goals, measurements, profile attributes
  (S8-DOC L442-444) have no person-capable table. Remain unresolved, or is a destination wanted?
- **OQ-10 Disclosure before "yes".** §3.2 step 4 shows the Person's display name plus per-family
  counts and date ranges. Is a count too much for a not-yet-confirmed claimant, or too little
  for the client to recognise their history?
- **OQ-11 `Person.display_name` overwrite on replay.** Once `person` is a provenance-carrying
  native kind, D-S8-4 create-only would forbid the accepted `update: {display_name}` branch
  (`families.ts` L98). Keep the accepted behaviour (byte-identical) or go create-only?
- **OQ-12 Imported assignments "inactive".** S8-DOC L243-245 says assignments import inactive;
  `ClientWorkoutAssignment` has no inactive flag (L2323-2358). Define it (e.g. `completed_at`
  set from source, never scheduled in the future) before S8-E1d.
- **OQ-13 Phone provider.** No SMS transport exists; choosing one is spending (owner). Until then
  the client can only choose channels the coach holds **and** the system can deliver to.

## 8. Invariant cross-check

| Invariant                                          | Held by                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| New source → core diff 0                           | Nothing here is per-source; `person_id` resolution uses the D-S8-3 key through the S8-A interpreter (§2.6).                         |
| No login `User` minted for an imported person (D2) | Claim requires an existing authenticated `User`; no route creates one (§3.1).                                                       |
| Email/phone never an identity or linking key       | Contacts exist only on the invite for delivery and as an OTP channel; `PersonLink` holds a digest; no lookup by contact anywhere.   |
| Unknown never silently becomes zero                | `records_moved.skipped`, `send_status`, and per-family `unresolved` stay visible; no family is `complete` before its writer exists. |
| No fabricated server behaviour in UI               | §5.2: labels and link markers come from server fields only.                                                                         |
| Owner-reserved boundaries untouched                | §6 boundaries; S8-D7 blocked on owner; flags stay dark.                                                                             |
| Coach edits preserved (D-S8-4)                     | Link/unlink flip owner columns only; no content is rewritten; OQ-11 recorded rather than changed.                                   |
