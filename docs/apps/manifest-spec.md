# Apps Platform — Manifest Spec

Status: DRAFT (docs only)
Wave: 6

## 1. Purpose

The manifest is the contract a TGP app declares to the platform: identity, version, capabilities, surfaces, monetization, signing key, and lifecycle hints. Every install resolves a manifest, verifies its signature, and pins to its declared version. The manifest is the single source of truth for what an app is allowed to do.

This document specifies the JSON schema, the TypeScript types, the signing model, the capability declarations, surface declarations, monetization declaration, and three worked examples.

## 2. Top-level schema

The manifest is a JSON document, signed via detached signature (see Section 6). The unsigned canonical form is what gets signed.

### 2.1 TypeScript shape

```ts
/** @public */
export interface AppManifest {
  /** Schema version of the manifest itself. Currently "1.0". */
  manifest_version: "1.0";

  /** Globally unique slug. [a-z0-9-]+, 3-64 chars. Immutable across versions. */
  app_id: string;

  /** Semver. MAJOR.MINOR.PATCH. */
  version: string;

  /** Display name. <= 64 chars. */
  name: string;

  /** Short description. <= 280 chars. */
  tagline: string;

  /** Long description. Markdown. <= 8 KB. */
  description: string;

  /** Developer identity. */
  developer: DeveloperRef;

  /** Categories from controlled vocab. 1-3. */
  categories: AppCategory[];

  /** Icon URL on app-cdn. 512x512 PNG, signed. */
  icon_url: string;

  /** Screenshots. 1-8 URLs. */
  screenshot_urls: string[];

  /** Homepage and support URLs. */
  homepage_url: string;
  support_email: string;
  privacy_policy_url: string;
  terms_url: string;

  /** Capability declarations. Must be subset of platform capability vocab. */
  capabilities: CapabilityDecl[];

  /** Surface declarations. */
  surfaces: SurfaceDecl[];

  /** Monetization. */
  monetization: MonetizationDecl;

  /** Network egress allowlist. */
  egress?: { allow: string[] };

  /** Webhook subscriptions (subset of capabilities of verb webhook:). */
  webhooks?: WebhookDecl[];

  /** Scheduled jobs. */
  scheduled_jobs?: ScheduledJobDecl[];

  /** Lifecycle hooks (URLs on the worker; not iframe). */
  lifecycle?: {
    on_install?: string;     // POST <worker>/lifecycle/install
    on_uninstall?: string;
    on_upgrade?: string;
    on_suspend?: string;
    on_resume?: string;
  };

  /** Auto-upgrade policy. */
  auto_upgrade?: "patch" | "minor" | "manual";

  /** Required platform features. */
  requires?: {
    platform_min_version?: string; // e.g. "2026.4.0"
    features?: string[];           // e.g. ["retention.v2", "rewards.v1"]
  };

  /** Localizations. */
  i18n?: Record<string, Partial<Pick<AppManifest, "name" | "tagline" | "description">>>;

  /** Signing block. Filled in at sign time, NOT by hand. */
  signature?: ManifestSignature;
}
```

### 2.2 Sub-types

