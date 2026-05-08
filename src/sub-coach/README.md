# Sub-Coach Management (`src/sub-coach/`)

Phase 11 / Track 7 addition. Provides the head-coach–facing management surface
for sub-coach rosters, capacity enforcement, engagement analytics, and atomic
client reassignment.

## Data Model

Sub-coaches are `User` rows with `role = 'coach'` and a `coach_id` pointing at
their head coach. Clients can be assigned to a sub-coach by updating their own
`coach_id` to point at the sub-coach instead of the head coach.

No schema migration is required — the self-FK already exists on the `User`
table.

## Services

| Service | Responsibility |
|---|---|
| `SubCoachAssignmentService` | CRUD for client → sub-coach assignments |
| `SubCoachAnalyticsService` | Engagement score per sub-coach (0–100) |
| `SubCoachCapacityService` | Enforce max-client cap from billing plan tier |
| `SubCoachReassignService` | Atomic reassignment + AuditLog entry |

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
GET  /sub-coaches                     — list sub-coaches (capacity + score)
GET  /sub-coaches/:id                 — single sub-coach detail + client list
POST /sub-coaches/:id/reassign-client — atomic client transfer
GET  /sub-coaches/:id/analytics       — engagement score breakdown
POST /sub-coaches/:id/assign-client   — direct assignment
```

## Plan Tier Caps

| Tier | Max clients per sub-coach |
|---|---|
| `starter` | 25 |
| `flat_300` | 50 (default) |
| `growth` | 100 |
| `scale` | 250 |
| `enterprise` | 1000 |

## Audit Trail

Every client reassignment writes an immutable `AuditLog` row with action
`sub_coach.client_reassigned`, scoped to the head coach's tenant
(`tenant_coach_id`). The transaction rolls back atomically if the audit write
fails, so there is no risk of silent un-logged transfers.
