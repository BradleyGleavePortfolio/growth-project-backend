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
- **Round 2 (2026-09-26, same day):** revised after the independent T4 review
  (`private-evidence/execution/fa72efb2/s8d/s8d_review.md`, verdict NO-GO on Round 1 `ded755ab`).
  B1-B5 are closed in §2.2, §2.5, §2.3/§3.3, §5.1 and §3.5; the C-findings are folded in where
  named; §7 now separates what is decided by derivation from what only the owner can answer.
  §9 maps each finding to the text that closes it. Nothing in Round 2 changes L1-L8.
- **Round 3 (2026-09-26):** delta review of Round 2 found two internal contradictions (B6
  disclosure payload vs OQ-10 interim; B7 composite-FK ordering in D3) and a B5 follow-up
  (flag-off must not strand an open undo). Closed in §3.2 step 4, §2.9 and §3.5; §9 updated.

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

### 2.2 RLS and tenant rules (Round 2: effective policies, not the out-of-band file)

Round 1 read `prisma/migrations/rls_fitness_backend.sql` as the live policy set. That file is
**not** a Prisma migration: it is applied out-of-band with `psql` as a "production pre-state twin"
(`test/db/s1-rls-close-public-exposure.sh` L15, L101-102; `test/release/s1s2-composition.sh`
L152-153), and later migration directories replaced some of its policies. The table below is the
**effective** policy set per table at `dda794d7`, obtained by listing every `CREATE POLICY … ON
"<Table>"` and `ENABLE ROW LEVEL SECURITY` across `prisma/migrations/**/*.sql` and reading the
`DROP POLICY IF EXISTS` / `CREATE POLICY` pairs in directory order. `cur` =
`app.current_user_id()`; `owner` = `app.is_owner()` (`20260607000000_rls_remaining_gaps/migration.sql`
L13-19); `is_current_coach_of(x)` is false when `x` is NULL (`is_user_coached_by` requires
`client_user_id IS NOT NULL`, same file L28-36).