```ts
export interface DeveloperRef {
  developer_id: string;     // assigned by dev portal
  display_name: string;
  legal_name?: string;
  contact_email: string;
  stripe_connect_account_id?: string;  // required if monetization is paid
  verified: boolean;        // true once dev portal verifies identity
}

export type AppCategory =
  | "programs"
  | "integrations"
  | "ai-tools"
  | "storefront"
  | "analytics"
  | "communication"
  | "billing"
  | "automation"
  | "content";

export interface CapabilityDecl {
  capability: string;       // e.g. "read:clients"
  reason: string;           // human-readable, shown to coach at install
  required: boolean;        // if true, install fails without it
  pii?: boolean;            // hint: this capability touches PII
}

export type SurfaceDecl =
  | AdminPageSurface
  | StorefrontBlockSurface
  | DashboardWidgetSurface
  | WebhookHandlerSurface
  | ScheduledJobSurface
  | McpToolSurface
  | ServerActionSurface;

export interface AdminPageSurface {
  type: "admin-page";
  slug: string;             // e.g. "calendly-sync"
  title: string;
  iframe_url: string;       // e.g. "https://app-cdn.tgp.example/<app_id>/<version>/admin/calendly-sync.html"
  required_capabilities: string[];
  nav: { section: "automations" | "integrations" | "tools" | "reports"; order: number };
}

export interface StorefrontBlockSurface {
  type: "storefront-block";
  slug: string;
  iframe_url: string;
  required_capabilities: string[];
  placement: "hero" | "row" | "footer";
}

export interface DashboardWidgetSurface {
  type: "dashboard-widget";
  slug: string;
  title: string;
  iframe_url: string;
  required_capabilities: string[];
  size: "1x1" | "2x1" | "2x2" | "3x2";
}

export interface WebhookHandlerSurface {
  type: "webhook-handler";
  events: string[];         // e.g. ["program.created", "client.checked_in"]
  worker_url: string;       // POST endpoint inside worker domain
  required_capabilities: string[];
}

export interface ScheduledJobSurface {
  type: "scheduled-job";
  slug: string;
  cron: string;             // 6-field cron (sec optional). Validated.
  worker_url: string;
  required_capabilities: string[];
  timezone?: string;        // IANA tz; default "UTC"
}

export interface McpToolSurface {
  type: "mcp-tool";
  tool_name: string;        // e.g. "calendly.list_upcoming_calls"
  description: string;
  worker_url: string;
  input_schema: Record<string, unknown>;   // JSON Schema
  output_schema: Record<string, unknown>;  // JSON Schema
  required_capabilities: string[];
  is_mutating: boolean;     // mutating tools require consent_token
}

export interface ServerActionSurface {
  type: "server-action";
  slug: string;             // for invocation from iframe surfaces
  worker_url: string;
  required_capabilities: string[];
  is_mutating: boolean;
}

export interface MonetizationDecl {
  model: "free" | "one_time" | "subscription";
  /** Decimal(14,2) string, no float. Currency on row. */
  price?: string;          // e.g. "29.00"
  currency?: string;       // ISO 4217, e.g. "USD"
  /** Subscription only. */
  interval?: "month" | "year";
  trial_days?: number;     // 0..30
  /** First $1k/mo developer revenue is dev-only when split is 70/30. */
  revenue_split_overrides?: never;  // managed by platform, not by manifest
}

export interface WebhookDecl {
  event: string;           // e.g. "program.created"
  required_capabilities: string[];
}

export interface ScheduledJobDecl {
  slug: string;
  cron: string;
  required_capabilities: string[];
}

export interface ManifestSignature {
  /** Always "ECDSA_P256_SHA256" Day-1. */
  algorithm: "ECDSA_P256_SHA256";

  /** Key fingerprint (SHA-256 of public key DER). */
  key_fingerprint: string;

  /** Base64 detached signature over the canonicalized unsigned manifest. */
  signature: string;

  /** When signed. ISO 8601. */
  signed_at: string;

  /** Optional KMS key ARN if signed via AWS KMS. */
  kms_key_arn?: string;
}
```

