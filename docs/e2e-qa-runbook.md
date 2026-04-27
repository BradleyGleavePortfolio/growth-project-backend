# Growth Project — End-to-End SaaS QA Runbook

This runbook walks the merged Growth Project SaaS flow from owner onboarding
through to coach↔client messaging and billing gating. It pairs with the
executable smoke spec at `test/e2e-saas-smoke.spec.ts`, which mocks Supabase
and Stripe so the backend contracts can be exercised without infra.

Use it before any release that touches auth, invite-code, AI context,
messaging, or billing.

---

## 0. Repos under test

| Repo | Branch | What it covers |
|---|---|---|
| `growth-project-backend` | `main` (this repo) | NestJS API + Prisma + Supabase admin + Stripe mirror |
| `growth-project-mobile` | PR #56 (in flight) | RN app — uses `/auth/signup-policy`, `/auth/attach-invite-code`, Google with `invite_code` |
| `tgp-coach-console` | `main` | Next.js coach + owner BFF console (consumes `/v1/coach/*`, `/admin/*`) |
| `tgp-finance-app` | `main` | Internal finance dashboards — observes Stripe mirror (read-only for QA) |

The smoke spec lives in **this** repo only; the runbook below is the cross-repo
manual QA companion.

---

## 1. Test environment + seed data

### 1.1 Required env flags

Set in `.env` (backend) before running the API. Mobile and console pull their
URLs from their own `.env` files but inherit policy from the backend.

| Var | Purpose | QA value |
|---|---|---|
| `COACH_CODE_GATE_ENABLED` | Forces clients to provide an invite code at signup | `true` for gated tests, unset for legacy path |
| `BILLING_ENFORCEMENT` | `enforce` denies inactive coaches; anything else is observe-only | `enforce` for gating tests, unset for rollout posture |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Supabase admin + native auth | point at the QA Supabase project |
| `SUPABASE_REDIRECT_URL` | Email-verify deep link | `tgp://verified` for the mobile build |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | Stripe billing mirror | use Stripe test-mode keys |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | Coach-portal return URL | `https://coach.qa.growthproject.app/billing` |
| `GOOGLE_OAUTH_CALLBACK_URL` (mobile) | Configured in Supabase + Google console | matches the `tgp://oauth/google` deep link the RN build uses |
| `PERPLEXITY_API_KEY` (or AI provider key) | `/ai/chat` upstream | optional — guardrails fall back if missing |
| `POSTHOG_API_KEY` | Analytics events | optional |

> **Do not rotate any production keys for QA.** Use the QA Supabase + Stripe
> test-mode projects only.

### 1.2 Seed data

Apply `prisma/seed.ts` (or run the steps manually in the QA DB):

1. **One owner** — the human running QA. Promote in DB by setting
   `users.role = 'owner'`. Existing helper: `scripts/bootstrap-owners.ts`.
2. **One target coach candidate** — a regular user account, will be promoted in
   step 2 of the manual flow.
3. **Two student accounts** — one to sign up via email + invite code, one to
   sign up via Google + invite code. Both must use addresses you can receive
   verification email at.
4. **One student with no coach** — to verify `NO_COACH_ASSIGNED` paths.
5. **Stripe test customer** — created automatically by the first
   `POST /v1/coach/me/billing/checkout-session` call. No manual seed needed.

### 1.3 Pre-flight checks

```bash
npm run build
npx jest test/e2e-saas-smoke.spec.ts            # the smoke spec (this PR)
npx jest                                         # full unit suite — must be 100% green
```

Both must pass before manual QA starts. If the smoke spec fails, the rest of
this runbook will give misleading results.

---

## 2. Manual QA flow

Each numbered step matches a `describe` block in
`test/e2e-saas-smoke.spec.ts`. The smoke spec proves the contract; the manual
steps confirm UI wire-up across mobile, console, and finance.

### Step 1 — Owner promotes a user to coach

**Console (tgp-coach-console)**

1. Log in as the OWNER.
2. Navigate to **Owner → Coaches → Add coach**.
3. Search for the target user by email; click **Promote to coach**.
4. Fill business name + timezone (optional).

**Expected**

- Console shows the new coach in the list immediately, with an `invite_code`
  prefixed `GP-` and 6 unambiguous chars (`[A-Z2-9]`, no `0/O/1/I/L`).
- Backend emits `POST /admin/users/:id/promote` returning `{role: 'coach'}`.
- DB: `users.role='coach'`, `coach_profiles` row exists with
  `created_by_owner_id = <owner.id>`.
- Owner attempting to promote themselves to a non-owner role returns 400
  `Cannot demote yourself`.
- Non-owner hitting `/admin/*` returns 403 (smoke spec covers via roles guard).

### Step 2 — Coach reads back their invite code

**Console**

