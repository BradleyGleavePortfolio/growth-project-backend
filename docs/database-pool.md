# Production Database Pool Configuration

> **Audit 1 / Fix #4** — Explicit Prisma connection-pool sizing for the 2-CPU Fly machine.

## Background

Prisma's default `connection_limit` is `(physical_cpu_count × 2) + 1`. On the
current Fly machine (`performance-2x`, 2 vCPUs) that resolves to **5 connections**.

The backend has **38 NestJS modules**, several of which issue parallel
`Promise.all` queries in a single request cycle (most notably
`getClientTimeline` in `src/timeline/`). Under concurrent load those 5 slots
exhaust quickly, causing Prisma to emit:

```
P2024 — Timed out fetching a connection from the connection pool.
```

Setting an explicit limit of **10** gives comfortable headroom for the
parallel-query patterns without stressing the Supabase connection limit.

---

## Required `DATABASE_URL` Query Parameters

Append the following to your existing `DATABASE_URL` value before (or after)
any other query-string parameters:

```
?connection_limit=10&pool_timeout=10
```

| Parameter | Value | Meaning |
|---|---|---|
| `connection_limit` | `10` | Maximum simultaneous Prisma client connections to Postgres |
| `pool_timeout` | `10` | Seconds Prisma waits for a free connection before throwing `P2024` |

### Why 10?

| Scenario | Connections needed |
|---|---|
| Baseline idle + cron workers | ~3 |
| Single `getClientTimeline` request (`Promise.all` over ~7 queries) | ~7 |
| Two concurrent timeline requests | ~14 → capped, queued by Prisma within `pool_timeout` |

10 covers the common concurrent-request case without approaching Supabase
session-pooler limits (default 15 per client).

---

## Exact `fly secrets set` Command

Run this once against the Fly app (requires `fly` CLI and appropriate
org access):

```bash
# 1. Export the current value (so you can append, not replace)
CURRENT_DB_URL=$(fly secrets list --app backend-spring-lake-3890 --json \
  | jq -r '.[] | select(.Name=="DATABASE_URL") | .Digest')

# NOTE: fly secrets list only shows digests, not plaintext values.
# You must retrieve the plaintext from wherever you stored it
# (Supabase dashboard → Settings → Database → Connection string →
#  "Session mode" URL).

# 2. Append the pool params and push
fly secrets set \
  DATABASE_URL="<your-session-pooler-url>?connection_limit=10&pool_timeout=10" \
  --app backend-spring-lake-3890
```

Fly performs a rolling restart automatically after `fly secrets set`.
No code change is required — the `DATABASE_URL` value is read at
process startup.

> **One-liner if you already have the full URL in your shell:**
>
> ```bash
> fly secrets set DATABASE_URL="${DATABASE_URL}?connection_limit=10&pool_timeout=10" \
>   --app backend-spring-lake-3890
> ```
>
> Skip if `DATABASE_URL` already contains `connection_limit=`.

---

## Startup Warning

`src/prisma.service.ts` emits a `WARN`-level log line at boot if
`DATABASE_URL` is set but does **not** contain `connection_limit=`:

```
[PrismaService] WARN DATABASE_URL has no connection_limit — Prisma will use its default. See docs/database-pool.md
```

This warning is informational — the app boots and runs normally. It is a
reminder for operators who have not yet applied the `fly secrets set` above.

---

## How to Verify Post-Deploy

1. **Trigger a parallel-query endpoint** — call any endpoint that fires
   multiple Prisma queries concurrently, such as:

   ```
   GET /api/timeline/client/:clientId
   ```

   (`getClientTimeline` issues several parallel `findMany` calls via
   `Promise.all`.)

2. **Check Fly logs** — run:

   ```bash
   fly logs --app backend-spring-lake-3890
   ```

   After the rolling restart you should see the `[PrismaService] Database
   connected successfully` log and the `WARN` line about `connection_limit`
   should be **absent**.

3. **Absence of `P2024`** — If the pool is correctly sized, you will not see
   `P2024 — Timed out fetching a connection from the connection pool` in logs
   under typical load.

---

## Rollback

If the new `pool_timeout=10` is too aggressive for a degraded database (e.g.
during a Supabase incident), temporarily raise it:

```bash
fly secrets set DATABASE_URL="<url>?connection_limit=10&pool_timeout=30" \
  --app backend-spring-lake-3890
```

To revert to Prisma defaults entirely (not recommended for production):

```bash
fly secrets set DATABASE_URL="<url-without-pool-params>" \
  --app backend-spring-lake-3890
```

---

## References

- [Prisma — Connection pool](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)
- [Prisma error reference — P2024](https://www.prisma.io/docs/orm/reference/error-reference#p2024)
- [Fly.io — Secrets management](https://fly.io/docs/apps/secrets/)
- [Supabase — Connection pooling](https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler)
