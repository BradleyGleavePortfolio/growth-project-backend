# Hyperscaler Patterns: Gym Membership & Feature Flag Evaluator

---

## Question 1 — Non-PT Gym Member Membership Model (B-Q3)

### How Hyperscalers Model "Person Belongs to Organization(s)"

**1. Apple Family Sharing — one group, one membership, scalar reference**

Apple models family membership as a strict one-to-one group assignment: each Apple Account can belong to *only one* Family Sharing group at a time ([Apple Support: How Family Sharing works](https://support.apple.com/en-us/105062)). The organizer holds a foreign key to the group, and each invited member's Apple Account is then associated with that group ([Apple Legal: Family Sharing & Privacy](https://www.apple.com/legal/privacy/data/en/family-sharing/)). This is the scalar model—Apple trades multi-group flexibility for simplicity, accepting the trade-off that a person cannot simultaneously be in two family plans. The billing and entitlement logic is simple as a result, but the constraint is real and occasionally breaks legitimate use cases (e.g., blended families).

**2. Google Workspace — strict per-org account creation (one-to-one)**

Google enforces a hard boundary: a user account belongs to exactly one organizational domain. You cannot share a user identity across two separate Google Workspace tenants. When a user needs access to a second organization, Google creates a new user account for them ([Google Cloud Community: Setting up Cloud Identity for Multinational Companies](https://medium.com/google-cloud/setting-up-google-cloud-identity-for-multinational-companies-4afcbb18dee1)). Within a single organization, users belong to exactly one Organizational Unit (OU), but can be members of multiple *Groups* ([YeshID: Guide to Google Workspace](https://www.yeshid.com/post/guide-to-google-workspace-and-saas-management-organizational-units-groups-and-access-control)). The OU is a scalar FK; group membership is a join table. Google accepts the trade-off of identity fragmentation in exchange for strict data isolation.

**3. Stripe Connect — platform-scoped accounts, explicit join record**

Stripe's Connect model creates one `Account` object per connected business and explicitly tracks the platform-to-account relationship as a join record. Since July 2021, a Stripe account can be connected to only one platform at a time (single-platform policy), but a single Stripe *login* can own multiple accounts, each independently connected to different platforms ([Stripe: Security, permissions, and access levels](https://support.stripe.com/questions/security-permissions-and-access-levels-when-connecting-your-stripe-account-to-a-third-party-platform)). The Accounts v2 API unified this further: one `Account` object carries multiple *configurations* (merchant, customer, recipient), avoiding the old dual-table mess ([Stripe: Connect and the Accounts v2 API](https://docs.stripe.com/connect/accounts-v2)). Stripe's lesson: **the join record is the configuration surface**.

**4. Slack — workspace-scoped user identity, with Enterprise Grid as the unifying layer**

Slack's original model was purely scalar: each user ID was scoped to a single workspace, and the same human on two workspaces had two different user IDs ([Slack: users.identity method](https://docs.slack.dev/reference/methods/users.identity/)). For Enterprise Grid, Slack introduced an `enterprise_id` as a global anchor and a `migration.exchange` API to reconcile workspace-local user IDs into global user IDs ([Slack: Developing for Enterprise orgs](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)). The Unified Grid rewrite (2024) added explicit join-table-like structures at the org level to support cross-workspace channels and views ([Slack Engineering: Unified Grid](https://slack.engineering/unified-grid-how-we-re-architected-slack-for-our-largest-customers/)). Slack's lesson: they shipped scalar first and paid a massive migration cost to retrofit a join model at scale.

**5. Notion and Linear — the hybrid join-table model**

[Flightcontrol's authoritative guide to multi-tenant SaaS data modeling](https://www.flightcontrol.dev/blog/ultimate-guide-to-multi-tenant-saas-data-modeling) names three canonical access models: **GitHub** (one global identity, join table to N orgs), **Google** (one identity per org, no joins), and **Linear** (hybrid—same person can have multiple accounts *and* any account can join multiple orgs). Linear and Notion both use the GitHub/Linear hybrid: a single user identity, with a `Membership` join table (`user_id`, `organization_id`, `role`) as the bridge. WorkOS's developer guide ([The developer's guide to SaaS multi-tenant architecture](https://workos.com/blog/developers-guide-saas-multi-tenant-architecture)) articulates the canonical invariant: "A user can belong to multiple tenants — so membership is a join table."

**6. Fitness Industry: Mindbody / ClassPass**

Mindbody explicitly supports cross-location memberships. Its architecture uses a `Site ID` as the top-level tenant anchor, with one site potentially comprising multiple physical locations. Members have centralized profiles and a cross-location membership record grants them access to multiple locations under one account ([Mindbody: Multi-location management](https://www.mindbodyonline.com/business/multi-location-management)). ClassPass, acquired by Mindbody in 2021, takes this further: its entire business model is a user joined to *every* gym in its network via a credits-based access table — the ultimate M:N membership join.

### Recommendation: Use Option B — `GymMembership` Join Table

**Build the join table from day one.** Every hyperscaler that started with a scalar FK (Slack, Apple) either built a costly migration layer or accepted permanent feature limitations. Every hyperscaler that started with a join table (Stripe Connect, Linear, Notion, Mindbody) extended gracefully to multi-location use cases.

The concrete schema follows the canonical pattern identified by Flightcontrol and WorkOS:

```sql
CREATE TABLE gym_memberships (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  gym_id        UUID NOT NULL REFERENCES gyms(id),
  plan_type     TEXT NOT NULL,           -- 'floor_access', 'all_access', etc.
  status        TEXT NOT NULL,           -- 'active', 'frozen', 'cancelled'
  started_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ,
  UNIQUE (user_id, gym_id)
);
```

**Trade-offs accepted:** a slightly more complex query path (JOIN instead of direct FK lookup), and the need to always scope reads by `gym_id`. The compensating controls are: index on `(gym_id, status)` for door-check queries, and Row-Level Security or a service-layer guard that injects `gym_id` context into every query. The upside is that cross-gym access passes, corporate wellness aggregator integrations (ClassPass-style), and franchise-wide all-access memberships are free in the model rather than requiring a schema migration later.

---

## Question 2 — Multi-Tenant Feature Flag Evaluator: User → Tenant Set Resolution (C-Q6)

### How Hyperscalers Resolve "User → Tenant Set" on the Hot Path

**1. LaunchDarkly — multi-context object, all dimensions hydrated in one call**

LaunchDarkly's canonical answer to multi-tenancy is the *multi-context* object: a single evaluation call carries `user`, `organization`, and any other relevant dimension simultaneously ([LaunchDarkly: Multi-contexts](https://launchdarkly.com/docs/home/flags/multi-contexts)). Server-side SDKs download the complete flag ruleset at startup and evaluate entirely in-process with no network round-trip per request ([LaunchDarkly: Flag evaluation rules in server-side SDKs](https://launchdarkly.com/docs/sdk/concepts/flag-evaluation-rules)). The SDK is a pure function: `(context, ruleset) → variation`. Critically, LaunchDarkly's architecture requires that **all attributes needed to evaluate a flag must be present in the context at call time** — the SDK does not hydrate missing attributes from a database ([LaunchDarkly: Context configuration](https://launchdarkly.com/docs/sdk/features/context-config)). If gym-scoped rules need `gymId`, it must be in the context object, not lazily fetched.

**2. Statsig — download ruleset once, evaluate all users locally sub-1ms**

Statsig server SDKs download the full project ruleset (all gates, experiments, dynamic configs) on `initialize()` and then evaluate every subsequent call locally ([Statsig: How Evaluation Works](https://docs.statsig.com/sdks/how-evaluation-works)). Each `checkGate(user, flagKey)` call takes under 1ms with zero network calls ([Statsig: Client vs Server SDKs](https://docs.statsig.com/sdks/client-vs-server)). The `StatsigUser` object is the single context carrier — all tenant identifiers (`gymId`, `organizationId`) must be provided as `customIDs` or `custom` fields on every call; Statsig explicitly warns "SDKs don't store or enrich attributes from previous calls." This is identical in spirit to LaunchDarkly: eager context assembly, stateless evaluation engine.

**3. Unleash — properties map for arbitrary tenant context**

Unleash's context object contains a `properties` map for arbitrary key-value data, including custom context fields like `tenantId` or `gymId` ([Unleash: Unleash context](https://docs.getunleash.io/reference/unleash-context)). The SDK evaluates strategies locally against this context. Like LaunchDarkly and Statsig, Unleash's evaluation model assumes that all context data is pre-assembled before the evaluation call.

**4. Google Cloud IAM — policy evaluation with eventual-consistency caching**

Google Cloud IAM resolves principal-to-resource membership by reading policy bindings at access time. Policy changes propagate with eventual consistency: a policy change typically takes 2 minutes to propagate, and group membership changes can take "several minutes to potentially hours" ([Google Cloud: Access change propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation)). GCP caches policy data at the service layer; Google explicitly accepts a propagation window as the cost of global distribution. The IAM evaluation path does not make a per-request database call — the policy data is pre-distributed and cached at enforcement nodes.

**5. AWS IAM — distributed eventual consistency, ~4-second cache window**

AWS IAM uses a distributed eventual-consistency model. The IAM control plane reflects changes immediately, but the data plane (where authorization happens) caches policy data per principal ([AWS IAM: How to monitor and query IAM resources at scale](https://aws.amazon.com/blogs/security/how-to-monitor-and-query-iam-resources-at-scale-part-1/)). The propagation delay is documented as "several seconds to potentially minutes," with research confirming approximately 4 seconds in typical cases ([Hacking the Cloud: IAM Persistence through Eventual Consistency](https://hackingthe.cloud/aws/post_exploitation/iam_persistence_eventual_consistency/)). The architecture lesson: AWS accepts a short staleness window to keep the authorization hot-path free of synchronous database calls. Policy data is pushed to enforcement nodes, not pulled per request.

**6. Stripe — eager org-membership assembly before API dispatch**

Stripe's Dashboard and API layer resolve which accounts a user has access to at session-establishment time and stores `stripe_user_id` → `account_id` mappings in the platform's own database ([Stripe: Billing for a multi-entity business](https://docs.stripe.com/billing/multi-entity-business)). Per-request permission checks use the pre-assembled account list. Stripe's explicit guidance is: "store the customer ID and Stripe account ID in your database so that when you check the statuses of invoices... you know you're referencing the correct Stripe account." This is eager, not lazy.

**7. Vercel Edge Config — sync flag rules to the edge, evaluate locally**

Vercel Edge Config enables LaunchDarkly and Statsig to sync their flag ruleset into Vercel's edge network, so flag evaluation happens at the edge closest to the user with no round-trip to the flag service ([Vercel: Using Edge Config with integrations](https://vercel.com/docs/edge-config/edge-config-integrations)). The context object (including tenant IDs) must still be assembled server-side before the evaluation call.

### Recommendation: Option (a) — Single-Roundtrip CTE, All Dimensions Eager

**Load `gymIds` as part of the single-roundtrip context CTE, not lazily.**

The unanimous signal from every evaluated system is: **all dimensions the evaluator may need must be present in the context object before evaluation begins**. No hyperscaler feature-flag system fetches missing context attributes on demand inside the evaluation loop. LaunchDarkly, Statsig, and Unleash all document this explicitly. Google IAM and AWS IAM pre-distribute policy data to enforcement nodes precisely to avoid synchronous database calls on the authorization hot path.

**Concrete architecture for your evaluator:**

```sql
-- Single CTE: assemble full evaluation context in one roundtrip
WITH user_context AS (
  SELECT
    u.id            AS user_id,
    u.role,
    array_agg(gm.gym_id) FILTER (WHERE gm.status = 'active') AS gym_ids,
    array_agg(gm.plan_type)                                   AS plan_types
  FROM users u
  LEFT JOIN gym_memberships gm ON gm.user_id = u.id
  WHERE u.id = $1
  GROUP BY u.id, u.role
)
SELECT * FROM user_context;
```

Pass the resulting `{ userId, role, gymIds: [...] }` object into the flag evaluator as a single `StatsigUser` / LaunchDarkly multi-context. The evaluator is then a pure, stateless function with no further I/O.

**On Option (b) — lazy resolution:** Lazy `gymId` resolution requires the evaluator to block mid-evaluation on a database call the first time a gym-scoped rule fires. This breaks the sub-millisecond evaluation guarantee all major SDKs provide and risks blowing the p99 < 250ms budget in the tail when gym-scoped rules become common. AWS and GCP accept a propagation window precisely *to avoid* this pattern.

**On Option (c) — separate cache for gymIds:** This is viable as a second-level optimization if gym membership changes slowly relative to user-attribute changes. AWS IAM's architecture implicitly does this — it caches resource policies on a different cadence than identity policies ([AWS: Diving deeply into IAM policy evaluation](https://www.tenable.com/blog/diving-deeply-into-iam-policy-evaluation-highlights-from-aws-reinforce-iam433)). If `GymMembership` rows are updated infrequently (e.g., monthly), a short Redis TTL (30–60 seconds) on the `user_id → gym_ids[]` mapping is a reasonable second-level cache. The trade-off: a small staleness window on membership changes (acceptable — a member whose membership lapses at 14:00:00 getting gym access until 14:00:30 is operationally fine). If you implement this cache, **keep it separate from session tokens** (different invalidation cadence: membership changes are infrequent; session revocation must be immediate).

**Trade-offs accepted:**
- The context CTE adds ~2–5ms to session establishment (one extra JOIN), but the evaluator itself becomes zero-latency after that.
- If a user belongs to many gyms, `gym_ids[]` grows. At fitness-platform scale (most members have 1–2 gym memberships), this is a small array with negligible overhead.
- Membership cache staleness: accepting up to the cache TTL of stale access is a deliberate trade for hot-path latency, mirroring AWS IAM's ~4s propagation window.

---

## Summary

**Question 1 (B-Q3):** Use **Option B — `GymMembership` join table**. Every hyperscaler that started with a scalar FK (Apple, early Slack) hit structural limitations; every system that started with a join table (Stripe Connect, Linear, Notion, Mindbody) extended gracefully to multi-location and multi-plan scenarios.

**Question 2 (C-Q6):** Use **Option (a) — load `gymIds` in the single-roundtrip context CTE**. LaunchDarkly, Statsig, Unleash, AWS IAM, and GCP IAM all pre-assemble context before evaluation; none lazily fetches missing dimensions inside the evaluation loop. Optionally layer a short-TTL Redis cache on `user → gymIds[]` (Option c) for high-frequency evaluation paths where gym membership changes slowly.