1. Log out, log back in as the newly-promoted coach.
2. Land on **Coach → Settings → Invite link**.

**Expected**

- The same `GP-XXXXXX` from step 1 is shown, with a **Copy link** button.
- `GET /v1/coach/me` returns `profile.inviteCode = "GP-XXXXXX"`.
- Regenerating the code (Settings → **Regenerate**) immediately invalidates
  the previous code (re-test in step 4 if exercised).

### Step 3 — Mobile fetches signup policy

**Mobile (growth-project-mobile PR #56)**

1. Cold-launch the QA build.
2. Tap **Sign up**.

**Expected**

- App calls `GET /auth/signup-policy` once on launch.
- Response shape:
  ```json
  {
    "coach_code_required": true,
    "providers": ["email", "google"],
    "invite_code_field": "invite_code"
  }
  ```
- When `COACH_CODE_GATE_ENABLED=true`, the **Invite code** field is
  required; with the flag unset, the field is optional.
- App labels the field exactly using `invite_code_field` so a future rename
  flows automatically.

### Step 4 — Client previews the invite code

**Mobile**

1. Type the coach's `GP-XXXXXX` into the invite code field.
2. Tap **Preview** (or wait for debounced autopreview).

**Expected**

- Mobile calls `POST /auth/validate-invite-code` with `{code}`.
- Returns `{valid:true, coach_id, coach_name}` on a live code.
- Returns `{valid:false}` for an unknown, revoked, or paused/canceled coach.
- Endpoint is rate-limited at 20/min/IP; rapid repeats yield 429.

### Step 5 — Client signs up with email + invite code

**Mobile**

1. Email + password + name + invite code.
2. Tap **Create account**.

**Expected**

- Backend: `POST /auth/signup-with-code` returns
  `{requires_verification: true, user_id, email}`.
- Supabase sends a verification email (deep link `tgp://verified`).
- DB: `users.role='student'`, `users.coach_id = <coach.id>` after the
  invite-code attach inside the same call.
- With `COACH_CODE_GATE_ENABLED=true` and **no** code: 400
  `Coach invite code is required`.
- With an invalid code: 400 `Invalid or expired invite code`.

### Step 6 — Client signs up with Google + invite code

**Mobile**

1. Tap **Continue with Google**.
2. Complete the Google OAuth dance via Supabase (deep link
   `tgp://oauth/google` configured in Google Cloud + Supabase).
3. On the post-OAuth screen, paste the invite code and tap **Confirm**.

**Expected**

- Mobile calls `POST /auth/google` with `{token, invite_code}`.
- Backend validates the token came from Google (rejects email/password
  Supabase tokens — see audit C9).
- Response includes `invite_attached: true` when the code resolves;
  `false` if the attach failed (mobile shows a soft error and prompts the
  user to retry via `/auth/attach-invite-code`).
- DB: `users.coach_id = <coach.id>` after success.

### Step 7 — Client logs app data; AI sees it

**Mobile**

1. As the new student, log:
   - 1 food entry today (e.g. "Chicken bowl", 600 kcal).
   - 1 weight entry (~190 lb).
   - 1 morning check-in (mood/energy/sleep).
   - 1 workout session.
2. Open **AI Chat** and ask "How am I doing today?"

**Expected**

- Backend: `POST /ai/chat` builds `ClientAIContext` server-side.
- Server logs include "guardrails applied: …" when the upstream model
  drifts (smoke spec covers floor + macro guardrails).
- Inspect `GET /ai/_debug/context` (auth-gated to self) to confirm:
  - `today.calories` matches what was logged
  - `recent_adherence_7d` includes yesterday's entries (if any)
  - `coach.has_coach=true`, `coach_name` is the coach's first name
  - `prescribed.calories/protein_g` reflect the user's profile macros
  - `guardrails.forbid_calorie_recommendations_below` ≥ 1500 kcal
- The rendered prompt block includes both `APP_PRESCRIBED (DO NOT
  CONTRADICT)` and `GUARDRAILS` lines — never the user's email or
  Supabase id.

### Step 8 — Coach messages the client

**Console (coach role)**

1. Open the new client's thread under **Messages**.
2. Type "Welcome!" into the composer (autosave should fire after ~1s).
3. Send.

**Expected**

- Autosave: `POST /v1/coach/me/threads/:clientId/draft` with `{body}`
  returns `{draft: {body, updatedAt}}`. Refreshing the page restores the
  draft.
- Send: `POST /v1/coach/me/threads/:clientId/messages` returns the new
  message; the draft for that thread is cleared.
- Mobile (in foreground): receives a Supabase realtime ping and refetches
  `GET /messages/threads/me` — the new message appears within ~2s.
- Sending to a foreign client (not assigned to this coach) returns 404,
  not 403 (avoids leaking that the client exists).

### Step 9 — Client replies; unread counters update

**Mobile**

1. As the student, reply "Thanks!".

**Expected**

- Backend: `POST /messages/me` succeeds; `coach.unread_count` for the
  coach console updates to 1 (and to 0 once the coach opens the thread).
- A student with no `coach_id` posting `/messages/me` gets 409
  `NO_COACH_ASSIGNED` (smoke spec covers).
- Coach unread count endpoint groups by client, so a multi-client coach
  sees per-thread badges, not just a total.

### Step 10 — Billing gating

**Console (coach role)**

1. With **`BILLING_ENFORCEMENT` unset (observe mode)**, navigate to
   **Coach → Messages → Send**. Should succeed even if subscription is
   `canceled`.
2. Set `BILLING_ENFORCEMENT=enforce` (restart API).
3. In Stripe test mode, cancel the coach's subscription. Wait for the
   `customer.subscription.updated` webhook to mirror.
4. Try to send a message in the console.

**Expected**

- Observe mode: send succeeds; PostHog/log line indicates the guard
  *would* have denied (telemetry-only).
- Enforce mode: send returns 403 with body
  `{error: 'SUBSCRIPTION_INACTIVE', status: 'canceled'}`.
- `past_due` within the 7-day grace window: still allowed in enforce.
- `past_due` past 7 days: 403
  `SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED`.
- OWNER bypasses the guard regardless.

### Step 11 — Stripe webhook → mirror sanity check

**Local (or QA)**

1. Hit `stripe trigger customer.subscription.created` (test mode).
2. Hit `stripe trigger invoice.payment_failed`.

**Expected**

- `POST /billing/webhook` returns 200 in both cases.
- DB: a `coach_subscriptions` row is created/updated; on
  `payment_failed`, `last_payment_failed_at` is populated.
- Replays of the same event id are idempotent (Stripe `event.id`
  dedupe).
- `tgp-finance-app` reflects the same status on its next dashboard
  refresh (it reads the mirror, not Stripe directly).

### Step 12 — Owner observability

**Console (owner role)**

1. Visit **Owner → Coaches** and pick the coach from step 1.

**Expected**

- `GET /admin/coaches/:id` returns 7-day stat counts:
  `stats_last_7d.{logs, workouts, messages}`.
- The student counts include `archived_at IS NULL` actives separately
  from total roster.

---

## 3. Feature-flag matrix

| Scenario | `COACH_CODE_GATE_ENABLED` | `BILLING_ENFORCEMENT` | Expected |
|---|---|---|---|
| Pre-launch open beta | unset | unset | Anyone can sign up; coaches always allowed |
| Gated rollout | `true` | unset | Code required at signup; coaches always allowed |
| Production | `true` | `enforce` | Code required; canceled coaches blocked |
| Hot-rollback | unset | unset | Both gates off — same as pre-launch |

Smoke spec § 3 covers gate enforcement; § 7 covers billing matrix.

---

## 4. Known QA blockers / out-of-scope here

- **Mobile PR #56 not merged** — the runbook references its endpoints
  (`/auth/signup-policy`, `/auth/attach-invite-code`,
  `/auth/google` with `invite_code`) but the RN build itself is on a
  separate branch. Backend contracts are ready and unit-tested.
- **Stripe webhook signing** is exercised in
  `test/stripe-webhook.spec.ts` but ID-based dedupe across replays needs
  a manual run in test mode against a live endpoint.
- **Realtime broadcast** (`SupabaseService.broadcastNewMessage`) is fire-
  and-forget; the smoke spec asserts the call but a real Supabase
  Realtime channel must be verified manually with two devices.
- **Email verification deep links** depend on the mobile build's URL
  scheme registration (`tgp://verified`, `tgp://reset-password`,
  `tgp://oauth/google`). Re-verify on a fresh install if the scheme
  changes.
- **`tgp-finance-app`** consumes the same `coach_subscriptions` mirror
  but lives in a separate repo; its dashboards are not exercised by the
  smoke spec.

---

## 5. Re-running the smoke spec

Prerequisites (clean clone of `growth-project-backend`):

```bash
node --version    # >= 20.x (matches engines + CI)
npm ci            # exact install from package-lock.json
```

No `.env` file is required — the spec mocks Prisma, Supabase, and Stripe.
No database, no network calls, no migrations.

Run:

```bash
npx jest test/e2e-saas-smoke.spec.ts          # 21 tests, ~10s
npx jest                                       # full backend suite (33+ suites)
```

CI runs the full suite via `npm test` in `.github/workflows/ci.yml`; the
smoke spec is included. To re-run only the smoke spec on CI logs:

```bash
npx jest --runInBand test/e2e-saas-smoke.spec.ts
```

The spec is safe to run against any environment because it never opens a
network connection. If it fails, `npm test` will fail too — they share
the same Jest config.