| Table                             | Effective policies (file:line)                                                                                                                                                                                                                                                                                            | Predicate today                                                                                                                                                                                                     | Person-owned row (`user_id`/`client_id` NULL) before D3                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkoutSession`                  | `workout_session_owner_access` FOR ALL TO public, `rls_fitness_backend.sql` L142-146; enable/force L57-58. **No migration directory creates a policy on, or enables RLS for, this table** (`rg 'ENABLE ROW LEVEL SECURITY' prisma/migrations/*/migration.sql` has no `"WorkoutSession"` hit).                             | `"user_id" = cur`                                                                                                                                                                                                   | Deny for every non-bypass role (NULL predicate). No owner branch. In a database built from migration directories only — the S11 harness shape (`g2-s11-bootstrap.sh` L139) — the table has **no RLS at all**; pre-existing gap, closed by D3. |
| `ExerciseSet`                     | `p_exerciseset_select/insert/update/delete`, `20261213000000_rls_tier3_workouts/migration.sql` L88-101; `p_exerciseset_service_role_all` L85; enable/force L81-82.                                                                                                                                                        | `owner OR EXISTS(ws: ws.user_id = cur OR is_current_coach_of(ws.user_id))`                                                                                                                                          | Only `owner` (the coach branch is false on NULL).                                                                                                                                                                                             |
| `WeightLog`                       | `weight_log_owner_access`, `rls_fitness_backend.sql` L135-139; enable/force L54-55. None in directories.                                                                                                                                                                                                                  | `"user_id" = cur`                                                                                                                                                                                                   | Deny; same harness gap as `WorkoutSession`.                                                                                                                                                                                                   |
| `Habit`                           | `habit_owner_access`, `rls_fitness_backend.sql` L206-210; enable/force L78-79. None in directories.                                                                                                                                                                                                                       | `"user_id" = cur`                                                                                                                                                                                                   | Deny; same harness gap.                                                                                                                                                                                                                       |
| `HabitLog`                        | `p_habitlog_select/insert/update/delete`, `20261213000000_rls_tier5_notifications_community/migration.sql` L198-214; service_role L194; enable/force L190-191.                                                                                                                                                            | `owner OR EXISTS(h: h.user_id = cur OR is_current_coach_of(h.user_id))`                                                                                                                                             | Only `owner`.                                                                                                                                                                                                                                 |
| `CheckIn`                         | `check_in_owner_all` L354-357, `check_in_client_all` L360-367, `check_in_coach_select` L370-372, `check_in_current_coach_insert` L375-381, `check_in_current_coach_update` L384-391 — all `20260607000000_rls_remaining_gaps/migration.sql`, which drops the out-of-band FOR ALL policy at L352 and re-forces RLS at L84. | owner; `"user_id" = cur`; **SELECT: `"coach_id" = cur` irrespective of `user_id`**; coach INSERT/UPDATE: `"coach_id" = cur AND is_current_coach_of("user_id")`                                                      | **The coach named in `coach_id` can SELECT a person-owned check-in directly.** Owner sees all. Client, coach insert/update: deny.                                                                                                             |
| `ClientWorkoutAssignment`         | `assignment_coach_manage` FOR ALL, `20260702000000_fix_workout_rls_coach_role/migration.sql` L28-63 (replaces `20260621000000_fix_workout_rls_policies` L30-44); `assignment_client_read` FOR SELECT, `20260621000000_…` L47-56; enable/force `20260508000001_rls_workout_builder/migration.sql` L35-36.                  | Keyed on `auth.uid()` → `User.supabase_id`, **not** on `app.current_user_id()`. Coach: `assigned_by_coach_id = me AND me.role ∈ {coach, owner, sub_coach} AND WorkoutPlan.coach_id = me`. Client: `client_id = me`. | **The assigning coach has full access irrespective of `client_id`.** Client: deny.                                                                                                                                                            |
| `ClientWorkoutAssignmentSnapshot` | `p_clientworkoutassignmentsnapshot_select/insert/update/delete`, `20261215000000_mwb_1_data_model/migration.sql` L334-347; service_role L331; enable/force L327-328.                                                                                                                                                      | `owner OR EXISTS(cwa: cwa.client_id = cur OR cwa.assigned_by_coach_id = cur OR is_current_coach_of(cwa.client_id) OR is_subcoach_of(cwa.client_id))`                                                                | Assigning coach and owner see it.                                                                                                                                                                                                             |

So Round 1's "unreadable to `anon`/`authenticated` by construction" was false for `CheckIn`,
`ClientWorkoutAssignment` and its snapshot, silent about the `owner` branch on four tables, and
silent about the fact that three parents have no in-tree RLS at all. The application path is
unaffected (Prisma connects as `service_role`, `rls_fitness_backend.sql` L4-6; `BYPASSRLS` in the
harness, `g2-s11-bootstrap.sh` L96, L106); the exposure is direct database access — which is
exactly what these policies exist to defend.

**Decision for S8-D3 (hand-written SQL in the D3 migration, §2.9):**

1. **Explicit `person_id IS NULL` guard on every non-owner branch.** Person-owned rows are
   reachable **only** through the service-role code path that asserts `person.coach_id = caller`
   (the roster reader's discipline, `src/scout/scout-roster.service.ts` L32-34, L203-208). No new
   permissive policy is added for `person_id`.
   - `CheckIn`: `check_in_client_all` (USING and WITH CHECK), `check_in_coach_select`,
     `check_in_current_coach_insert`, `check_in_current_coach_update` each gain
     `AND "person_id" IS NULL`. WITH CHECK included so no client or coach can insert or flip a
     person-owned row through direct access; the flip is service-role only.
   - `ClientWorkoutAssignment`: `assignment_coach_manage` (USING and WITH CHECK) and
     `assignment_client_read` gain `AND "person_id" IS NULL`.
   - `WorkoutSession`, `WeightLog`, `Habit`: D3 **recreates** the three out-of-band policies inside
     the migration directory (`ENABLE`/`FORCE` + idempotent `DROP POLICY IF EXISTS` + `CREATE POLICY`)
     with `"user_id" = cur AND "person_id" IS NULL`. This also closes the harness gap and
     makes the tree self-describing; re-running `rls_fitness_backend.sql` afterwards would
     re-widen them, so D3 adds the three policy names to that file's rollback comment block
     (L226-249) and the out-of-band file is marked superseded for these three tables.
   - Children: the non-owner `EXISTS(…)` branch of `p_exerciseset_*`, `p_habitlog_*` and
     `p_clientworkoutassignmentsnapshot_*` gains `AND <parent>."person_id" IS NULL`.
2. **Owner exception, stated truthfully.** The `app.is_owner()` branches on `ExerciseSet`,
   `HabitLog`, `CheckIn` and the snapshot are **kept unchanged**: the backend `owner` role can
   read person-owned rows directly, as it can read every other row on those tables today. D3
   does not add an owner branch to `WorkoutSession`/`WeightLog`/`Habit` (none exists). If the
   owner wants the operator role excluded from imported history, that is a one-line change per
   policy and a product decision — recorded as a note, not an OQ, because the default is the
   existing behaviour.
3. **Cross-tenant `coach_id` protection on `CheckIn`.** `CheckIn.coach_id` is nullable and
   independent of `user_id` (`schema.prisma` L1102-1107). For person-owned rows D3 enforces it in
   the database: `CHECK ("person_id" IS NULL OR "coach_id" IS NOT NULL)` plus a composite
   `FOREIGN KEY ("person_id", "coach_id") REFERENCES "Person"("id", "coach_id")` (backed by a new
   unique constraint `Person(id, coach_id)` that **must exist before** the FK is added — created
   `CONCURRENTLY` in D3-2 and promoted with `ADD CONSTRAINT … UNIQUE USING INDEX` in D3-3 ahead
   of the FK, §2.9; `MATCH SIMPLE` skips user-owned rows where `person_id` is NULL). The S8-E1b writer sets `coach_id = person.coach_id`; the link leaves `coach_id`
   untouched (the client is attached to that same coach in the link transaction, so
   `check_in_client_all`'s WITH CHECK `is_user_coached_by(user_id, coach_id)` L366 holds
   afterwards); unlink leaves it untouched. A person-owned check-in can therefore never name a
   coach other than the Person's tenant.
4. **Role × owner-state test matrix** (PG spec in D3, run under the S11 RLS harness with
   `SET ROLE authenticated` / `SET LOCAL app.current_user_id`, one case per cell per table, both
   USING and WITH CHECK):

   | Principal                                                | User-owned row (`user_id` set)                                                    | Person-owned row (`person_id` set)                                                                                         |
   | -------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
   | `anon` (no `cur`)                                        | deny all verbs                                                                    | deny all verbs                                                                                                             |
   | unrelated authenticated student (other coach)            | deny                                                                              | deny                                                                                                                       |
   | same-coach other student                                 | deny                                                                              | deny                                                                                                                       |
   | the Person's coach (`coach_id = person.coach_id`)        | as today (`CheckIn` select when `coach_id = cur`; CWA manage; children via coach) | **deny all verbs** on all eight tables (this is the row the review found exposed)                                          |
   | a different coach                                        | deny                                                                              | deny                                                                                                                       |
   | the client, before link / after unlink                   | allow own rows                                                                    | deny (not theirs)                                                                                                          |
   | the linked client, after link (row now `user_id = cur`)  | allow                                                                             | n/a — the row is user-owned once linked                                                                                    |
   | `owner` role                                             | as today                                                                          | allow on `ExerciseSet`, `HabitLog`, `CheckIn`, snapshot (stated exception); deny on `WorkoutSession`, `WeightLog`, `Habit` |
   | any non-bypass principal, INSERT/UPDATE with `person_id` | —                                                                                 | WITH CHECK deny (flip and person-owned writes are service-role only)                                                       |

   Plus: `CheckIn` insert with `person_id` set and `coach_id` ≠ `person.coach_id` fails the
   composite FK (as service_role, to prove the constraint rather than the policy).

- `Person` itself stays `service_role`-only with RESTRICTIVE deny-all to `anon` and
  `authenticated` (`prisma/migrations/20261223000200_scout_reconstruction/migration.sql`
  L76-86). Every new table in §2.4-2.5 copies that posture exactly.
- Tenant rule (L6): a `Person` belongs to one `coach_id` (`schema.prisma` L6961, unique
  external_ref L6971). A link may only bind it to a `User` whose `coach_id` (L164) is that coach,
  or is NULL and becomes that coach inside the link transaction (the same attach that
  `attachUserToCoachByCode` performs, `src/invite-codes/invite-codes.service.ts` L606-609, minus
  the code). A `User` attached to another coach is refused; `coach`, `sub_coach` and `owner`
  claimants are refused (§7 OQ-4, decided by derivation; owner refusal as today, L563-568). The
  link never reassigns an existing `coach_id` and never changes `role` except NULL-coach →
  `student`.

### 2.3 `Person` states and transitions

`PersonState` is `InvitePending | Invited | Claimed | Suspended | Deleted` (`schema.prisma`
L6951-6957); today only the default (`InvitePending`, L6965) and the roster's `Deleted` exclusion
(`scout-roster.service.ts` L207) are used. `Person` keeps **no** contact, email or account column
except the link pointer below (D2 comment L6943-6950 stands).

Add `Person.linked_user_id String?` (indexed, not unique: the current active account; NULL unless
`Claimed`). It is redundant with the active `PersonLink` (§2.5) and exists so that roster reads
and the XOR flip need no join; the link transaction writes both or neither. Cardinality is
enforced on `PersonLink` (§2.5), not here, so that the L8 merge case stays expressible (OQ-1).

| From            | To              | Trigger                                                                                                                                                                                                                                                  | Slice |
| --------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `InvitePending` | `Invited`       | Coach mints a `PersonInvite` (L2), including the invite minted for an accepted L5/L8 proposal (§3.3)                                                                                                                                                     | D4a   |
| `Invited`       | `InvitePending` | The only open invite expires, is revoked, is locked, or the client answers "No" (L4); coach notified on "No"                                                                                                                                             | D4a/b |
| `Invited`       | `Claimed`       | Link transaction commits (L2-L4; and L5/L8 after their invite + challenge + confirmation, §3.3)                                                                                                                                                          | D4b   |
| `Claimed`       | `InvitePending` | Unlink by client or coach within 30 days (L7); after that only admin. **Every** later re-link, by any path, needs a newly minted Person-bound invite, a new challenge and a new client confirmation (B3; L7 is binding). No transition skips `Invited`.  | D5    |
| any but Deleted | `Suspended`     | **Admin/manual safety freeze only** (owner surfaces), with reviewed reinstatement and audit; never automatic on failed codes — a failed code revokes that invite only (OQ-8, decided by derivation). No invite can be minted or claimed while suspended. | D4a   |
| `Suspended`     | `InvitePending` | Admin reinstatement, audited                                                                                                                                                                                                                             | D4a   |
| any             | `Deleted`       | Erasure. Terminal. Excluded from roster (L207). A `Claimed` Person cannot be deleted while it has an active link (OQ-7, owner). A replay of the external ref never resurrects it (§5.1).                                                                 | —     |

There is **no** `InvitePending → Claimed` edge: proposals (L5/L8) are not Person states; they are
`PersonLinkProposal` rows (§2.5) and activate only through `Invited → Claimed`.

Reconstruction replays never touch `state` or `linked_user_id`, and from S8-D1 on they no longer
overwrite `display_name` either (create-only, §5.1; OQ-11 decided by derivation).

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

| Column                                                                             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `coach_id`, `person_id` (FK Person, Restrict)                                | Bound to exactly one Person (L2). `coach_id` is the bearer coach, re-asserted against `person.coach_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `created_by_user_id`                                                               | Head coach or sub-coach who tapped Invite (attribution as `InviteCode.invited_by_user_id`, L734-740).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `token_hash` `@unique`                                                             | sha256 of a ≥128-bit `crypto.randomBytes` URL token. The raw token is returned once to the sender path and never stored or logged (R30 precedent, `auth.service.ts` L310).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `contact_email`, `contact_phone` (nullable, at least one)                          | The contacts the coach **confirmed** for this Person (L2, L3). Held on the invite only; scrubbed to NULL when the invite reaches a terminal status. Never copied to `Person` or `User`; never used as a lookup key.                                                                                                                                                                                                                                                                                                                                                               |
| `sent_via` (`email` \| `phone`), `sent_at`, `send_status`                          | Delivery of the invite link itself; `send_status` is the transport's truthful outcome (`sent` \| `logged` \| `failed`, as the bulk invite reports, `invite-codes.service.ts` L619-634). **`logged` is not delivery**: a channel is offered to the claimant only if the transport for it is configured and the invite send on it reported `sent` (C8). While no SMS transport exists (§3.1) the phone contact is stored but shown as _unavailable_, and the product copy calls the email-only state a capability limitation, not the full L3 choice.                               |
| `status` (`open` \| `claimed` \| `declined` \| `revoked` \| `expired`)             | Partial unique `(person_id) WHERE status = 'open'`: at most one open invite per Person.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `target_user_id` (nullable FK User)                                                | Set when the invite was minted for an accepted L5/L8 proposal (§3.3): only that authenticated user may request a challenge; anyone else gets the generic `{valid:false}`. NULL for an ordinary L2 invite.                                                                                                                                                                                                                                                                                                                                                                         |
| `expires_at`                                                                       | Required. 14 days as `InviteCode` (L143, L841-843); OQ-5 (decided by derivation, §7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `revoked_at`, `revoked_by_user_id`, `claimed_at`, `claimed_link_id`, `declined_at` | Terminal stamps; `claimed_link_id` → the `PersonLink`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `failed_attempts`                                                                  | Per-invite counter of wrong **codes** on challenges that belong to this invite, incremented atomically (`UPDATE … SET failed_attempts = failed_attempts + 1 WHERE id = ? RETURNING …`, never read-modify-write); at 5 the invite is locked (`status = revoked`, `revoke_reason = locked`) and must be re-minted — the pairing precedent (service L32-41). A guessed **unknown token** finds no row and charges nothing; only the per-IP throttle sees it (C3). Locking is a bounded nuisance an attacker holding a valid link can cause once; the coach is notified and re-mints. |
| `resend_count`, `last_sent_at`                                                     | Resend of the invite link is limited to 3 per 24 h per invite and 10 per hour per coach; challenge resends to 3 per invite per claimant per hour (C3). Limits are implementation constants, not policy.                                                                                                                                                                                                                                                                                                                                                                           |

`PersonInviteChallenge` (one-time code, service_role only):

| Column                                        | Rule                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `invite_id` (FK, Cascade), `coach_id`   | One challenge per (invite, claimant) at a time; earlier open challenges are voided on resend.                                                                                                                                                                                                                                                  |
| `claimant_user_id`                            | The authenticated `User` who asked for the code. The verified challenge is usable **only** by this user (§3.2 step 3).                                                                                                                                                                                                                         |
| `channel` (`email` \| `phone`)                | Chosen by the client from the invite's non-null contacts; the request body carries the enum only, never a contact value (L3 by API shape).                                                                                                                                                                                                     |
| `code_hash`                                   | HMAC-SHA256 (server key) of a 6-digit `crypto.randomInt` code (`extension-pair.service.ts` L389-391); constant-time compare on verify.                                                                                                                                                                                                         |
| `expires_at`                                  | 10 minutes (OQ-5). `sent_at`, `send_status` as above.                                                                                                                                                                                                                                                                                          |
| `failed_attempts`, `verified_at`, `voided_at` | Atomic increments as above; lockout at 5 wrong codes voids the challenge and charges the invite's counter; `verified_at` set once; a verified challenge expires 15 minutes after `verified_at` unused. **All** open or verified challenges of an invite are voided (`voided_at`) when the invite is revoked, declined, locked or expires (C3). |

### 2.5 `PersonLink`, `PersonLinkProposal`, `PersonLinkOutbox` (Round 2: B2, C4, B5)

`PersonLink` is the record of a **completed** link. It is inserted **only** by the link
transaction (§2.7) with `linked_at` set, in the same transaction as the re-own, so it is the
durable primary audit even when the general audit write fails — `AuditService.write` deliberately
swallows its own errors (`src/audit/audit.service.ts` L168-172, L185-215) and is therefore the
secondary record (L6 "every link/unlink audited"). Proposals never touch this table (B2).

| Column                                                                                                                                                  | Rule                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `coach_id`, `person_id` (FK Restrict), `user_id` (FK Restrict)                                                                                    | The tenant, the Person and the account. `coach_id = person.coach_id` enforced by the same composite-FK pattern as §2.2 item 3 (`(person_id, coach_id) → Person(id, coach_id)`).                                                                                                                                                                                                              |
| `path` (`invite` \| `proposal_match` \| `proposal_merge`)                                                                                               | L2-L4; L5; L8. Every path ends in an invite + challenge + confirmation (§3.3), so `invite_id` and `challenge_id` are **NOT NULL** on all paths.                                                                                                                                                                                                                                              |
| `invite_id` (FK), `challenge_id` (FK), `proposal_id` (nullable FK)                                                                                      | The invite and verified challenge that produced this link; `proposal_id` set on the two proposal paths. `CHECK ((path = 'invite') = (proposal_id IS NULL))`.                                                                                                                                                                                                                                 |
| `verified_channel`, `verified_contact_digest`                                                                                                           | Channel and sha256 of the contact that was verified — never the raw contact (digest precedent: `ScoutRunDeclaration.account_scope_id_digest`, `schema.prisma` L7046-7047). NOT NULL (every path verifies a contact; OQ-6 may later relax this for first-time L5 only, §7).                                                                                                                   |
| `client_confirmed_at` NOT NULL, `coach_confirmed_at` NOT NULL, `coach_confirmed_by_user_id`                                                             | The client's "yes" (§3.2 step 5) and the coach's act (minting the invite, or the proposal) with the actor id (C4: role alone is not attribution).                                                                                                                                                                                                                                            |
| `linked_at` NOT NULL, `undo_deadline_at` NOT NULL                                                                                                       | `undo_deadline_at = linked_at + 30 days` (L7), computed once and never moved.                                                                                                                                                                                                                                                                                                                |
| `records_moved` Json                                                                                                                                    | Per-table counts `{moved}` written by the link transaction (§2.7). Counts only, no ids or contents.                                                                                                                                                                                                                                                                                          |
| `unlinked_at`, `unlinked_by_role` (`client` \| `coach` \| `admin`), `unlinked_by_user_id`, `unlink_reason_code`, `unlink_note`, `records_returned` Json | Set once by the unlink transaction (C4). `unlink_reason_code` is an enum (`not_me`, `wrong_person`, `changed_mind`, `coach_error`, `support_request`, `other`); `unlink_note` is optional free text stored for support and **never** shown automatically to the other side — notifications carry the reason code only (C4 PII/abuse rule). `coach` is refused after `undo_deadline_at` (L7). |
| `merge_anchor_link_id` (nullable FK PersonLink)                                                                                                         | On `path = 'proposal_merge'`: the earlier **active** link this one joins (L8 two-platform case). `CHECK ((path = 'proposal_merge') = (merge_anchor_link_id IS NOT NULL))`. Anchor constraints below.                                                                                                                                                                                         |
| `notify_status` (`pending` \| `delivered` \| `failed`), `notify_attempts`                                                                               | Mirror of the outbox rows for this link (B5), so the record shows whether L7's "other side notified" actually happened.                                                                                                                                                                                                                                                                      |

**Uniqueness (B2).** Active = `linked_at IS NOT NULL AND unlinked_at IS NULL` (written out even
though `linked_at` is NOT NULL, so the predicate stays correct if a later slice ever admits
pending rows here — it must not). D3 lands:

- `UNIQUE (person_id) WHERE linked_at IS NOT NULL AND unlinked_at IS NULL` — one active account
  per Person (L6), absolute.
- `UNIQUE (coach_id, user_id) WHERE linked_at IS NOT NULL AND unlinked_at IS NULL` — one Person
  per account per coach (L6), **with no merge exemption**. This is the strict reading and the
  safe interim default: until OQ-1 is answered, an L8 two-platform merge is refused by the
  database (`proposal_merge` cannot activate) and the coach sees "two imported records for one
  client — pending owner decision". The exemption index (`… AND path <> 'proposal_merge'`) and
  the merge activation path are **D6 work that waits for OQ-1**; they are not in D3.
- Merge anchor constraints, specified now so D6 does not design them: composite FK
  `(merge_anchor_link_id, coach_id, user_id) REFERENCES PersonLink(id, coach_id, user_id)`
  (same coach, same account, backed by a unique constraint on those three columns which is
  created **before** the FK in the same D3-1 statement list — legal because `PersonLink` is new
  and empty, §2.9);
  `CHECK (merge_anchor_link_id <> id)`; Person distinctness (`anchor.person_id <> person_id`) and
  anchor activity are asserted in the link transaction under the Person lock and by a
  constraint trigger, because a CHECK cannot read another row; unlinking an anchor requires
  unlinking every link that names it in the same transaction (both return their own rows), so an
  active merge never dangles.

`PersonLinkProposal` (B2; new; service_role only) — the L5/L8 "coach says: this imported Person is
this client" object, with its own lifecycle and **no** effect on `PersonLink` uniqueness:

| Column                                                                                            | Rule                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `coach_id`, `person_id` (FK Restrict), `user_id` (FK Restrict), `kind` (`match` \| `merge`) | Composite FK to `Person(id, coach_id)`; `user.coach_id = coach_id` asserted at creation and re-checked at every transition (a client who has since left the coach voids the proposal).                                                                                                                                                           |
| `proposed_by_user_id`, `created_at`                                                               | The coach or sub-coach who proposed (authorization: `Roles('coach')` guards as the roster reader, `scout-roster.controller.ts` L82-84, plus `person.coach_id = caller`'s coach).                                                                                                                                                                 |
| `merge_anchor_link_id` (nullable)                                                                 | Required when `kind = merge`; must be an active link of the same `(coach_id, user_id)` at creation and at activation.                                                                                                                                                                                                                            |
| `status` (`open` \| `accepted` \| `declined` \| `expired` \| `revoked` \| `superseded`)           | `UNIQUE (person_id) WHERE status = 'open'`. `expires_at` = 14 days. `declined` by the proposed client (in-app, L4 "No" semantics: coach notified); `revoked` by the proposing coach or admin; `expired` by the sweeper; `superseded` when the Person becomes `Claimed` by any other path or is deleted/suspended.                                |
| `invite_id` (nullable FK)                                                                         | Set when the client taps "yes, start verification": the server mints a Person-bound `PersonInvite` with `target_user_id = user_id` (§2.4) and the ordinary challenge → verify → confirm flow runs (§3.2 steps 3-5). `accepted` is written by the link transaction itself, in the same transaction as `PersonLink` (same-transaction activation). |
| `decided_at`, `decided_by_user_id`                                                                | Actor id for every terminal transition (C4).                                                                                                                                                                                                                                                                                                     |

Proposals are visible on the roster as `proposal: {status, expires_at}` (§5.2); they never count
as a link, never set `linked_user_id`, never change `Person.state`, and an open proposal does not
block an ordinary L2 invite (the first path to complete supersedes the other under the Person
lock).

`PersonLinkOutbox` (B5; new; service_role only) — durable delivery of the L4/L7 notifications:

| Column                                                                                                                                     | Rule                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `link_id` (FK), `event` (`linked` \| `unlinked` \| `declined` \| `proposal_*`), `recipient_user_id`, `channel` (`in_app` \| `email`) | One row per (event, recipient, channel), inserted **inside** the link/unlink transaction. The `in_app` row is materialised there too via `NotificationsService.createNotification(input, tx)` (`src/notifications/notifications.service.ts` L297-301 accepts the transaction client), so the in-app notice can never be lost.                   |
| `attempts`, `next_attempt_at`, `delivered_at`, `last_error`                                                                                | A `@Cron` worker (precedent `src/notifications/nudges/nudge.scheduler.ts` L43) drains `delivered_at IS NULL AND next_attempt_at <= now()` with exponential back-off, max 8 attempts over ~48 h; on exhaustion `PersonLink.notify_status = failed` and an admin alert is raised. Payloads carry ids, display names and the reason **code** only. |

Secondary audit: `AuditService.write` with actions `person.link.invited`, `.declined`,
`.linked`, `.unlinked`, `.proposal_created`, `.proposal_declined`, `.proposal_revoked`,
`.revoked`, `.suspended`, `.reinstated`; `tenant_coach_id`, `target_type = 'person'`,
`target_id = person.id`, `target_user_id = user.id`, `actor_user_id`, metadata = ids, reason
codes and counts only (the service's own PII rule, L160-165).

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

1. Preconditions under the lock: `person.state = Invited` and no active `PersonLink`; the
   invite is `open`, unexpired, unlocked, bound to this Person, and — if `target_user_id` is set
   — to this user; its challenge is `verified_at` set for **this** `claimant_user_id` within the
   15-minute window; **if any `PersonLink` row exists for this Person (any historical link), the
   invite's `created_at` must be later than the latest `unlinked_at`** (B3: a fresh invite, a fresh
   challenge and a fresh confirmation for every re-link, on every path); the user exists, is not
   deleted/scheduled for deletion (`User` L171-176), has role `student` or an unattached
   account, and has `coach_id` NULL or `= person.coach_id`. Same checks on `proposal_match`;
   `proposal_merge` additionally re-verifies the anchor (§2.5) and is refused while the strict
   `(coach_id, user_id)` unique stands (OQ-1).
2. `updateMany` the invite `WHERE id = ? AND status = 'open'` → `claimed`; `count !== 1` → the
   generic refusal (a lost race).
3. If `user.coach_id` is NULL: set `coach_id = person.coach_id`, `role = student` (as
   `attachUserToCoachByCode` L606-609).
4. For each of the five tables: `UPDATE … SET user_id = U, person_id = NULL WHERE person_id = P
AND coach_id/tenant matches` — the row set is the provenance join (`provenance.coach_id =
P.coach_id AND provenance.person_id = P AND (native_kind, native_id) = (row kind, row id)`,
   C5), not a bare `person_id` scan, so a row can only move if the import that created it is on
   record. For `CheckIn`, first detect `(P, date)` rows colliding with an existing `(U, date)`
   row (L1129). **Fail closed (OQ-3, decided by derivation):** the transaction aborts with a
   stable code `link_collision` listing the colliding dates (dates only, no contents); the
   client is told which of their own check-ins collide and may delete or re-date them and retry,
   or answer "No". Neither row is ever overwritten and nothing is silently skipped; a partial link
   with hidden residue is not an outcome this system produces ("unknown never silently becomes
   zero").
5. Insert `PersonLink` (`linked_at`, `undo_deadline_at`, `records_moved`, actor ids); set
   `person.state = Claimed`, `person.linked_user_id = U`; mark the invite `claimed`, the
   proposal (if any) `accepted`, every other open proposal for P `superseded`; void remaining
   challenges; scrub the invite's contacts; insert the outbox rows and the in-app notifications
   (`createNotification(input, tx)`) — all in this one transaction (C5: native updates, link
   stamps and notification intent commit or roll back together).
6. After commit: the outbox worker delivers the email copies (§2.5); secondary audit write;
   analytics without contacts.

**Unlink** (one transaction, same Person lock):

1. Active `PersonLink` exists; actor is the linked client, the Person's coach (only if
   `now < undo_deadline_at`), or admin.
2. Candidate rows = native rows `WHERE user_id = U` that have a provenance row with
   `provenance.coach_id = P.coach_id AND provenance.person_id = P AND (native_kind, native_id)
= (row kind, row id)` (C5: all four compared) — joined through the L7028 index. For each:
   `SET person_id = P, user_id = NULL`. Rows without provenance (logged after joining) stay. An
   imported row the client **deleted** while linked is gone; its provenance row remains and is
   counted under `records_returned.missing` so the coach sees a truthful count, not a silent
   zero. A `CheckIn` `(P, date)` collision on return cannot arise from the link path (the link
   fails closed, step 4 above) and can only come from a post-link import writing to `U` on a
   date where P already held a row — which the S8-E writer refuses (§2.8 case 4 routes to `U`,
   and `U`'s own row on that date makes the write `unresolved:native_uniqueness`). Unlink still
   detects it and **aborts** with `unlink_collision` rather than downgrading (C5); admin resolves.
3. Stamp `unlinked_at`, `unlinked_by_role`, `unlinked_by_user_id`, `unlink_reason_code`,
   `unlink_note`, `records_returned`; `person.state = InvitePending`, `linked_user_id = NULL`;
   if this link is a merge anchor, unlink its dependants in the same transaction (§2.5); the
   user's `coach_id` is **not** changed (leaving the coach is a separate live action, OQ-4).
4. Outbox rows + in-app notifications in the same transaction (reason code only); secondary
   audit after commit.

Edits the client or coach made to an imported row while linked travel with the row back to the
Person (the row is handed over, not copied, L6); whether that is wanted is OQ-2 (owner; the
interim default is exactly this hand-over). Lock discipline is shared: the S8-E writers, the link
and the unlink all take the Person row lock first (`FOR SHARE` for writers, `FOR UPDATE` for link
and unlink), so an import can never interleave with a flip (C5).

### 2.8 Idempotency and concurrency

| Case                                           | Rail                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirm replayed (same user, same invite)      | Active `PersonLink(person, user, invite)` already exists → 200 with the same link id; nothing is re-run. No second audit or outbox row. (L6 "replays idempotent")                                                                                                                                                                                                                       |
| Two claimants on one invite                    | Person `FOR UPDATE` serialises; the loser sees `status <> 'open'` or `state = Claimed` → generic refusal, invite `failed_attempts` charged.                                                                                                                                                                                                                                             |
| Claim vs coach unlink                          | Same Person lock; unlink needs an active link, claim needs none — exactly one wins; the other reads the committed state.                                                                                                                                                                                                                                                                |
| Claim vs import pass writing person-owned rows | The S8-E writer reads the Person under `FOR SHARE` in its per-row transaction (the engine already runs one transaction per row with P2002 retry-once, `families.ts` L40-41, and S11-B r2 retries raw serialization failures, `dda794d7`). If `state = Claimed` it writes `user_id = linked_user_id` directly and still stamps `provenance.person_id = P`, so a later unlink returns it. |
| Claim vs revoke                                | Revoke is `updateMany WHERE status = 'open'`; the claim's step 2 is the same guard; one wins.                                                                                                                                                                                                                                                                                           |
| Invite re-mint while one is open               | Partial unique on `(person_id) WHERE status='open'` → 409; coach must revoke first (revocation is a distinct audited act).                                                                                                                                                                                                                                                              |
| Re-link after unlink, any path                 | Fresh Person-bound invite minted after the last `unlinked_at` + fresh challenge + fresh confirmation (L7, B3); an open proposal alone never links. The old `PersonLink` stays as history.                                                                                                                                                                                               |
| Proposal vs L2 invite claim on the same Person | Both end in the same link transaction under the Person lock; the first to commit sets `Claimed`, the other proposal/invite is `superseded`/refused generically.                                                                                                                                                                                                                         |
| Proposal expiry / client leaves coach          | Sweeper marks `expired`; every transition re-checks `user.coach_id = coach_id` and voids the proposal otherwise.                                                                                                                                                                                                                                                                        |

### 2.9 Migration shape (C2, B7)

"One directory" in Round 1 was an estimate of count, not a proof of safety, and Round 2's three
directories put the `Person(id, coach_id)` unique index **after** the composite FK that references
it — PostgreSQL refuses a foreign key whose referenced columns are not already covered by a
non-partial unique index or constraint, so D3-1 would have failed (B7). The five parents are
populated production tables; a repo precedent uses `CREATE INDEX CONCURRENTLY` on
`ClientWorkoutAssignment` for that reason and documents that Prisma 6.19 runs a migration file
**without** wrapping it in a transaction (`20260704000001_coach_brief_cwa_index_concurrent/migration.sql`
L8-27), while the scout migrations set `lock_timeout = '5s'` / `statement_timeout = '30s'` inside an
explicit `BEGIN` (`20270118000000_scout_ledger_platform_expand/migration.sql` L5-7). Ordering rule:
**every unique key is created before any FK that references it; every constraint on a populated
table is added `NOT VALID` and validated in a later directory; every index on a populated table is
built `CONCURRENTLY` outside a transaction.** D3 is therefore **four directories**, landed as one
slice, in this order:

| Dir  | Transaction                                                                            | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Lock profile                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D3-1 | `BEGIN … COMMIT` with `SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'` | **New, empty tables** `PersonInvite`, `PersonInviteChallenge`, `PersonLink`, `PersonLinkProposal`, `PersonLinkOutbox` with their columns, PK, plain FKs to existing PKs (`Person(id)`, `User(id)`), CHECKs, **and their own unique indexes/constraints inline** — including `PersonLink(id, coach_id, user_id) UNIQUE` **before** the self-referencing anchor FK `(merge_anchor_link_id, coach_id, user_id) → PersonLink(id, coach_id, user_id)` in the same statement list (legal: the table is new and empty, so plain `CREATE UNIQUE INDEX` and immediate FKs are instantaneous); the two active partial uniques; RLS enable/force + deny-all policies. `Person.linked_user_id`, `ImportNativeProvenance.person_id` (nullable, no FK yet). On each of the five parents: `ADD COLUMN person_id TEXT NULL`, `ALTER COLUMN user_id/client_id DROP NOT NULL`, XOR CHECK and the `CheckIn` `(person_id IS NULL OR coach_id IS NOT NULL)` CHECK added **`NOT VALID`**. Policy rewrites (§2.2). **No composite FK to `Person` here.** | Catalog-only `ALTER TABLE`s: short ACCESS EXCLUSIVE, no rewrite, no scan. Atomic; re-runnable (`IF NOT EXISTS` on tables/indexes). |
| D3-2 | **none** (`CONCURRENTLY`)                                                              | One statement per index, `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS`: `Person(id, coach_id)` **unique**; `(person_id)` on the five parents; `(person_id, date) WHERE person_id IS NOT NULL` unique on `CheckIn`; `(person_id, scheduled_for)` on `ClientWorkoutAssignment`; `Person(linked_user_id)`; `ImportNativeProvenance(person_id)`. Invalid-index operator note copied from the precedent (L28-34).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | SHARE UPDATE EXCLUSIVE; never blocks DML.                                                                                          |
| D3-3 | `BEGIN … COMMIT`, same timeouts                                                        | `ALTER TABLE "Person" ADD CONSTRAINT "Person_id_coach_id_key" UNIQUE USING INDEX …` (promotes the D3-2 index; metadata-only). Then the composite FKs, all **`NOT VALID`**: `CheckIn(person_id, coach_id) → Person(id, coach_id)`; `PersonLink(person_id, coach_id) → Person(id, coach_id)`; `PersonLinkProposal(person_id, coach_id) → Person(id, coach_id)`; `PersonInvite(person_id, coach_id) → Person(id, coach_id)`; and the plain `person_id → Person(id)` FKs on `WorkoutSession`, `WeightLog`, `Habit`, `ClientWorkoutAssignment`, `ImportNativeProvenance`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Short ACCESS EXCLUSIVE per statement; `NOT VALID` skips the scan.                                                                  |
| D3-4 | `BEGIN … COMMIT`, same timeouts                                                        | `ALTER TABLE … VALIDATE CONSTRAINT` for every `NOT VALID` CHECK and FK from D3-1 and D3-3, one statement each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | SHARE UPDATE EXCLUSIVE (full scan, no write block).                                                                                |

Sequence proof for the two FKs the review named: `Person(id, coach_id)` unique index (D3-2) →
promoted to a constraint (D3-3, first statement) → composite FKs (D3-3, later statements) →
validation (D3-4). `PersonLink(id, coach_id, user_id)` unique (D3-1, before the anchor FK) → anchor
FK (D3-1, after it). No statement references a key that a later directory creates.

No backfill is needed (every new column is NULL for every existing row; the XOR CHECK holds
trivially). Rollback = four `down.sql` files applied in reverse (drop FKs and CHECKs, drop the
unique constraint, `DROP INDEX CONCURRENTLY` each D3-2 index, drop columns, drop the five tables),
each with the same timeouts (precedent `20270118000000_…/down.sql` L5-6). The type ripple (§2.1)
ships in the same slice because the generated client changes at D3-1. **All four directories count
against the S11 pin (§6): 173 → 177 at D3, 178 after S8-E1a, 179 after S8-D6.**

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
   compare, lockout, `verified_at`. Only now the response carries the L4 disclosure, and it is
   **exactly** the OQ-10 interim payload (§7.2):
   `{coach_display_name, person_display_name, family_kinds: ['workouts' | 'weight' | 'habits' | 'check_ins' | 'assignments', …]}`
   — the **kinds** of imported history that exist for this Person, derived from provenance
   `native_kind`; **no** record counts, **no** date ranges, **no** row contents before "yes".
   Counts appear only in the post-"yes" response (`records_moved`, step 5) and in the
   `link_collision` refusal (§2.7 step 4), both of which follow the client's confirmation. If
   Bradley answers OQ-10 differently, this step and §7.2 are amended together — there is one
   disclosure contract, not two.
5. **Confirm.** `POST /person-invites/:token/confirm {answer: 'yes' | 'no'}` (JWT, same user).
   `yes` → §2.7 link transaction → 200 `{link_id, undo_until, records_moved}`. `no` → invite
   `declined`, Person back to `InvitePending`, coach notified (L4). Either answer closes the
   invite.

### 3.3 Fallback (L5) and merges (L8) — proposals, then the same verified claim (B2, B3)

- **Suggestions (L1).** The coach roster may show, per imported Person, candidate students of
  the **same coach** by display-name similarity computed at read time. Suggestions are never
  persisted as links and never auto-applied.
- **L5.** `POST /scout/persons/:personId/link-proposals {user_id}` (coach): `user.coach_id =
caller` and `user.role = student` required (the cross-tenant rail), creates a
  `PersonLinkProposal(kind = match)` (§2.5) — **not** a `PersonLink`. The client receives an
  in-app notification and sees only the pre-verification disclosure of §3.2 step 2 (coach card
  and "an imported history may be yours" — no Person name yet);
  `POST /me/link-proposals/:id/{decline|start}`.
  `start` mints a Person-bound `PersonInvite` with `target_user_id = me` and the coach-held
  contacts already confirmed on the proposal, then the ordinary §3.2 steps 3-5 run: challenge to a
  coach-held contact, verify, L4 disclosure, confirm "yes". The link transaction writes
  `PersonLink(path = proposal_match)` and `proposal.status = accepted` together. An in-app "yes"
  on the proposal alone never links anything.
- **B3 rule.** The invite-after-last-unlink precondition (§2.7 step 1) applies on this path
  exactly as on L2, so a client unlinked yesterday cannot be re-attached by a coach proposal
  without a new challenge and a new "yes". Whether a **first-time** L5 (Person with no historical
  link) may skip the challenge is OQ-6 (owner); the interim default is the challenge on every
  path.
- **L8 already-a-client** is L5. **L8 same person from two platforms** is
  `PersonLinkProposal(kind = merge, merge_anchor_link_id)`; its activation path is the same
  invite + challenge + confirm, and it is **refused by the strict `(coach_id, user_id)` unique
  until OQ-1 is answered** (§2.5). Until then the roster shows both Persons, one `Claimed`, one
  "imported, not yet joined — pending owner decision on merges".

### 3.4 Undo (L7)

- Client: `POST /api/person-links/:id/unlink {reason_code, note?}` any time before
  `undo_deadline_at`. Ungated (§3.5).
- Coach: `POST /api/coach/person-links/:id/unlink {reason_code, note?}` only before
  `undo_deadline_at`; after it the route answers 403 with a stable code (`undo_window_closed`)
  and the coach UI points to support. Ungated (§3.5).
- Admin: existing owner surfaces (`src/admin/**`), audited with `unlinked_by_role = admin` and the
  admin's user id.
- Notifications to the other side in every case through the outbox (§2.5), carrying the reason
  **code** only; the free-text note is visible to support and to the actor, never pushed to the
  other party (C4).

### 3.5 Release gate: claim is not enabled before undo exists (B5)

- D4b and D5 are **one releasable gate**: a single flag `FEATURE_PERSON_LINK` (dark by default,
  enforced by the same `featureFlagNotFoundMiddleware` that hides `/api/scout/*`,
  `scout-roster.controller.ts` L78-81) fronts every claim, confirm and proposal-start route — **not** the unlink routes (below). The flag must not exist in any environment's configuration until D5 has landed on
  `integration/importer` **and** its unlink specs (client, coach ≤ 30 d, admin, return-only-imported,
  collision abort, outbox delivery, notification failure → `notify_status = failed` + alert) are
  green on the RLS harness. D4a (mint/revoke/preview) may ship before D5 because it starts no
  30-day clock.
- Even on `integration/importer`, enabling the flag with real client data is owner-reserved
  (S8-DOC/S11-DOC owner boundaries; §6). A build lane proves it with fixtures only.
- **Flag-off must never strand an open undo (B5 follow-up).** `featureFlagNotFoundMiddleware`
  answers 404 for every request under a gated prefix whenever its env var is not `'true'`, read
  at request time so operations can toggle it without a redeploy
  (`src/common/feature-flag/feature-flag-not-found.middleware.ts` L20-31, L38-64). If the unlink
  routes sat under `FEATURE_PERSON_LINK` (or under `/api/scout`, which `FEATURE_SCOUT_INGEST`
  darkens, L22), a flag flip during an incident would silently remove L7's recovery right while
  the 30-day clocks keep running. Two designs were weighed:
  1. _Operational invariant_ — "never disable while active links exist". Rejected as the sole
     rail: the very reason to flip a flag is an incident in the claim path, when waiting up to 30
     days for links to close is not an option, and an env-var rule enforced by people is not a
     rail the record can prove.
  2. **_Authenticated unlink path outside the gate_ — chosen.** The client unlink route lives at
     `POST /api/person-links/:id/unlink` and the coach unlink route at
     `POST /api/coach/person-links/:id/unlink`, prefixes that appear in **no**
     `FEATURE_GATED_ROUTES` entry, so they are mounted whenever the D5 build is deployed,
     independent of `FEATURE_PERSON_LINK` and of the scout flags. They are JWT-guarded, act only
     on a link whose `user_id` (client) or `coach_id` (coach, inside the window) is the caller,
     answer a uniform 404 for any other id, and can only **return** rows (§2.7 unlink) — they
     create, mint, verify or link nothing. Undo is a data-rights recovery path of the same kind
     as account deletion, which is likewise never behind a dark flag; the R-DARK-1 exception is
     recorded here deliberately. Admin unlink stays on the owner surfaces, which are not flagged
     either. §3.4's route names are updated accordingly.
     Belt-and-braces: disabling `FEATURE_PERSON_LINK` while `PersonLink` rows are inside their undo
     window raises an admin alert listing their count (an ops-visible fact, not a rail), and the
     mobile undo screens (UX-D5) read the link state from the ungated route, so they keep working
     while claims are dark.
- Post-commit notification failure never affects the link: the intent is durable (outbox rows in
  the link transaction), delivery retries with back-off, exhaustion is visible on the link
  (`notify_status`) and raises an admin alert, and the coach roster shows the undo window from
  the server regardless of whether the email arrived (the in-app notification is written in the
  same transaction and cannot be lost).

## 4. Threat model

| Threat                                                                                                                  | Rail that closes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Forwarded invite / account takeover**: the invite link reaches someone other than the person                          | The link alone claims nothing. Claiming needs a one-time code delivered to a contact the coach confirmed (L3, §2.4), so the holder must also control that channel; the claimant can never substitute a contact (API shape, §3.2 step 3). Then the human must say "yes" to "is this you?" (L4). The 30-day undo (L7) and coach notification on link give a recovery path if all three fail. Contrast: today's `intended_email` compares an unverified login email (§2.4).                                                       |
| **Contact change at the source / wrong contact on file**                                                                | The coach confirms the contact at invite time (L2). A wrong contact means the code reaches the wrong channel: the recipient sees only the masked pre-verification page (§3.2 step 2), never the Person's name or history, and cannot proceed without also being the account holder who confirms. The coach can revoke and re-mint at any time.                                                                                                                                                                                 |
| **Coach mistake** (invites or proposes the wrong client)                                                                | Two-sided: the client must confirm after seeing the disclosure (L4/L5). Either side can unlink for 30 days and only imported rows move back (L7). `records_moved` makes the scope of the mistake visible.                                                                                                                                                                                                                                                                                                                      |
| **Malicious coach** (tries to attach an imported history to an unrelated client, or to grab a client of another coach)  | Cross-tenant is impossible by construction: `Person.coach_id` must equal the user's `coach_id` or the user must be unattached (§2.2); a link never changes an existing `coach_id`. Within tenant the client's confirmation is required, and the disclosure (name, counts, dates) lets the client refuse. Imported data is data the coach already holds, so the residual harm is showing it to the **wrong client**; minimum disclosure before confirmation keeps that to name + counts (OQ-10 on whether counts are too much). |
| **Enumeration** (of invites, Persons, accounts)                                                                         | ≥128-bit token, hash-stored, so guessing is infeasible regardless of throttle; every public failure collapses to one `{valid:false}`; 6-digit codes are defended by the four stacked layers already accepted for pairing (`extension-pair.service.ts` L378-388: TTL, per-row lockout at 5, per-IP throttle, constant-time compare). No route reveals whether a Person exists to a non-owner (the roster reader's uniform 404, `scout-roster.service.ts` L85-97, is the model).                                                 |
| **Replay** (confirm resent, invite email re-sent, webhook-style duplicates)                                             | Idempotent confirm (§2.8), single-use invite via `updateMany WHERE status='open'`, `EmailService` idempotency key per invite row (L816-819 pattern), challenge single `verified_at`.                                                                                                                                                                                                                                                                                                                                           |
| **Race** (two claimants; claim vs unlink; claim vs import; claim vs revoke)                                             | Person row lock serialises every state transition (§2.8); the S8-E writer reads the Person under the same lock discipline; serialization failures are retried by the engine (S11-B r2).                                                                                                                                                                                                                                                                                                                                        |
| **Cross-tenant data movement**                                                                                          | Every write is scoped by `coach_id` taken from the token; `PersonLink.coach_id = person.coach_id` re-asserted; the unlink join requires `provenance.coach_id = person.coach_id`; RLS on `Person`, invites, challenges and links is service_role-only (§2.2).                                                                                                                                                                                                                                                                   |
| **Contact PII at rest**                                                                                                 | Contacts live only on the invite and are scrubbed at terminal status; `PersonLink` stores a digest; logs and analytics carry ids, never contacts or codes.                                                                                                                                                                                                                                                                                                                                                                     |
| **Audit loss**                                                                                                          | `PersonLink` is written in the link transaction; `AuditService.write` is best-effort by design (L168-172) and therefore secondary.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Privilege**: an `owner` or a coach account claiming as a client                                                       | Refused as `attachUserToCoachByCode` refuses owners (L563-568); the claimant must be `student` or unattached; a `coach`-role user cannot be linked (OQ-4 asks about coaches who are also someone's client).                                                                                                                                                                                                                                                                                                                    |
| **Re-link bypass** (a coach proposal re-attaches a client who just unlinked)                                            | Impossible: every path activates through a Person-bound invite minted after the last `unlinked_at`, a new challenge and a new "yes" (§2.7 step 1, §3.3; B3).                                                                                                                                                                                                                                                                                                                                                                   |
| **Pending proposal squatting** (an unconfirmed proposal occupies the Person or account slot, or a merge row multiplies) | Proposals live in `PersonLinkProposal` with expiry/decline/revoke/supersede; `PersonLink` uniqueness is on completed links only; merge activation is refused until OQ-1; anchor constraints are composite FKs + checks (§2.5; B2).                                                                                                                                                                                                                                                                                             |
| **Partial deployment** (claim live before undo exists; deadline clock runs with no exit)                                | D4b + D5 behind one flag; the flag cannot exist before D5's specs are green; unlink routes are mounted outside every feature gate so a flag-off never strands an open undo; in-app notice and outbox intent are written in the link transaction (§3.5; B5).                                                                                                                                                                                                                                                                    |
| **Direct DB read of imported history** (coach via `check_in_coach_select` / `assignment_coach_manage`)                  | Every non-owner policy branch on the eight tables gains `person_id IS NULL`; three parents get in-tree policies for the first time; composite FK pins a person-owned check-in's `coach_id` to the Person's tenant (§2.2; B1).                                                                                                                                                                                                                                                                                                  |

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
(`facts.service.ts` L1003-1015).

**Slice S8-D1 contract (B4; OQ-11 decided by derivation = create-only):** `clientsFamily.persist`
follows the S8-C writer shape (`native-writers.ts` L91-105: look up provenance, verify the target,
otherwise create) instead of the upsert at `families.ts` L84-100:

1. `findProvenance(coach_id, source_namespace, entity_type = clients, source_id)`. If a row exists
   with `native_kind = person`: load the Person by `native_id` and **verify** — `coach_id` must
   equal the run's coach (else `unresolved:identity_conflict`, as `verifyTarget` L82); `state =
Deleted` → `unresolved:native_target_removed` (as `archived_at` L80-81) and **no** update, no
   re-creation, no state change (no silent resurrection); otherwise `already_present` with
   `display_name` **untouched** (D-S8-4: later passes never overwrite an accepted row).
2. If no provenance row exists but a Person matches the external ref
   `(coach_id, source_platform, source_person_id)` (rows created before D1): adopt it — write the
   provenance row with `outcome = already_present`, verify as in step 1 (a `Deleted` match is
   `native_target_removed`, not adopted), and do **not** touch `display_name`. From this run on the
   row is create-only.
3. Otherwise `create` the Person with the mapped `display_name` and write provenance
   `outcome = created`. Return `{ok: true, targetId, targetKind: 'person', unresolvedChildren: 0}`;
   the engine stamps the ledger kind (`scout-reconstruct.service.ts` L510-520 typed branch).
4. `readPersons` (`facts.service.ts` L1003-1015) maps `state = Deleted` to `removed` (S9-DOC
   bucket i) instead of `present`.

S8-D1 specs (named by the review): edited `display_name` survives a replay (create-only);
replay against a `Deleted` Person yields `native_target_removed`, the Person stays `Deleted`, no
new Person is created; a Person of another coach at the same external ref is
`identity_conflict`; a pre-D1 Person is adopted once and thereafter `already_present`; historical
ledgers with `target_kind` NULL stay bucket f `unresolved` until their run is re-staged (S9 reads
the ledger, not the Person); five repeated runs produce one provenance row and identical
outcomes. D1 flips D2 case (h) for the `clients` family only — a run is `complete` only when
**every** family in it is complete (C6); other unresolved families keep it `partial`.

### 5.2 Rendering contract

Two readers exist: the importer-G intent-scoped roster (`GET /scout/reconstruct/roster`,
`scout-roster.controller.ts` L77-90; DTO fields `id, state, source_platform, source_person_id,
display_name, created_at, updated_at`, `scout-roster.service.ts` L225-233) and the coach client
list (`CoachService.getClients`, `User role = student`, L133-150). D-S8-2 (a) says the **coach
roster** shows imported Persons. Slice S8-D2:

- Coach roster response gains a sibling collection `imported_people[]` (not interleaved into
  the `User` array, so no existing consumer sees a non-User row): `{person_id, display_name,
state, source_platform, joined: false, invite: {status, sent_via, expires_at} | null,
proposal: {status, expires_at} | null, suggestions: [{user_id, display_name}] | []}` for every
  Person of the coach with
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

| Slice  | Scope                                                                                                                                                                                                                                                                                               | Grade | Depends on                                                                                     | Migration                 | Prod LOC (est.) | Blocked by owner OQ                                      | Ruling                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------- | ------------------------- | --------------- | -------------------------------------------------------- | --------------------------------------------------- |
| S8-D0  | This decision record (Round 1 + Round 2) and the appended S8-DOC forward pointer                                                                                                                                                                                                                    | T4    | OWNER; independent T4 review                                                                   | no                        | 0               | —                                                        | this commit                                         |
| S8-D1  | Typed `person` handoff, create-only with provenance verification (§5.1 steps 1-4); `readPersons` Deleted → removed; S9 fixtures; named specs; roster-bearing runs may settle `complete` only when every family is                                                                                   | T4    | S11-A2 landed                                                                                  | no                        | 200–300         | **none** (OQ-11 decided by derivation)                   | PROCEED after re-review of this record              |
| S8-D2  | Coach roster `imported_people[]` + `person_link` + `proposal` markers; importer-G `roster_bridge_pending` retirement; contract regen; suggestions read (never applied); privacy review of every field emitted                                                                                       | T4    | S8-D1                                                                                          | no                        | 250–400         | **none** (renders server state only)                     | PROCEED                                             |
| S8-D3  | Schema (§2.1-2.5, §2.9): five new tables, `Person.linked_user_id`, `provenance.person_id`, nullable owner + `person_id` + XOR/coach CHECKs + composite FKs on five parents, strict partial uniques, RLS rewrite for eight tables + role×state matrix spec, staged in three directories; type ripple | T4    | S11-A2 + S11-D proofs landed on the 173-pin, **or** explicit parent re-pin in the same landing | **yes — 4 dirs** (§2.9)   | 550–800         | none (merge exemption index deferred to D6)              | PROCEED; SPLIT if measured > 1,000                  |
| S8-D4a | Invite mint / list / revoke / resend limits / email send / public preview; `Person` `InvitePending ↔ Invited`; `Suspended` admin freeze + reinstate; audit; coach UI contract                                                                                                                       | T4    | S8-D3                                                                                          | no                        | 400–500         | none (OQ-5, OQ-8 derived; OQ-13 = phone off)             | PROCEED                                             |
| S8-D4b | Challenge (email OTP) / verify / disclosure / confirm; link transaction (§2.7) incl. `link_collision` abort; outbox rows + in-tx notifications; idempotency + race specs; `FEATURE_PERSON_LINK` gate shared with D5                                                                                 | T4    | S8-D4a                                                                                         | no                        | 500–650         | OQ-10 (interim: minimal disclosure)                      | PROCEED; **not enableable before D5** (§3.5)        |
| S8-D5  | Unlink (client, coach ≤ 30 d, admin) with reason codes + actor ids; return-only-imported join (four-field compare); `missing` count; `unlink_collision` abort; outbox worker + `notify_status`; `person_link` marker semantics                                                                      | T4    | S8-D4b                                                                                         | no                        | 400–550         | OQ-2, OQ-7 (interim defaults in §7)                      | PROCEED; D4b + D5 land as one releasable gate       |
| S8-D6  | `PersonLinkProposal` lifecycle (create/decline/revoke/expire/supersede/start → invite); L5 `proposal_match` activation; L8 merge activation + exemption index + anchor trigger                                                                                                                      | T4    | S8-D5                                                                                          | yes (exemption index)     | 350–500         | **OQ-1** (merge part), OQ-6 (challenge on first-time L5) | PROCEED for match part; merge part BLOCKED on OQ-1  |
| S8-D7  | Phone channel: SMS transport + phone OTP; masked phone disclosure; "unavailable" → real choice                                                                                                                                                                                                      | T4    | owner spending/provider decision                                                               | no                        | 200–300         | **OQ-13**                                                | BLOCKED (owner)                                     |
| S8-E1a | `WorkoutSession` + `ExerciseSet` person-owned writer (S8-DOC §4.5 rules); provenance kinds CHECK expand; `person_id` via D-S8-3; Person `FOR SHARE` discipline                                                                                                                                      | T4    | S8-D3, S8-D1                                                                                   | yes (CHECK expand, 1 dir) | 300–450         | none                                                     | PROCEED                                             |
| S8-E1b | `WeightLog` + `CheckIn` writers (`coach_id = person.coach_id`; units §3.9; `reviewed_by_coach` contract amendment recorded explicitly, S8-DOC L457-460)                                                                                                                                             | T4    | S8-E1a                                                                                         | no                        | 250–350         | none                                                     | PROCEED                                             |
| S8-E1c | `Habit` + `HabitLog` writer                                                                                                                                                                                                                                                                         | T4    | S8-E1a                                                                                         | no                        | 150–250         | none                                                     | PROCEED                                             |
| S8-E1d | `ClientWorkoutAssignment` inactive import (PLAN L313; S8-DOC L241-245)                                                                                                                                                                                                                              | T4    | S8-E1a                                                                                         | no                        | 150–250         | **OQ-12**                                                | BLOCKED (owner) — writer stays unresolved meanwhile |
| UX-D2  | Mobile: roster imported rows + label + Invite form + invite/proposal list                                                                                                                                                                                                                           | T2    | S8-D2, S8-D4a                                                                                  | —                         | 300–500         | none                                                     | PROCEED                                             |
| UX-D4  | Mobile: client claim screens (preview → verify → disclosure → yes/no), proposal start, collision message, "phone unavailable" copy                                                                                                                                                                  | T3    | S8-D4b                                                                                         | —                         | 300–450         | OQ-10 (copy only)                                        | PROCEED                                             |
| UX-D5  | Mobile: undo affordances both sides with reason codes, notifications copy                                                                                                                                                                                                                           | T2    | S8-D5                                                                                          | —                         | 150–250         | none                                                     | PROCEED                                             |
| UX-EXT | Extension: no change required (roster and claim are mobile/web). Optional readiness-panel count "imported, not yet joined" from the server                                                                                                                                                          | T1    | S8-D2                                                                                          | —                         | ≤50             | none                                                     | OPTIONAL                                            |

**D1 and D2 depend on no owner OQ** (confirmed against §7: OQ-1/2/6/7/9/10/12/13 each block D5,
D6, D7, E1d or copy only). All grades are T4 except pure UI (C7: D1 changes durable identity
provenance and S9 completeness; D2 publishes PII and suggestions). LOC figures are planning
estimates from file touch counts (§2.1), not measurements; a builder re-measures at grant time
and splits any slice that crosses 1,000.

Single S8-E1 would be 850-1,300 lines and single S8-D4 ~900-1,150; both are split above so no
slice is planned above 1,000.

**Migration sequencing.** The S11 proof lane pins the schema: `EXPECTED_MIGRATIONS = 173`
(`test/utils/g2-s11-pg-harness.ts` L39; `test/utils/g2-s11-bootstrap.sh` L36, L159-160) and
"last (sorted) directory is S10-B's `20270124000000_scout_run_observation_expand`" (bootstrap
L164-165), with the prisma tree required byte-identical to `711c1f8f` (bootstrap L150-156;
guard `test/utils/g2-s11-db-guard.spec.ts` L194-195, L220-222). Any S8-D3 (four directories,
§2.9: 173 → 177), S8-E1a (→ 178) or S8-D6 (→ 179) migration therefore breaks that lane's bootstrap
until it is re-pinned (`EXPECTED_MIGRATIONS`, `LAST_MIGRATION` and the prisma-tree byte-identity
base all move together).
Rule: S8-D3 lands **after** S11-A2 and S11-D have taken their proofs on the 173-pin, or the parent
re-pins the S11 harness explicitly in the same landing (a T2 pin move, reviewed). S8-D1, S8-D2
ship no migration and may land earlier, after S11-A2 (they change what J19 step 11 reads).

**Owner boundaries (unchanged):** production deployment and `FEATURE_*` values (`/api/scout/*`
is dark unless flagged, `scout-roster.controller.ts` L78-81), live source accounts, G3-AUTH,
S8-D/E principal enablement in production, CWS, branch protection, and the S8-D7 spending
decision. Every slice above is built and proven on `integration/importer` only.

## 7. Open questions (Round 2: derived vs owner)

### 7.1 Decided by derivation (no owner choice needed; recorded so the reasoning is auditable)

| OQ    | Decision                                                                                                                                                                                                                                                  | Derived from                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-3  | `CheckIn` `(user_id, date)` collision on link: **fail closed** — the link aborts with `link_collision` naming the dates; neither row is overwritten or silently skipped; the client resolves and retries or declines (§2.7 step 4).                       | L1129 unique key; mission rule "unknown never silently becomes zero"; S8-DOC §3.5 `native_uniqueness` semantics.                                  |
| OQ-4  | A claimant attached to a different coach is **refused**; `coach`, `sub_coach` and `owner` accounts are never linkable as clients; the link never reassigns `coach_id` or downgrades a role (§2.2).                                                        | L6 tenant isolation; single-valued `User.coach_id` (L164); owner refusal precedent (L563-568).                                                    |
| OQ-5  | Invite 14 days single-use; one-time code 10 min; verified-but-unconfirmed window 15 min; lockout at 5 wrong codes; resend limits 3/24 h per invite, 10/h per coach, challenge resends 3/h per claimant; per-IP throttle as the landing controller (§2.4). | `InviteCode` default (L143); `ExtensionPairCode` lockout (L41); implementation constants, revisable without touching L1-L8.                       |
| OQ-8  | `Suspended` is an **admin/manual safety freeze** only, with audited reinstatement; nothing automatic — a failed-code lockout revokes that invite only (§2.3).                                                                                             | No code sets it today (L6951-6957); automatic suspension would let an attacker holding a link deny the coach's L2 right; least-privilege default. |
| OQ-11 | `Person.display_name` is **create-only** once provenance is written; replays verify the target and preserve edits; pre-D1 rows are adopted once (§5.1).                                                                                                   | S8-DOC D-S8-4 (binding); S8-C writer pattern `native-writers.ts` L91-105.                                                                         |

### 7.2 Owner questions (open; each has a safe interim default that ships until answered)

| OQ    | Plain-words question for Bradley                                                                                                                                                                                                | Interim default (in force until answered)                                                                                                                                     | Blocks                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| OQ-1  | When the same client was imported twice by one coach (two platforms), should both imported records attach to the one account, or must they first be merged into one imported record?                                            | Strict L6: one Person per account per coach; merge activation refused by the database; both Persons shown, one unjoined (§2.5, §3.3).                                         | S8-D6 merge part (index + activation) only    |
| OQ-2  | If a client edits imported history while linked and then unlinks, may the edited history go back to the coach's imported record, or should edited records stay with the client?                                                 | Hand over the row as it is (edits travel back); counts in `records_returned` (§2.7).                                                                                          | S8-D5 acceptance only (code path identical)   |
| OQ-6  | For a client who is already your client (L5), is their in-app "yes" enough, or must they also receive a code at a contact you hold, like a new client?                                                                          | Code on every path, including L5/L8 (§3.3); for any Person with a past link the code is mandatory regardless (B3).                                                            | S8-D6 match part (only to relax)              |
| OQ-7  | If the client deletes their account within the 30-day window, should the imported records go back to your imported record first, or be deleted with the account? May an actively linked imported record ever be erased?         | Account deletion is **blocked** while a link is inside its undo window (client is told to unlink first or wait); a linked Person cannot be erased (§2.3, §3.1 "Data rights"). | S8-D5 acceptance; account-deletion touchpoint |
| OQ-9  | Notes, goals, measurements and profile fields have no place to live for an imported client. Do you want new destinations for them, or should they stay explicitly "unresolved" in this release?                                 | Explicitly `unresolved`; nothing fabricated (S8-DOC §3.5).                                                                                                                    | none in S8-D/E (future family slices)         |
| OQ-10 | After the code is verified but before the client says "yes", should they see how many records and which dates the history covers, or only enough to answer "is this you?" (coach name, your name on the record, history kinds)? | Minimal: coach card, Person display name, family **kinds** only — no counts or date ranges until "yes" (§3.2 step 4 is this payload verbatim).                                | UX-D4 copy; S8-D4b disclosure payload         |
| OQ-12 | How should an imported historical workout assignment appear so it never schedules or notifies anyone — what exact "inactive" state and fields should be kept?                                                                   | Assignment import stays `unresolved`; no `completed_at` invention (`ClientWorkoutAssignment` has no inactive flag, L2323-2358).                                               | S8-E1d                                        |
| OQ-13 | Which SMS provider and budget may we use, and may the email-only version launch before phone is available?                                                                                                                      | Email only where deliverable; phone contact stored but marked unavailable; no D7 spend; copy names it a capability limitation (§2.4, C8).                                     | S8-D7                                         |

**Confirmation:** S8-D1 and S8-D2 depend on none of the rows in §7.2.

### 7.3 Notes that are not questions

- The `owner` role's direct read of person-owned rows on `ExerciseSet`, `HabitLog`, `CheckIn` and
  the snapshot is existing behaviour kept unchanged (§2.2 item 2). Removing it is a one-line
  policy change per table if the owner wants it.
- `rls_fitness_backend.sql` becomes superseded for `WorkoutSession`, `WeightLog`, `Habit` once D3
  lands (§2.2 item 1); the parent should schedule the out-of-band file's retirement for those
  three tables.

## 8. Invariant cross-check

| Invariant                                          | Held by                                                                                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New source → core diff 0                           | Nothing here is per-source; `person_id` resolution uses the D-S8-3 key through the S8-A interpreter (§2.6).                                                                                                    |
| No login `User` minted for an imported person (D2) | Claim requires an existing authenticated `User`; no route creates one (§3.1).                                                                                                                                  |
| Email/phone never an identity or linking key       | Contacts exist only on the invite for delivery and as an OTP channel; `PersonLink` holds a digest; no lookup by contact anywhere.                                                                              |
| Unknown never silently becomes zero                | Link and unlink abort on collision instead of skipping; `records_returned.missing`, `send_status`, `notify_status` and per-family `unresolved` stay visible; no family is `complete` before its writer exists. |
| No fabricated server behaviour in UI               | §5.2: labels and link markers come from server fields only.                                                                                                                                                    |
| Owner-reserved boundaries untouched                | §6 boundaries; S8-D7 blocked on owner; flags stay dark.                                                                                                                                                        |
| Coach edits preserved (D-S8-4)                     | Link/unlink flip owner columns only; no content is rewritten; `Person.display_name` is create-only from S8-D1 (§5.1).                                                                                          |
| Fresh invite + fresh confirmation on re-link (L7)  | §2.7 step 1 invite-after-last-unlink precondition on every path; no `InvitePending → Claimed` edge (§2.3, §3.3).                                                                                               |
| Every link/unlink audited (L6)                     | `PersonLink` with actor ids and reason codes written in the transaction; outbox intent in the same transaction (§2.5).                                                                                         |

## 9. Round 2 closure map (independent T4 review of `ded755ab`)

| Finding | Closed by                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1      | §2.2: effective-policy inventory (eight tables, file:line), `person_id IS NULL` guards, in-tree policies for three parents, stated owner exception, composite-FK tenant pin on `CheckIn.coach_id`, role × owner-state matrix.                                          |
| B2      | §2.5: `PersonLinkProposal` with lifecycle/authorization; `PersonLink` completed-only with `linked_at NOT NULL`; active uniques on `linked_at IS NOT NULL AND unlinked_at IS NULL`; strict account unique until OQ-1; anchor constraints.                               |
| B3      | §2.3 (no `InvitePending → Claimed`), §2.7 step 1 (invite minted after last `unlinked_at`), §3.3 (proposals activate only through invite + challenge + confirmation).                                                                                                   |
| B4      | §5.1: create-only with provenance verification; `Deleted` → `native_target_removed`, no resurrection; adoption of pre-D1 rows; named specs; C6 completeness rule.                                                                                                      |
| B5      | §3.5: `FEATURE_PERSON_LINK` shared by D4b + D5; flag forbidden before D5 specs are green; outbox + in-transaction notifications; `notify_status` on the link.                                                                                                          |
| C2      | §2.9 three-directory staged migration with `NOT VALID`/`VALIDATE`, `CONCURRENTLY`, timeouts, rollback.                                                                                                                                                                 |
| C3      | §2.4: atomic counters, resend limits, void-all-challenges, unknown tokens charge nothing.                                                                                                                                                                              |
| C4      | §2.5/§3.4: actor ids, reason-code enum, note never auto-shown.                                                                                                                                                                                                         |
| C5      | §2.7: four-field provenance compare, deleted-row `missing` count, fail-closed collisions, shared lock discipline, single transaction.                                                                                                                                  |
| C7      | §6: D1 and D2 re-graded T4; LOC labelled estimates.                                                                                                                                                                                                                    |
| C8      | §2.4 `send_status`, §7.2 OQ-13 interim: email-only is a capability limitation.                                                                                                                                                                                         |
| OQ      | §7.1 derived (3, 4, 5, 8, 11) and §7.2 owner (1, 2, 6, 7, 9, 10, 12, 13) with interim defaults and blocked slices.                                                                                                                                                     |
| B6 (R3) | §3.2 step 4 returns exactly the §7.2 OQ-10 interim payload (coach, Person display name, family kinds; no counts/dates); §3.3 proposal pre-verification shows no Person name; one disclosure contract.                                                                  |
| B7 (R3) | §2.9: four directories — unique keys before the FKs that reference them (`Person(id, coach_id)` CONCURRENTLY in D3-2, promoted in D3-3 before `NOT VALID` FKs, validated in D3-4; `PersonLink` triple unique before its anchor FK in D3-1); S11 pin 173 → 177/178/179. |
| B5 (R3) | §3.5: unlink routes mounted outside every `FEATURE_GATED_ROUTES` prefix (chosen over an operational no-disable invariant, reasons stated); §3.4 routes renamed; alert on flag-off with open links.                                                                     |