## 3. JSON Schema (informative)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://tgp.example/schemas/app-manifest/1.0.json",
  "type": "object",
  "required": [
    "manifest_version", "app_id", "version", "name", "tagline",
    "description", "developer", "categories", "icon_url",
    "screenshot_urls", "homepage_url", "support_email",
    "privacy_policy_url", "terms_url",
    "capabilities", "surfaces", "monetization"
  ],
  "additionalProperties": false,
  "properties": {
    "manifest_version": { "const": "1.0" },
    "app_id": { "type": "string", "pattern": "^[a-z0-9-]{3,64}$" },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 64 },
    "tagline": { "type": "string", "minLength": 1, "maxLength": 280 },
    "description": { "type": "string", "minLength": 1, "maxLength": 8192 },
    "developer": { "$ref": "#/$defs/Developer" },
    "categories": {
      "type": "array", "minItems": 1, "maxItems": 3,
      "items": {
        "enum": ["programs", "integrations", "ai-tools", "storefront",
                 "analytics", "communication", "billing", "automation", "content"]
      }
    },
    "icon_url": { "type": "string", "format": "uri" },
    "screenshot_urls": {
      "type": "array", "minItems": 1, "maxItems": 8,
      "items": { "type": "string", "format": "uri" }
    },
    "homepage_url": { "type": "string", "format": "uri" },
    "support_email": { "type": "string", "format": "email" },
    "privacy_policy_url": { "type": "string", "format": "uri" },
    "terms_url": { "type": "string", "format": "uri" },
    "capabilities": { "type": "array", "items": { "$ref": "#/$defs/Capability" }, "maxItems": 64 },
    "surfaces": { "type": "array", "items": { "$ref": "#/$defs/Surface" }, "minItems": 1, "maxItems": 32 },
    "monetization": { "$ref": "#/$defs/Monetization" },
    "egress": {
      "type": "object",
      "required": ["allow"],
      "properties": {
        "allow": { "type": "array", "items": { "type": "string", "format": "hostname" }, "maxItems": 32 }
      }
    },
    "webhooks": { "type": "array", "items": { "$ref": "#/$defs/Webhook" } },
    "scheduled_jobs": { "type": "array", "items": { "$ref": "#/$defs/ScheduledJob" } },
    "lifecycle": { "$ref": "#/$defs/Lifecycle" },
    "auto_upgrade": { "enum": ["patch", "minor", "manual"] },
    "requires": { "$ref": "#/$defs/Requires" },
    "i18n": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "maxLength": 64 },
          "tagline": { "type": "string", "maxLength": 280 },
          "description": { "type": "string", "maxLength": 8192 }
        }
      }
    },
    "signature": { "$ref": "#/$defs/Signature" }
  },
  "$defs": {
    "Developer": {
      "type": "object",
      "required": ["developer_id", "display_name", "contact_email", "verified"],
      "properties": {
        "developer_id": { "type": "string" },
        "display_name": { "type": "string", "maxLength": 64 },
        "legal_name": { "type": "string", "maxLength": 128 },
        "contact_email": { "type": "string", "format": "email" },
        "stripe_connect_account_id": { "type": "string", "pattern": "^acct_[A-Za-z0-9]+$" },
        "verified": { "type": "boolean" }
      }
    },
    "Capability": {
      "type": "object",
      "required": ["capability", "reason", "required"],
      "properties": {
        "capability": { "type": "string", "pattern": "^(read|write|delete|webhook|mcp):[a-z0-9_.]+$" },
        "reason": { "type": "string", "minLength": 8, "maxLength": 280 },
        "required": { "type": "boolean" },
        "pii": { "type": "boolean" }
      }
    },
    "Surface": {
      "oneOf": [
        { "$ref": "#/$defs/AdminPage" },
        { "$ref": "#/$defs/StorefrontBlock" },
        { "$ref": "#/$defs/DashboardWidget" },
        { "$ref": "#/$defs/WebhookHandler" },
        { "$ref": "#/$defs/ScheduledJobSurface" },
        { "$ref": "#/$defs/McpTool" },
        { "$ref": "#/$defs/ServerAction" }
      ]
    },
    "AdminPage": {
      "type": "object",
      "required": ["type", "slug", "title", "iframe_url", "required_capabilities", "nav"],
      "properties": {
        "type": { "const": "admin-page" },
        "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "title": { "type": "string", "maxLength": 64 },
        "iframe_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array", "items": { "type": "string" } },
        "nav": {
          "type": "object",
          "required": ["section", "order"],
          "properties": {
            "section": { "enum": ["automations", "integrations", "tools", "reports"] },
            "order": { "type": "integer", "minimum": 0, "maximum": 9999 }
          }
        }
      }
    },
    "StorefrontBlock": {
      "type": "object",
      "required": ["type", "slug", "iframe_url", "required_capabilities", "placement"],
      "properties": {
        "type": { "const": "storefront-block" },
        "slug": { "type": "string" },
        "iframe_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array" },
        "placement": { "enum": ["hero", "row", "footer"] }
      }
    },
    "DashboardWidget": {
      "type": "object",
      "required": ["type", "slug", "title", "iframe_url", "required_capabilities", "size"],
      "properties": {
        "type": { "const": "dashboard-widget" },
        "slug": { "type": "string" },
        "title": { "type": "string" },
        "iframe_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array" },
        "size": { "enum": ["1x1", "2x1", "2x2", "3x2"] }
      }
    },
    "WebhookHandler": {
      "type": "object",
      "required": ["type", "events", "worker_url", "required_capabilities"],
      "properties": {
        "type": { "const": "webhook-handler" },
        "events": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
        "worker_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array" }
      }
    },
    "ScheduledJobSurface": {
      "type": "object",
      "required": ["type", "slug", "cron", "worker_url", "required_capabilities"],
      "properties": {
        "type": { "const": "scheduled-job" },
        "slug": { "type": "string" },
        "cron": { "type": "string" },
        "worker_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array" },
        "timezone": { "type": "string" }
      }
    },
    "McpTool": {
      "type": "object",
      "required": ["type", "tool_name", "description", "worker_url",
                   "input_schema", "output_schema", "required_capabilities", "is_mutating"],
      "properties": {
        "type": { "const": "mcp-tool" },
        "tool_name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$" },
        "description": { "type": "string", "maxLength": 1024 },
        "worker_url": { "type": "string", "format": "uri" },
        "input_schema": { "type": "object" },
        "output_schema": { "type": "object" },
        "required_capabilities": { "type": "array" },
        "is_mutating": { "type": "boolean" }
      }
    },
    "ServerAction": {
      "type": "object",
      "required": ["type", "slug", "worker_url", "required_capabilities", "is_mutating"],
      "properties": {
        "type": { "const": "server-action" },
        "slug": { "type": "string" },
        "worker_url": { "type": "string", "format": "uri" },
        "required_capabilities": { "type": "array" },
        "is_mutating": { "type": "boolean" }
      }
    },
    "Monetization": {
      "type": "object",
      "required": ["model"],
      "properties": {
        "model": { "enum": ["free", "one_time", "subscription"] },
        "price": { "type": "string", "pattern": "^\\d{1,12}\\.\\d{2}$" },
        "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
        "interval": { "enum": ["month", "year"] },
        "trial_days": { "type": "integer", "minimum": 0, "maximum": 30 }
      },
      "allOf": [
        {
          "if": { "properties": { "model": { "enum": ["one_time", "subscription"] } } },
          "then": { "required": ["price", "currency"] }
        },
        {
          "if": { "properties": { "model": { "const": "subscription" } } },
          "then": { "required": ["interval"] }
        }
      ]
    },
    "Webhook": {
      "type": "object",
      "required": ["event", "required_capabilities"],
      "properties": {
        "event": { "type": "string" },
        "required_capabilities": { "type": "array" }
      }
    },
    "ScheduledJob": {
      "type": "object",
      "required": ["slug", "cron", "required_capabilities"],
      "properties": {
        "slug": { "type": "string" },
        "cron": { "type": "string" },
        "required_capabilities": { "type": "array" }
      }
    },
    "Lifecycle": {
      "type": "object",
      "properties": {
        "on_install": { "type": "string", "format": "uri" },
        "on_uninstall": { "type": "string", "format": "uri" },
        "on_upgrade": { "type": "string", "format": "uri" },
        "on_suspend": { "type": "string", "format": "uri" },
        "on_resume": { "type": "string", "format": "uri" }
      }
    },
    "Requires": {
      "type": "object",
      "properties": {
        "platform_min_version": { "type": "string" },
        "features": { "type": "array", "items": { "type": "string" } }
      }
    },
    "Signature": {
      "type": "object",
      "required": ["algorithm", "key_fingerprint", "signature", "signed_at"],
      "properties": {
        "algorithm": { "const": "ECDSA_P256_SHA256" },
        "key_fingerprint": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "signature": { "type": "string" },
        "signed_at": { "type": "string", "format": "date-time" },
        "kms_key_arn": { "type": "string" }
      }
    }
  }
}
```

## 4. Capability vocabulary (Day-1)

| Capability | Reads/writes | Notes |
|---|---|---|
| `read:clients` | client list/detail (no PII subscope) | redacts PII unless subscope present |
| `read:client.email` | client email | PII |
| `read:client.phone` | client phone | PII |
| `read:client.dob` | client DOB | PII |
| `read:client.address` | client address | PII |
| `read:client.payment_method` | Stripe customer ID only | NEVER raw PAN |
| `read:client.health_metrics` | body composition, mood, etc | PII (health) |
| `write:clients` | update client metadata | mutating |
| `delete:clients` | delete client | high-trust |
| `read:programs` | program list/detail | |
| `write:programs` | create/update programs | mutating |
| `delete:programs` | delete programs | high-trust |
| `read:cohorts` | cohort list/detail | |
| `write:cohorts` | create/update cohorts | mutating |
| `read:retention.progression` | progression scores | sensitive (Wave 2) |
| `read:retention.streaks` | per-client streak data | sensitive; subject to Wave 10 doctrine |
| `read:retention.milestones` | retention milestones | |
| `read:rewards` | rewards/badges | |
| `write:rewards` | grant/revoke rewards | mutating |
| `read:sub_coaches` | sub-coach list | |
| `write:sub_coaches` | invite/update sub-coaches | mutating |
| `read:audit` | this app's own audit log only | |
| `read:payments` | payment history (no card data) | |
| `read:messages` | DMs / coach-client messages | high-trust |
| `write:messages` | send messages on behalf | high-trust + consent |
| `read:admin.metrics` | cohort/coach metrics (Wave 3 data-feed) | scope-stack-aware |
| `webhook:program.created` | receive program.created event | |
| `webhook:program.updated` | | |
| `webhook:program.deleted` | | |
| `webhook:client.created` | | |
| `webhook:client.checked_in` | | |
| `webhook:client.churned` | | |
| `webhook:cohort.created` | | |
| `webhook:retention.milestone_hit` | | |
| `webhook:rewards.granted` | | |
| `webhook:install.lifecycle` | install/uninstall/upgrade for own app | |
| `mcp:cohort_metrics` | MCP tool: cohort metrics | read-only |
| `mcp:coach_directory` | MCP tool: coach directory | read-only |
| `mcp:client_progression` | MCP tool: progression for a client | read-only, scoped |
| `mcp:program.create` | MCP tool: create a program | mutating, requires consent |
| `mcp:rewards.grant` | MCP tool: grant a reward | mutating, requires consent |
| `mcp:messages.send` | MCP tool: send message | high-trust, requires consent |

This vocab is versioned. Adding a capability is a minor platform version bump. Removing one is a major bump and requires deprecation runway >= 90 days.

## 5. Capability declaration rules

- Each `CapabilityDecl.reason` is shown to the coach at install consent. Reasons must be human-readable, specific, and explain why the app needs the capability. Boilerplate ("for normal operation") is rejected at review.
- `required: false` capabilities are optional grants. The coach can install without granting them; the app must degrade gracefully.
- PII-touching capabilities (`pii: true`) are surfaced with red highlight in the consent UI.
- `delete:*` and `write:messages` are flagged as "high-trust" and shown with extra friction.
- Apps cannot self-elevate. Adding a capability in a new version triggers a re-consent flow.

## 6. Signing model — OWNER_DECISION (recommended: AWS KMS)

### 6.1 Options

#### Option A — AWS KMS (RECOMMENDED)

Each developer has one or more KMS keys (asymmetric, ECC_NIST_P256, SIGN_VERIFY usage). KMS holds the private key; nobody (including TGP) sees it. Signing is via `kms:Sign` API. Public key is fetched once and cached at TGP verifier.

Pros: hardware-backed custody, audit log of every sign call, key rotation built-in, IAM-scoped.
Cons: per-sign cost (negligible at app-publish frequency), AWS lock-in.

#### Option B — HashiCorp Vault

Self-hosted; same asymmetric primitives. Full key custody.

Pros: cloud-agnostic, full control.
Cons: we run another service. We don't run Vault today.

#### Option C — In-process keypair

Developer holds private key on their laptop / CI. Signs via local crypto.

Pros: free, simple for small devs.
Cons: key custody is on the developer. Easy to leak. Hard to audit. Hard to revoke.

### 6.2 Recommendation: AWS KMS

Day-1 we provision one KMS key per developer at onboarding. Key alias: `alias/app-signer/<developer_id>`. Signing endpoint exposed via dev portal: `POST /api/dev-portal/sign-manifest` with the unsigned manifest body, returns the signed manifest. Behind the endpoint, TGP backend assumes a per-developer IAM role and calls `kms:Sign`. Public key fingerprint cached at TGP API verifier with 5-min TTL.

### 6.3 Canonicalization

Signing operates on the **canonical** unsigned manifest. Canonical form:

1. Strip `signature` field if present.
2. Sort all object keys lexicographically (recursive).
3. Encode arrays in declared order (do not reorder arrays).
4. UTF-8 encode without BOM.
5. No insignificant whitespace (one canonical form).
6. Numbers: integers without trailing decimal; decimals (only `monetization.price`) as exact strings.

The library used is RFC 8785 JSON Canonicalization Scheme (JCS). The signature covers `SHA-256(JCS(unsigned_manifest))`.

### 6.4 Verification

At install time and at every iframe/worker bootstrap:

1. Fetch app public key by `signature.key_fingerprint` from KMS verifier cache.
2. Recompute canonical hash from the manifest with `signature` stripped.
3. Verify `signature.signature` against the hash.
4. Reject if `signature.signed_at` is more than 365 days old.
5. Reject if `signature.algorithm` != `"ECDSA_P256_SHA256"`.
6. Reject if `signature.key_fingerprint` is on the revocation list.

### 6.5 Key rotation

Developer can rotate via dev portal. Old fingerprint moves to `superseded` for 30 days (so installs of pre-rotation versions still verify). After 30 days, old fingerprint is revoked and any installs whose pinned version was signed only with the old key transition to `auto_suspended` if a re-signing has not happened.

### 6.6 Revocation list

KMS revocation + TGP revocation list (Redis). Verifiers consult both. Revocation can be triggered by:

- Developer (rotated, suspect compromise).
- TGP staff (key compromised, dev banned).
- Automation (anomaly detection).

Revocation is fast: revocation-list update propagates to verifiers within 60 seconds.

## 7. Version pinning

- Every install pins to a specific manifest version. The pin is `app_id@version` and recorded on the install row.
- Upgrade transitions are explicit and audited.
- A version is **immutable** after publish. We do not support republishing the same version with different content.
- Major version bumps that add capabilities trigger re-consent. Minor and patch bumps that do not change the capability set apply per the install's `auto_upgrade` setting.
- A version may be marked `deprecated`. Existing installs continue; new installs are blocked. Default deprecation runway: 90 days before forced upgrade.

## 8. Worked examples

### 8.1 Example 1 — Free integration: Calendly sync

```json
{
  "manifest_version": "1.0",
  "app_id": "calendly-sync",
  "version": "1.2.0",
  "name": "Calendly Sync",
  "tagline": "Pull upcoming Calendly bookings into TGP and surface them in client cards.",
  "description": "Calendly Sync polls your Calendly account for upcoming bookings and writes them to TGP as scheduled sessions. It surfaces a 'next call' badge on each client card and a daily digest widget on your admin dashboard.",
  "developer": {
    "developer_id": "dev_acmeintegrations",
    "display_name": "Acme Integrations",
    "legal_name": "Acme Integrations Ltd.",
    "contact_email": "support@acme-integrations.example",
    "verified": true
  },
  "categories": ["integrations", "automation"],
  "icon_url": "https://app-cdn.tgp.example/calendly-sync/1.2.0/icon.png",
  "screenshot_urls": [
    "https://app-cdn.tgp.example/calendly-sync/1.2.0/shot1.png",
    "https://app-cdn.tgp.example/calendly-sync/1.2.0/shot2.png"
  ],
  "homepage_url": "https://acme-integrations.example/calendly-sync",
  "support_email": "support@acme-integrations.example",
  "privacy_policy_url": "https://acme-integrations.example/privacy",
  "terms_url": "https://acme-integrations.example/terms",
  "capabilities": [
    {
      "capability": "read:clients",
      "reason": "Match Calendly invitees to TGP clients by email.",
      "required": true,
      "pii": false
    },
    {
      "capability": "read:client.email",
      "reason": "Required to match Calendly invitees by email address.",
      "required": true,
      "pii": true
    },
    {
      "capability": "write:clients",
      "reason": "Write next-session metadata onto matched client records.",
      "required": true
    },
    {
      "capability": "webhook:client.created",
      "reason": "Refresh Calendly mapping when a new client is added.",
      "required": false
    }
  ],
  "surfaces": [
    {
      "type": "admin-page",
      "slug": "calendly-sync",
      "title": "Calendly Sync",
      "iframe_url": "https://app-cdn.tgp.example/calendly-sync/1.2.0/admin/index.html",
      "required_capabilities": ["read:clients", "write:clients"],
      "nav": { "section": "integrations", "order": 100 }
    },
    {
      "type": "dashboard-widget",
      "slug": "calendly-today",
      "title": "Today on Calendly",
      "iframe_url": "https://app-cdn.tgp.example/calendly-sync/1.2.0/widget/today.html",
      "required_capabilities": ["read:clients"],
      "size": "2x1"
    },
    {
      "type": "scheduled-job",
      "slug": "poll-calendly",
      "cron": "*/15 * * * *",
      "worker_url": "https://worker.tgp.example/calendly-sync/poll",
      "required_capabilities": ["read:clients", "write:clients"]
    },
    {
      "type": "webhook-handler",
      "events": ["client.created"],
      "worker_url": "https://worker.tgp.example/calendly-sync/webhook",
      "required_capabilities": ["read:clients"]
    }
  ],
  "monetization": { "model": "free" },
  "egress": { "allow": ["api.calendly.com"] },
  "auto_upgrade": "patch",
  "lifecycle": {
    "on_install": "https://worker.tgp.example/calendly-sync/lifecycle/install",
    "on_uninstall": "https://worker.tgp.example/calendly-sync/lifecycle/uninstall"
  }
}
```

### 8.2 Example 2 — Subscription paid: AI Program Drafter

```json
{
  "manifest_version": "1.0",
  "app_id": "ai-program-drafter",
  "version": "0.9.1",
  "name": "AI Program Drafter",
  "tagline": "Draft 4-week training programs from a one-paragraph brief.",
  "description": "Generates a 4-week starter program from a coach-supplied brief. Coach reviews and edits before publishing to clients. Uses sonar-pro by default; capped at 50 drafts/month per install on the standard plan.",
  "developer": {
    "developer_id": "dev_lucidcoach",
    "display_name": "Lucid Coach Tools",
    "legal_name": "Lucid Coach Tools Inc.",
    "contact_email": "hello@lucidcoach.example",
    "stripe_connect_account_id": "acct_1234567890",
    "verified": true
  },
  "categories": ["ai-tools", "programs"],
  "icon_url": "https://app-cdn.tgp.example/ai-program-drafter/0.9.1/icon.png",
  "screenshot_urls": [
    "https://app-cdn.tgp.example/ai-program-drafter/0.9.1/shot1.png"
  ],
  "homepage_url": "https://lucidcoach.example/program-drafter",
  "support_email": "hello@lucidcoach.example",
  "privacy_policy_url": "https://lucidcoach.example/privacy",
  "terms_url": "https://lucidcoach.example/terms",
  "capabilities": [
    {
      "capability": "read:programs",
      "reason": "Read existing programs for context when drafting.",
      "required": true
    },
    {
      "capability": "write:programs",
      "reason": "Create draft programs (saved as draft, not published).",
      "required": true
    },
    {
      "capability": "mcp:program.create",
      "reason": "Allow coach's AI agent to draft programs via MCP.",
      "required": false
    }
  ],
  "surfaces": [
    {
      "type": "admin-page",
      "slug": "drafter",
      "title": "AI Program Drafter",
      "iframe_url": "https://app-cdn.tgp.example/ai-program-drafter/0.9.1/admin/index.html",
      "required_capabilities": ["read:programs", "write:programs"],
      "nav": { "section": "tools", "order": 50 }
    },
    {
      "type": "mcp-tool",
      "tool_name": "ai_program_drafter.draft",
      "description": "Draft a program from a brief. Returns a saved draft program ID.",
      "worker_url": "https://worker.tgp.example/ai-program-drafter/mcp/draft",
      "input_schema": {
        "type": "object",
        "required": ["brief"],
        "properties": {
          "brief": { "type": "string", "minLength": 10, "maxLength": 4000 },
          "weeks": { "type": "integer", "minimum": 1, "maximum": 12, "default": 4 }
        }
      },
      "output_schema": {
        "type": "object",
        "required": ["program_id", "weeks_count"],
        "properties": {
          "program_id": { "type": "string" },
          "weeks_count": { "type": "integer" }
        }
      },
      "required_capabilities": ["write:programs", "mcp:program.create"],
      "is_mutating": true
    }
  ],
  "monetization": {
    "model": "subscription",
    "price": "29.00",
    "currency": "USD",
    "interval": "month",
    "trial_days": 14
  },
  "egress": { "allow": ["api.perplexity.ai"] },
  "auto_upgrade": "minor"
}
```

### 8.3 Example 3 — One-time paid: Storefront Hero Block "Founder Story"

```json
{
  "manifest_version": "1.0",
  "app_id": "founder-story-hero",
  "version": "1.0.0",
  "name": "Founder Story Hero",
  "tagline": "A configurable hero block for your storefront with a video and CTA.",
  "description": "A polished hero block coaches drop into their storefront homepage. Configurable video URL, headline, subhead, two CTAs. Mobile-optimized. No third-party tracking.",
  "developer": {
    "developer_id": "dev_blockwright",
    "display_name": "Blockwright",
    "contact_email": "hi@blockwright.example",
    "stripe_connect_account_id": "acct_BWxxxxxxxxxx",
    "verified": false
  },
  "categories": ["storefront", "content"],
  "icon_url": "https://app-cdn.tgp.example/founder-story-hero/1.0.0/icon.png",
  "screenshot_urls": [
    "https://app-cdn.tgp.example/founder-story-hero/1.0.0/shot1.png",
    "https://app-cdn.tgp.example/founder-story-hero/1.0.0/shot2.png",
    "https://app-cdn.tgp.example/founder-story-hero/1.0.0/shot3.png"
  ],
  "homepage_url": "https://blockwright.example/founder-story-hero",
  "support_email": "hi@blockwright.example",
  "privacy_policy_url": "https://blockwright.example/privacy",
  "terms_url": "https://blockwright.example/terms",
  "capabilities": [
    {
      "capability": "read:audit",
      "reason": "Self-diagnostic logs for the block.",
      "required": false
    }
  ],
  "surfaces": [
    {
      "type": "storefront-block",
      "slug": "hero",
      "iframe_url": "https://app-cdn.tgp.example/founder-story-hero/1.0.0/storefront/hero.html",
      "required_capabilities": [],
      "placement": "hero"
    }
  ],
  "monetization": {
    "model": "one_time",
    "price": "49.00",
    "currency": "USD"
  },
  "auto_upgrade": "patch"
}
```

## 9. Validation rules (manifest validator)

Validator is a pure function `validateManifest(json: unknown): { ok: true; manifest: AppManifest } | { ok: false; errors: ValidationError[] }`.

Errors enumerated:

| Code | Description |
|---|---|
| `schema_violation` | JSON Schema mismatch. |
| `unknown_capability` | Capability not in vocab. |
| `pii_capability_without_pii_flag` | PII capability declared without `pii: true`. |
| `surface_capability_not_declared` | Surface requires capability not in manifest's capability list. |
| `mcp_mutating_without_consent_flag` | MCP tool is_mutating=true but no consent capability. |
| `signature_invalid` | Cryptographic verification failed. |
| `signature_revoked` | Key fingerprint on revocation list. |
| `signature_expired` | signed_at older than 365 days. |
| `version_not_semver` | Version not MAJOR.MINOR.PATCH. |
| `monetization_paid_without_connect` | Paid app without `developer.stripe_connect_account_id`. |
| `cron_invalid` | Scheduled job cron expression invalid. |
| `egress_denied_host` | Egress allow includes blocklisted host (e.g. `localhost`, `*.tgp.example` other than allowed). |
| `category_invalid` | Category not in vocab. |
| `i18n_locale_invalid` | i18n key not BCP-47. |
| `iframe_url_not_app_cdn` | iframe_url not on `app-cdn.tgp.example`. |
| `worker_url_not_worker_domain` | worker_url not on `worker.tgp.example`. |
| `duplicate_surface_slug` | Two surfaces share a slug. |
| `description_unsafe_html` | Description contains script tags or unsafe HTML. |

Validator is run:
- At dev-portal upload.
- At review queue admission.
- At every install preflight.
- At every iframe/worker bootstrap (cached but re-checked daily).

## 10. Audit (manifest slice)

Every manifest publish, sign, and verify is audited.

```prisma
model AppManifestAudit {
  id              String   @id @default(cuid())
  app_id          String
  version         String
  developer_id    String
  action          String   // "publish" | "sign" | "verify_ok" | "verify_fail" | "revoke" | "rotate_key"
  outcome         String
  manifest_hash   String   // SHA-256 of canonicalized manifest
  key_fingerprint String?
  details         Json?
  created_at      DateTime @default(now())

  @@index([app_id, version])
  @@index([developer_id, created_at])
}
```

## 11. Performance budgets (manifest slice)

| Operation | p50 | p95 |
|---|---|---|
| Validate manifest | 5 ms | 20 ms |
| Sign manifest (KMS) | 80 ms | 300 ms |
| Verify signature (cache hit) | 1 ms | 5 ms |
| Verify signature (cache miss, KMS fetch) | 60 ms | 250 ms |
| Canonicalize | 2 ms | 10 ms |

## 12. Test plan (manifest slice)

- **Unit**: validator across each error code; canonicalization stability across object key reorderings; signature round-trip with KMS mock; schema regression suite (3 worked examples must validate).
- **Integration**: dev-portal upload -> validator -> sign -> store -> install preflight -> verify; key rotation -> old version still verifies for 30 days; revocation -> verify fails.
- **E2E**: developer signs a manifest with KMS, coach installs, install records the manifest_hash, install boots iframe and verifies signature client-side stub.
- **Load**: validate 1k manifests/sec on a single worker.

## 13. Rollback (manifest slice)

If KMS is unreachable, signing is unavailable but verification continues from the verifier cache. Cache TTL 5min; staleness up to 5min. New publishes block until KMS recovers.

## 14. Migration / backfill

No backfill (no existing manifests). Day-1 starts with zero apps.

## 15. Senior-engineer onboarding (manifest slice)

- [ ] Can write a valid manifest by hand without copying an example.
- [ ] Knows why we use detached signatures over canonical JSON, not signed JWTs.
- [ ] Knows the 5-min verifier-cache TTL and why it matters for the rotation grace window.
- [ ] Knows that adding a capability is a manifest version bump, not a manifest patch.
- [ ] Can articulate the 18 validator error codes from memory after 1 read.
