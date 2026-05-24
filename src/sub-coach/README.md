# Sub-Coach Management (`src/sub-coach/`)

Phase 11 / Track 7 addition. Provides the head-coach–facing management surface
for sub-coach rosters, capacity enforcement, engagement analytics, and atomic
client reassignment.

## Data Model

Sub-coaches are `User` rows with `role = 'coach'` and a `coach_id` pointing at
their head coach.

**Client → sub-coach delegation is an overlay** stored in the
`SubCoachAssignment` join table:

```
SubCoachAssignment {
  id, head_coach_id, sub_coach_id, client_id,
  assigned_at, unassigned_at? , assigned_by_id?, reason?
}
```

`User.coach_id` **always points at the head coach** for a client. A row in
`SubCoachAssignment` with `unassigned_at IS NULL` means the client is currently
delegated to a sub-coach. Closing the assignment is a soft action — the row
is preserved with `unassigned_at = now()` for history.

This preserves every head-coach query that scopes by `User.coach_id = headId`
(roster, messaging, coach console, dashboard) — the head coach always sees
the full team roster, with sub-coach delegation surfaced as a separate join.

A partial unique index enforces "at most one open assignment per client" at
the DB layer:

```
CREATE UNIQUE INDEX SubCoachAssignment_one_open_per_client
  ON SubCoachAssignment(client_id)
  WHERE unassigned_at IS NULL;
```

## Services

| Service | Responsibility |
|---|---|
| `SubCoachAssignmentService` | Roster reads (open SubCoachAssignment join) |
| `SubCoachAnalyticsService` | Engagement score per sub-coach (0–100) |
| `SubCoachCapacityService` | Enforce max-client cap from billing plan tier |
| `SubCoachReassignService` | Atomic assign / reassign / unassign + AuditLog |
| `SubCoachIdempotencyService` | (actor, idempotency_key) → stored response dedupe |

`SubCoachReassignService` is the single entry point for every mutation —
both `assign-client` and `reassign-client` route through it so capacity,
audit, and idempotency are enforced identically.

## Engagement Score Formula

| Signal | Points |
|---|---|
| Sent at least one message in the last 7 days (active proxy) | +20 |
| Sent a message within 48 h of a client's last check-in | +30 |
| Created a workout routine this calendar week | +25 |
| Client session-day rate >= 70 % this month | +25 |
| **Cap** | **100** |

## API Endpoints

All routes require `JwtAuthGuard` + `CoachGuard` (coach or owner role).

```
GET  /sub-coaches?limit=&cursor=     — paginated list (max 50/page)
GET  /sub-coaches/:id                — single sub-coach detail + client list
POST /sub-coaches/:id/assign-client  — assign a client (idempotent)
POST /sub-coaches/:id/reassign-client — atomic transfer (idempotent)
GET  /sub-coaches/:id/analytics      — engagement score breakdown
```

Mutation bodies require a client-generated UUID `idempotency_key` (R19).
Retries with the same `(actor_id, idempotency_key)` return the original
stored response instead of executing the mutation again. Same-destination
reassignment is a no-op success, not a 400.

## Plan Tier Caps

| Tier | Max clients per sub-coach |
|---|---|
| `starter` | 25 |
| `flat_300` | 50 (default) |
| `growth` | 100 |
| `scale` | 250 |
| `enterprise` | 1000 |

Capacity is checked **inside** the Prisma `$transaction` at Serializable
isolation. Two concurrent assigns to the same sub-coach at capacity cannot
both observe an open slot — one wins, the other surfaces as a 409. The
partial unique index on `SubCoachAssignment(client_id)` is the DB-level
backstop.

## Audit Trail

Every mutation writes an immutable `AuditLog` row scoped to the head coach's
tenant (`tenant_coach_id`):

- `sub_coach.client_assigned`
- `sub_coach.client_reassigned`
- `sub_coach.client_unassigned`

The transaction rolls back atomically if any step fails, so there is no risk
of silent un-logged transfers.
