# Admin console — deployment, auth, RBAC

Companion to [`control-room-spec.md`](./control-room-spec.md). This doc
covers how the console is deployed, how operators authenticate, the
advisory client-side capability matrix, and the optional admin mobile
companion wire contract.

Migrated from the superseded PR #127 (`docs/admin-web-dashboard.md`)
sections §1.3, §2, §11, §17. Where the source spec conflicts with the
canonical control-room spec (#128), the control-room spec wins.

---

## 1. Shape and deployment

- **Web app first.** Single-page application served from a private
  hostname (e.g. `https://admin.thegrowthproject.app`). All API calls
  go to the existing fitness backend `/api/admin/*` surface with the
  operator's Supabase OWNER JWT in the `Authorization` header. No new
  backend hostnames; no new auth model.
- **Repo:** `tgp-admin-web` (to be created). Stack target matches the
  existing coach-console pattern: Next.js + TypeScript + Tailwind, no
  server actions, all fetch through `/api/admin/*`.
- **Optional admin mobile companion** (Phase 2+). A read-mostly native
  surface for incident triage and approvals on the go. Same
  `/api/admin/*` endpoints, same OWNER JWT, no special-case
  authentication. Out of scope for the v1 cut. See §5.
- **Distinct from `new-website`.** The admin app is private, gated,
  and bundles separately. `new-website` deploys to its own surface and
  serves anonymous traffic only. Cross-linking from `new-website` into
  the admin app is forbidden — operators reach the dashboard via a
  bookmark or SSO portal, not a public link.
- **Distinct from the coach console.** The coach console is a
  per-coach BFF surface at `/api/v1/*`. The admin console hits
  `/api/admin/*` only and never bypasses the coach BFF to read a
  coach's own data.

---

## 2. Authentication

- Supabase email/password sign-in, identical to the mobile/coach flow.
- The dashboard reads the JWT, asserts `role === 'owner'` client-side
  for routing, and then **trusts the server** for every authorization
  decision. The class-level `@Roles('owner')` guard on every
  `/api/admin/*` controller is the only authorization that matters.
- Non-OWNER tokens hitting any admin route get a clean 403; the UI
  renders a "this dashboard is restricted to platform owners" page
  and surfaces a "request access" mailto. No partial views.
- Production and staging are **separate browser sessions and separate
  URLs.** Every screen carries an `Environment: production` /
  `Environment: staging` pill driven by the API base URL the
  dashboard is configured against.

---

## 3. RBAC — advisory capability matrix (v1)

There is no per-tenant scoping. OWNER is the platform-wide superuser
by design. The dashboard does NOT introduce a new sub-role layer in
the database in v1 — it derives a **capability matrix** client-side
from a small set of OWNER-managed flags exposed via a future
`/api/admin/operators` endpoint. Until that endpoint ships, every
OWNER sees every panel and the audit log is the accountability
mechanism.

The matrix is **advisory** — it hides UI affordances but is not the
authorization boundary. `/api/admin/*` controllers remain class-gated
by `@Roles('owner')` and that is the only hard gate.

| Capability | Endpoints it implies | UI affordance gated |
|---|---|---|
| `view:overview` | `/admin/metrics`, `/admin/audit-log`, `/admin/finance/health` | Renders Overview |
| `view:revenue` | `/admin/reports/billing-past-due`, future MRR/ARR (§11.A control-room) | Renders Finance/Revenue |
| `view:audit` | `/admin/audit-log`, `/admin/reports/audit-summary` | Renders Audit panel |
| `view:ai_audit` | future `/admin/ai/recent`, future `/admin/ai/cost` | Renders AI panel |
| `view:health` | `/admin/finance/health`, `/admin/integrations/status`, future health probes (§11.C) | Renders Health & Integrations |
| `act:promote` | `/admin/users/:id/promote` | Promote / demote button on Coaches and Customers |
| `act:gdpr_scrub` | `/admin/gdpr/scrub` | Run scrub button on Privacy & GDPR (always with confirmation) |
| `act:flag_rollout` | future `/admin/feature-flags` | Toggles on Feature Flags |
| `act:offer_moderation` | future `/admin/marketplace/offers/...` | Approve / reject on Marketplace |
| `act:payouts` | future `/admin/payouts/...` | Mark-paid on Payouts |
| `act:support` | future `/admin/support/tickets/...` | Ticket actions on Support |
| `act:suspend` | future suspend / unsuspend (§11.H control-room) | Suspend button on person profile |
| `act:reassign_coach` | future reassign / restore (§11.I control-room) | Reassign-coach button on client profile |
| `act:dunning_reminder` | future send-reminder (§11.L control-room) | Send-reminder button on Finance |
| `act:bulk_export` | future bulk export (§11.O control-room) | Export-CSV affordance on universal search |

### Phase-2 sub-OWNER triad

A future `OWNER_BILLING`, `OWNER_SUPPORT`, `OWNER_READONLY` triad sits
below `owner`. **Out of scope for v1** — this doc reserves the names
so a future enum addition is non-conflicting. The screens in
`control-room-spec.md` are designed to render correctly with action
buttons hidden when an attribute-level capability is absent.

When `/api/admin/operators` ships, the matrix becomes server-enforced
and operators are added/removed via a dedicated "Operators" section
under Settings.

---

## 4. Audit logging of operator actions

Every state-changing call from the dashboard already lands an
`AuditLog` row through `AuditService.write` on the backend (see
[`../audit-and-gdpr.md`](../audit-and-gdpr.md) §"Currently wired
sensitive actions"). The dashboard does not need to log anything
client-side; it reads `/api/admin/audit-log` to render the activity
stream.

The dashboard MUST attach a `X-Operator-Action: <verb>` header on
state-changing calls so the backend can echo it into
`metadata.via=admin_console` for forensic clarity. Backend support
for echoing this header into audit metadata is part of the future
runtime PRs in `pr-sequence.md`.

For Phase 2, `control-room-spec.md` §15 reserves the audit action name
`admin.profile.read` for audit-on-read of the universal person
profile.

---

## 5. Optional admin mobile companion — wire contract

Documented here so the shipped endpoints stay forward-compatible. Out
of scope for v1.

- Same hostname, same OWNER JWT, no new auth model.
- Mobile companion sends `X-Operator-Surface: admin-mobile` on every
  call. The backend whitelists the read set + the
  mastermind-approve/reject pair when this header is present and
  refuses every other write. Until that backend check lands, the
  mobile companion is not deployed.
- Push notifications are subscribed via the existing Supabase /
  notifications module — the companion app registers its push token
  the same way the mobile coach app does.
- Notification triggers (sent server-side, not client-polled):
  - `past_due_invoice_new` — a new `PaymentFailure` row landed.
  - `federation_degraded_sustained` — `/admin/finance/health`
    returned `degraded` for ≥ 5 minutes continuously.
  - `audit_high_risk` — an audit row with action ∈
    `{user.role_changed → owner, billing.subscription_canceled,
    feature_flag_changed (when it ships)}`.
- Notifications carry a deep link to the equivalent web-dashboard
  screen for full context.

---

## 6. What this doc does NOT do

- No runtime source changes under `src/`.
- No Prisma schema / migration changes.
- No environment variable changes.
- No CI / Fly / smoke configuration changes.
- No changes to `new-website` (no such directory in this repo).
- No invention of new auth models or per-tenant scoping.
