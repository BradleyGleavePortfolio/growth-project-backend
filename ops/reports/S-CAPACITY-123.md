# S-CAPACITY-123 — W3-20 launch-day capacity

- Agent: GPT-6.1 Sol, scout, operator agent 123.
- Start: 2026-10-05 21:30:59 PDT; final evidence/checkouts check: 21:44:14 PDT; completed inside the 30-minute time box.
- Scope: read-only repository inspection, existing GitHub release evidence, official vendor documentation, lightweight static AST inventory and price arithmetic; no PR, comment, push, build, CI dispatch, production request, Fly/Supabase action or spending.
- Backend snapshot: `5230306cb63df7290459bb362340a42f385f39d5` ([verified commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5230306cb63df7290459bb362340a42f385f39d5)).
- Mobile snapshot: `a727eb495a0ce381a22c4ac40370c0c69f53a656` ([snapshot implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/api/communityRealtime.ts)).
- Result: **A/B/C = 0/0/4; decisions only, not a load-capacity certification.** No outage at ordinary launch load was demonstrated. The four observations below distinguish fixed ceilings from configuration gaps and do not claim measured maximum users or requests per second.

## What fails first

1. **Shared-network signup can be rejected before infrastructure is busy:** the sixth codeless email registration from one public IP within an hour receives a rate-limit rejection, while the existing valid-code route instead has a configurable default of 100 attempts/hour/IP—an admission-policy threshold, not evidence that the intended invite-code launch is broken. ([Registration decorator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/auth/auth.controller.ts), [signup burst configuration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts))
2. **For broadly distributed signed-in users on Free, the first known quota-limited degradation is Realtime:** 200 simultaneous connections or 100 message events/second; fan-out can hit the message ceiling before the socket ceiling, and Realtime refuses joins or disconnects clients when the applicable limit is exceeded. ([Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits), [event accounting](https://supabase.com/docs/guides/realtime/settings))
3. **The first whole-API failure to watch is database waiting/readiness, not a proven Node memory threshold:** the code has 18 separately registered Prisma clients, and `/readyz` uses a database query with a 3-second application deadline while Fly probes it every 15 seconds with a 5-second timeout; a busy shared database/pool can therefore remove the sole API machine from routing, but the evidence does not establish whether CPU, pool waiting or database execution reaches that point first. ([Prisma lifecycle](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/prisma.service.ts), [readiness implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/health/health.controller.ts), [Fly configuration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml), [Nest provider semantics](https://docs.nestjs.com/modules))

**Recommendation:** use the already-approved Pro upgrade before the public launch surge, explicitly select the desired database compute size, and decide an app-machine budget only after accounting for all Prisma clients—not one pool per machine. The standing decision is Pro on launch day 1; Pro does not necessarily change an existing Nano compute instance automatically. ([Owner standing decision](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md), [Supabase compute guidance](https://supabase.com/docs/guides/platform/compute-and-disk.md))

## C-CAP-1 — Prisma pool budget is multiplied by 18

`src/prisma/prisma.module.ts:4-10` intends one globally shared Prisma client, but 17 mounted feature modules also place `PrismaService` directly in their own `providers` arrays; Nest creates separate instances for direct registrations in different modules, and every instance extends `PrismaClient` and attempts `$connect()` during initialization, including instances in modules whose feature flag is off. ([Global Prisma module](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/prisma/prisma.module.ts), [mounted module graph](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/app.module.ts), [Prisma initialization](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/prisma.service.ts), [Nest module semantics](https://docs.nestjs.com/modules))

Static inventory, resolving imports by file and exported class rather than class name:

| Provider registration | Exact location |
|---|---|
| Canonical shared client | [src/prisma/prisma.module.ts:9](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/prisma/prisma.module.ts) |
| AI credits | [src/ai-credits/ai-credits.module.ts:30](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/ai-credits/ai-credits.module.ts) |
| Billing | [src/billing/billing.module.ts:55](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/billing/billing.module.ts) |
| Dunning v2 | [src/checkout/dunning-v2/dunning-v2.module.ts:40](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/checkout/dunning-v2/dunning-v2.module.ts) |
| Coach Connect | [src/coach-connect/coach-connect.module.ts:21](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/coach-connect/coach-connect.module.ts) |
| Coach Money | [src/coach-money/coach-money.module.ts:11](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/coach-money/coach-money.module.ts) |
| Coach brief | [src/coach/brief/coach-brief.module.ts:21](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/coach/brief/coach-brief.module.ts) |
| Coach home | [src/coach/home/coach-home.module.ts:18](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/coach/home/coach-home.module.ts) |
| Holistic insights | [src/insights/insights.module.ts:14](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/insights/insights.module.ts) |
| Macros | [src/macros/macros.module.ts:16](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/macros/macros.module.ts) |
| Payouts v2 | [src/payouts-v2/payouts-v2.module.ts:45](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/payouts-v2/payouts-v2.module.ts) |
| Real meal plans | [src/real-meal-plans/real-meal-plans.module.ts:21](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/real-meal-plans/real-meal-plans.module.ts) |
| Scout | [src/scout/scout.module.ts:68](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/scout/scout.module.ts) |
| Sub-coaches | [src/sub-coaches/sub-coaches.module.ts:28](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/sub-coaches/sub-coaches.module.ts) |
| Anti-bot | [src/talent-marketplace/anti-bot/anti-bot.module.ts:18](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/talent-marketplace/anti-bot/anti-bot.module.ts) |
| Talent marketplace | [src/talent-marketplace/talent-marketplace.module.ts:66](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/talent-marketplace/talent-marketplace.module.ts) |
| Team mode | [src/team-mode/team-mode.module.ts:22](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/team-mode/team-mode.module.ts) |
| Team | [src/team/team.module.ts:24](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/team/team.module.ts) |

The application uses Prisma `6.19.3`, whose URL-level pool settings apply per Prisma client rather than per Fly machine; the v6 default is `physical CPU count × 2 + 1`, with a 10-second pool wait before `P2024`, so a reported two-CPU machine is commonly budgeted at five slots per client, but detected CPU count and the deployed URL parameters remain unverified here. ([Pinned Prisma version](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/package.json), [Prisma v6 pool documentation](https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections/connection-pool), [existing pool runbook](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/docs/database-pool.md))

| Scenario, configured maximum only | One machine | Two machines |
|---|---:|---:|
| 18 clients × 5 connections/client | 90 | 180 |
| 18 clients × runbook's 10 connections/client | 180 | 360 |
| One genuinely shared client × 10 connections/client | 10 | 20 |

These are arithmetic upper bounds, **not observed open connections**; the 18 registrations above and the runbook's 10-slot recommendation supply the inputs. ([Mounted modules](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/app.module.ts), [pool runbook](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/docs/database-pool.md))

| Supabase compute | RAM | Recommended direct Postgres max | Pooler client max | Pro total, one project |
|---|---:|---:|---:|---:|
| Nano / current Free class | Up to 0.5 GB | 60 | 200 | Not a new paid-plan selection |
| Micro | 1 GB | 60 | 200 | Approximately $25/month |
| Small | 2 GB | 90 | 400 | Approximately $30/month |
| Medium | 4 GB | 120 | 600 | Approximately $75/month |

The connection/RAM figures come from the official compute table, while paid totals are $25 Pro + compute price − the $10 monthly compute credit; **Pro Micro does not increase the published connection ceilings over Free Nano.** ([Supabase compute limits](https://supabase.com/docs/guides/platform/compute-and-disk.md), [plan and compute prices](https://supabase.com/pricing))

Do not equate a 200-client pooler limit with 200 direct Postgres connections: transaction-mode poolers multiplex client connections onto their configured backend pool, while direct connections and all backend pools share the database connection budget with Auth, Storage and PostgREST; Supabase advises leaving headroom, generally limiting pool allocation to about 40% when PostgREST is heavily used, or cautiously up to 80% otherwise. ([Pooler/client distinction](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits), [connection budgeting](https://supabase.com/docs/guides/database/connection-management))

The schema intends a pooled runtime URL on port 6543 and a separate direct migration URL, but the old pool runbook instead discusses session mode and calls the machine `performance-2x`; neither statement proves the current deployed pool mode or CPU kind. ([Schema connection comments](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/prisma/schema.prisma), [older runbook](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/docs/database-pool.md))

**Operator decision:** account for 18 clients before approving another machine. At 10 slots/client, two machines can request 360 pooler client slots—above Nano/Micro's 200; Small's 400 is a larger envelope, not a throughput guarantee. If an ordinary launch workload demonstrates connection failures, the smallest structural correction is to remove the 17 feature-local Prisma provider registrations and retain the canonical global provider, rather than buy database capacity to support duplicate pools. ([Provider registrations and imports](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/app.module.ts), [canonical provider](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/prisma/prisma.module.ts), [Nest semantics](https://docs.nestjs.com/modules), [compute ceilings](https://supabase.com/docs/guides/platform/compute-and-disk.md))

## C-CAP-2 — One app machine, CPU class unspecified, memory unmeasured

The deploy-8 release inventory contains one machine, `860311cee0d008`, in `sjc`, started with a passing service check; the later env-sync verification confirms all **one** started machine held the desired state. This is archived evidence, not a fresh production query. ([Deploy 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409368179), [env-sync verification](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409749015))

| Setting | Repository value / consequence | Evidence |
|---|---|---|
| Minimum | `min_machines_running = 1`, primary region `sjc` | [fly.toml:7,47](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml) |
| Stop/start | `auto_stop_machines = 'suspend'`, `auto_start_machines = true` | [fly.toml:45-46](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml) |
| CPU / RAM | `cpus = 2`, `memory = '2gb'`, `memory_mb = 2048`; no `cpu_kind` or preset `size` | [fly.toml:63-66](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml) |
| HTTP concurrency | No explicit concurrency section; documented defaults are connections, soft limit 20, no enforced hard limit when unset | [fly.toml](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml), [Fly config defaults](https://fly.io/docs/reference/configuration/) |
| Routing health | `/readyz`, 30-second grace, 15-second interval, 5-second Fly timeout | [fly.toml:50-58](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml) |
| Process | `node:20-slim`, direct `node dist/main.js`; no explicit heap flag in Docker runtime command | [Dockerfile:66,118](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/Dockerfile) |

Auto-start only starts **already-created** stopped/suspended machines; it does not provision more machines. Thus the configuration alone is not horizontal autoscaling, and the archived one-machine inventory supplies no spare to start. ([Fly autostart behavior](https://docs.fly.io/reference/fly-proxy-autostop-autostart), [deploy inventory](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409368179))

CPU kind matters more than the label “2 CPUs”: shared vCPUs have a 6.25% baseline quota per vCPU plus burst balance, while performance vCPUs have a 100% baseline; the live CPU kind is not present in the retained release inventory. ([Fly CPU quotas](https://docs.fly.io/machines/cpu-performance/), [Fly configuration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/fly.toml))

No runtime RSS, heap limit, CPU throttle, latency or database-wait measurement was collected in this read-only assignment, so 2 GB is a configuration fact—not demonstrated free memory or an OOM prediction. Runtime metrics are implemented, but the verified desired-state manifest deliberately unsets `METRICS_AUTH_TOKEN`, and the metrics guard consequently fails closed in a production-like environment. ([Runtime metrics implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/observability/prom-metrics.ts), [manifest:53,116](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/.github/fly-env-desired-state.json), [metrics guard:28-32](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/observability/metrics-auth.guard.ts), [manifest verification](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409749015))

**Recommended default:** two explicitly specified performance-1x / 2 GB app machines for launch-day app availability and predictable CPU, rather than one performance-2x / 4 GB at the same compute price; validate the database budget first. This is an owner option, not an instruction to change Fly now. ([Fly prices](https://docs.fly.io/about/pricing/), [CPU behavior](https://docs.fly.io/machines/cpu-performance/))

## C-CAP-3 — Realtime counts sockets and fan-out, not people

| Published default project limit | Free | Pro, spend cap on | Pro, spend cap off |
|---|---:|---:|---:|
| Concurrent connections | 200 | 500 | 10,000 |
| Message events/second | 100 | 500 | 2,500 |
| Channel joins/second | 100 | 500 | 2,500 |

These are project-level published defaults, configurable within the plan's envelope, and the high uncapped ceiling is a vendor limit, **not a recommended launch target**; Supabase measures the event setting over a rolling minute, and a delivered fan-out to 100 subscribers counts 100 events. ([Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits), [Realtime settings](https://supabase.com/docs/guides/realtime/settings))

The mobile community subscription and ordinary message subscription use **different module-level Supabase clients**, so an app with both subscriptions joined can use two WebSocket connections rather than one; community's badge subscribes from the tab icon and can remain joined while the user opens messaging, so the 200/500 quotas cannot be interpreted as guaranteed 200/500 concurrently active people. ([Community client](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/api/communityRealtime.ts), [messaging client](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/services/realtime.ts), [tab badge](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/navigation/ClientNavigator.tsx))

At two joined clients/app, simple division gives roughly **100 apps on Free or 250 on capped Pro**, before server/other connections; actual socket usage must be measured rather than assumed, because this is a quota-budget scenario derived from the implementations and published ceilings, not a load-test result. ([Mobile community client](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/api/communityRealtime.ts), [mobile message client](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/services/realtime.ts), [connection limits](https://supabase.com/docs/guides/realtime/limits))

Realtime failure is not automatically lost messages: community broadcasts are best-effort after writes, and the community unread hook retains a 60-second REST poll, but that fallback covers the unread query and must not be advertised as proof that every community screen refreshes every 60 seconds. ([Server broadcaster:87-90,146-176](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/community/realtime/community-realtime.service.ts), [unread poll:55-63](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/hooks/useCommunity.ts))

Free includes 2 million monthly messages and Pro includes 5 million, with uncapped overages priced at $2.50 per whole million-message package; Broadcast billing counts one sent message plus one per receiving client, while peak connection overages above Pro's included 500 are $10 per whole 1,000-connection package. ([Realtime message billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages), [peak connection billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-peak-connections))

**Recommended default:** leave the Pro spend cap enabled initially; if the planned simultaneous audience exceeds the two-client socket budget or delivered-event ceiling, ask for an explicit overage budget rather than silently disabling it. Pro without the spend cap increases the documented default connection/event envelope, but incurs the package-priced overages above. ([Realtime limits](https://supabase.com/docs/guides/realtime/limits), [Realtime pricing](https://supabase.com/docs/guides/realtime/pricing))

## C-CAP-4 — Admission limits are not global load protection

| Default / fixed route ceiling | Bucket / launch implication | Evidence |
|---|---|---|
| Codeless registration: 5/hour | IP; sixth person on one shared network is rejected | [auth.controller.ts:79-80](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/auth/auth.controller.ts) |
| Valid-code signup: 100/hour | IP; code-bearing signup has its own burst bucket | [throttler.config.ts:180-193,325-336](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts) |
| Password login: 20/minute and 200/hour | IP; success does not clear the network ceiling | [throttler.config.ts:166-172](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts), [login decorators](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/auth/auth.controller.ts) |
| Google/Apple: 60/minute and 400/hour | Separate pre-auth IP buckets | [throttler.config.ts:173-178](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts) |
| Default authenticated: 300/minute | Verified user-keyed default, not a whole-system RPS budget | [throttler.config.ts:155-157,372-384](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts), [user tracker](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/user-throttler.guard.ts) |
| Public signup/invite reads: 240/minute | IP; separate read bucket | [throttler.config.ts:158-164](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts) |
| Checkout mint: 20/hour | User; not a global purchase ceiling | [throttler.config.ts:204-207](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts) |

Environment-backed entries above are defaults rather than verified production overrides, while the registration decorator's 5/hour is fixed in code; the mobile uses `/auth/signup-with-code` when a code is supplied and `/auth/register` otherwise. ([Rate configuration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts), [registration decorator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/auth/auth.controller.ts), [mobile routing:500-519](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/a727eb495a0ce381a22c4ac40370c0c69f53a656/src/screens/auth/CreateAccountScreen.tsx))

Authenticated requests perform the database user lookup in `JwtAuthGuard` before `UserThrottlerGuard`, so these user-level ceilings do not eliminate that database admission work; production requires a Redis-backed rate-limit store, which shares limits across app machines rather than automatically doubling each user's allowance when a machine is added. ([Authentication DB lookup:110-112](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/auth/auth.guard.ts), [guard order:428-452](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/app.module.ts), [Redis requirement:642-674](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5230306cb63df7290459bb362340a42f385f39d5/src/throttler/throttler.config.ts))

**Recommended default:** use the existing valid-code flow for a shared-network launch event, and retain abuse protection; do not globally turn rate limiting off to increase capacity. If codeless group signup is part of the actual launch plan, the 5/hour/IP limit needs an explicit product/security decision, not a bigger Fly machine.

## Owner options and monthly cost

All figures below are **USD planning estimates**, calculated from the current official `sjc` regional formula for 30 days of continuously running Fly machines and one Supabase project, excluding Redis, AI/provider charges, egress, taxes, storage/rootfs and usage overages; Fly's memory pricing changed on October 1, 2026, so the older $5/GB add-memory rate is not used. ([Fly pricing formula](https://docs.fly.io/about/pricing/), [October pricing change](https://fly.io/pricing-update/), [Supabase plan/compute pricing](https://supabase.com/pricing))

| Option | Fly app target | Supabase target | Combined estimate / month | Recommended use |
|---|---|---|---:|---|
| No change today | Existing machine, actual CPU kind/rate unverified | Free | **$0 incremental**, current Fly bill continues | Keep read-only until owner decides; published Free ceilings remain ([Realtime limits](https://supabase.com/docs/guides/realtime/limits)) |
| Minimum paid launch | 1 × shared-cpu-2x / 2 GB: $15.97 | Pro Micro: $25 | **$40.97** | Controlled rollout, still only one app machine ([Fly](https://docs.fly.io/about/pricing/), [Supabase](https://supabase.com/pricing)) |
| Budget app redundancy | 2 × shared-cpu-2x / 2 GB: $31.94 | Pro Small: $30 | **$61.94** | Lower-cost alternative if shared CPU is adequate; review pool multiplication first ([Fly](https://docs.fly.io/about/pricing/), [Supabase](https://supabase.com/pricing)) |
| Predictable CPU, one app | 1 × performance-1x / 2 GB: $39.35 | Pro Small: $30 | **$69.35** | Interim single-machine option ([Fly](https://docs.fly.io/about/pricing/), [Supabase](https://supabase.com/pricing)) |
| **Recommended public-launch app target** | **2 × performance-1x / 2 GB: $78.70** | **Pro Small: $30** | **$108.70** | Predictable CPU and two warm API machines, after pool budgeting ([Fly](https://docs.fly.io/about/pricing/), [Supabase](https://supabase.com/pricing)) |
| More memory, still one app | 1 × performance-2x / 4 GB: $78.70 | Pro Small: $30 | **$108.70** | Choose only if measured per-process memory requires 4 GB; not a replacement for a second machine ([Fly](https://docs.fly.io/about/pricing/), [Supabase](https://supabase.com/pricing)) |

For an explicitly approved launch-window spare rather than an always-running second app machine, a performance-1x / 2 GB in `sjc` costs approximately **$0.0546/hour**, or **$0.55 for 10 running hours**, plus stopped/suspended rootfs charges of $0.15/GB/month outside the window; such a spare must already exist for auto-start to use it, making this an economical burst option rather than two-machine always-on availability. ([Fly pricing](https://docs.fly.io/about/pricing/), [auto-start behavior](https://docs.fly.io/reference/fly-proxy-autostop-autostart))

The $108.70 target is **not an authorized purchase and not a capacity guarantee**; it is the recommended decision default for the owner's predictable-CPU/two-app-machine goal. The lower-cost $61.94 target is the budget alternative. No option here silently disables the Supabase spend cap.

## Operator continuation and saved evidence

1. Keep the no-spend state now. At launch day 1, apply the standing Pro decision before the surge and explicitly confirm database compute—paid plan alone can leave Nano in place. Recommended default: Pro Small if the owner accepts the extra approximately $5/month over Pro Micro. ([Standing rule](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md), [compute behavior](https://supabase.com/docs/guides/platform/compute-and-disk.md), [prices](https://supabase.com/pricing))
2. Before approving a replica, verify CPU kind, actual number of clients, pool mode, deployed pool sizing, Supavisor backend pool size and current open connections using an operator-authorized read-only channel; never include secret values or connection URLs in a report. Recommended default: do not budget the app as “two machines × one 10-slot pool.”
3. Ask the owner to choose the $108.70 public-launch target or the $61.94 budget target, with the caveats above; leave Fly unchanged until explicitly authorized.
4. Retain the Realtime polling floor and capped Pro initially; obtain a spending decision if the real audience forecast exceeds its socket/event envelope.
5. No A/B fix builder was requested from this evidence alone. Connection multiplication and group admission are exact code/configuration observations; a launch-impact B still needs a supported ordinary-user workload and verified deployed settings, not a speculative saturation claim.

Saved under `/home/user/workspace/ops/aud-123/S-CAPACITY-123/`:

- `static-prisma-providers.js` and `static-prisma-providers.json`: read-only AST inventory of 18 mounted provider registrations, with exact file:line and one-/two-machine pool arithmetic.
- `capacity-costs.js` and `capacity-costs.json`: reproducible `sjc` price inputs, vendor URLs, monthly targets and launch-window arithmetic.
- `env-sync-37409749015-logs.zip` and `env-sync-one-started-machine.txt`: existing GitHub workflow logs and the names/status-only verification line.
- `deploy8-release-evidence.zip`, `deploy8-release-manifest.zip`, `deploy8-machines-after.json`: existing release artifacts; filtered inventory confirms one started `sjc` app machine.

No new CI was started; existing deploy 8 and env-sync apply both succeeded at the inspected backend snapshot. No worktrees, branches or locks were created. ([Deploy 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409368179), [env-sync apply](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37409749015))

## HANDOFF
