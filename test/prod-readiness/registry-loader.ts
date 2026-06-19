/**
 * prod-readiness/registry-loader.ts
 *
 * Single source of truth for the prod-switches.yml schema + load+validate.
 * Required by AGENT_RULES R108 — every env-var-shaped switch in the
 * codebase must have a row in prod-switches.yml.
 *
 * Validation rules:
 *   - YAML parses cleanly.
 *   - Top-level shape is { switches: SwitchEntry[] }.
 *   - Each entry has all required fields with valid enum values.
 *   - No duplicate `name` entries.
 *
 * This module is deliberately tiny and free of external runtime deps
 * other than `js-yaml` so it can run as the very first stage of the
 * deploy-readiness test (other stages may import this).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type SwitchTier = 'hard' | 'prod' | 'feature' | 'optional';
export type ProdDefault = 'MUST_SET' | 'ON' | 'OFF' | 'STUB_ALLOWED';

/**
 * Closed set of owning teams (F-A10). `unowned` is the explicit, auditable
 * fallback — NOT a free-text escape hatch. A typo'd or invented owner now
 * fails validation instead of silently fragmenting the ownership map.
 */
export type Owner =
  | 'billing'
  | 'platform'
  | 'observability'
  | 'auth'
  | 'ai'
  | 'media'
  | 'email'
  | 'sms'
  | 'jobs'
  | 'wearables'
  | 'coach'
  | 'community'
  | 'contracts'
  | 'unowned';

/** Minimum meaningful description length (F-A11): a non-blank, informative line. */
export const MIN_DESCRIPTION_LENGTH = 8;

const TIERS: ReadonlySet<SwitchTier> = new Set(['hard', 'prod', 'feature', 'optional']);
const PROD_DEFAULTS: ReadonlySet<ProdDefault> = new Set(['MUST_SET', 'ON', 'OFF', 'STUB_ALLOWED']);
export const OWNERS: ReadonlySet<Owner> = new Set<Owner>([
  'billing', 'platform', 'observability', 'auth', 'ai', 'media', 'email',
  'sms', 'jobs', 'wearables', 'coach', 'community', 'contracts', 'unowned',
]);

/**
 * Name-prefix ownership heuristic (F-B17). Ordered: first matching prefix wins.
 * Mirrors scripts/show-unowned-switches.sh's intent. Returns 'unowned' when no
 * prefix matches so callers always get a valid Owner. Kept deliberately
 * conservative — better to leave a switch unowned than to mis-route it.
 */
const OWNER_PREFIX_RULES: ReadonlyArray<readonly [readonly string[], Owner]> = [
  [['FITBIT_', 'GARMIN_', 'OURA_', 'POLAR_', 'WAHOO_', 'WHOOP_', 'WITHINGS_', 'WEARABLES_', 'BLOODWORK_'], 'wearables'],
  [['CONTRACT_', 'HELLOSIGN_'], 'contracts'],
  [['AI_GATEWAY_', 'OPENAI_', 'DIAGNOSTIC_AI_', 'COACH_AI_'], 'ai'],
  [['FEATURE_COMMUNITY_', 'COMMUNITY_', 'VOICE_NOTE_', 'VOICE_SIGNED_', 'LEADERBOARD_'], 'community'],
  [['STRIPE_', 'CHECKOUT_', 'BILLING_', 'RECEIPT_', 'LEGACY_PDF_RECEIPT_', 'CRM_LEAD_'], 'billing'],
  [['JWT_', 'GOOGLE_OAUTH_', 'APPLE_', 'ANDROID_', 'IOS_', 'KMS_', 'BOOTSTRAP_', 'ADMIN_SERVICE_TOKEN', 'SUPABASE_'], 'auth'],
  [['LOG_', 'METRICS_', 'AUDIT_', 'POSTHOG_', 'GIT_SHA', 'RELEASE_VERSION'], 'observability'],
  [['COACH_', 'CLIENT_DAILY_', 'NUDGE_'], 'coach'],
  [['BOOKING_REMINDER', 'BOOKING_', 'WEEKLY_DIGEST_', 'DRIP_DISPATCHER_', 'PTM_RECOMPUTE_'], 'jobs'],
  [['PORT', 'NODE_ENV', 'REDIS_', 'CORS_', 'APP_URL', 'APP_STORE_URL', 'PLAY_STORE_URL', 'PUBLIC_', 'LANDING_', 'STOREFRONT_', 'RATELIMIT_', 'GDPR_', 'DATA_EXPORT_', 'PROFILE_ENABLED'], 'platform'],
];

export function inferOwner(name: string): Owner {
  for (const [prefixes, owner] of OWNER_PREFIX_RULES) {
    for (const p of prefixes) {
      if (name === p || name.startsWith(p)) return owner;
    }
  }
  return 'unowned';
}

/** Fraction of switches still owned by `unowned` (F-B17 ceiling input). */
export function unownedRatio(switches: readonly SwitchEntry[]): number {
  if (switches.length === 0) return 0;
  const n = switches.filter((s) => s.owner === 'unowned').length;
  return n / switches.length;
}

export interface SwitchEntry {
  name: string;
  tier: SwitchTier;
  prod_default: ProdDefault;
  auto_flip_on_in_prod: boolean;
  owner: Owner;
  description: string;
}

export interface RegistryLoadResult {
  switches: SwitchEntry[];
  byName: Map<string, SwitchEntry>;
  registryPath: string;
}

export class RegistryValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`prod-switches.yml validation failed:\n  - ${errors.join('\n  - ')}`);
    this.name = 'RegistryValidationError';
  }
}

export function defaultRegistryPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, 'prod-switches.yml');
}

export function loadRegistry(registryPath: string = defaultRegistryPath()): RegistryLoadResult {
  if (!fs.existsSync(registryPath)) {
    throw new RegistryValidationError([`Registry file does not exist at ${registryPath}`]);
  }
  const raw = fs.readFileSync(registryPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new RegistryValidationError([
      `YAML parse error: ${(err as Error).message}`,
    ]);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).switches)) {
    throw new RegistryValidationError([
      "Top-level shape must be { switches: SwitchEntry[] }",
    ]);
  }
  const rawSwitches = (parsed as { switches: unknown[] }).switches;
  const errors: string[] = [];
  const switches: SwitchEntry[] = [];
  const byName = new Map<string, SwitchEntry>();
  rawSwitches.forEach((raw, idx) => {
    const validated = validateEntry(raw, idx);
    if ('error' in validated) {
      errors.push(validated.error);
      return;
    }
    const entry = validated.entry;
    if (byName.has(entry.name)) {
      errors.push(`switches[${idx}] (${entry.name}): duplicate name; first defined earlier in the file.`);
      return;
    }
    byName.set(entry.name, entry);
    switches.push(entry);
  });
  if (errors.length) throw new RegistryValidationError(errors);
  return { switches, byName, registryPath };
}

function validateEntry(raw: unknown, idx: number): { entry: SwitchEntry } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `switches[${idx}]: must be an object` };
  }
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof r.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(r.name)) {
    issues.push('name must be SCREAMING_SNAKE_CASE');
  }
  if (typeof r.tier !== 'string' || !TIERS.has(r.tier as SwitchTier)) {
    issues.push(`tier must be one of ${[...TIERS].join('|')}`);
  }
  if (typeof r.prod_default !== 'string' || !PROD_DEFAULTS.has(r.prod_default as ProdDefault)) {
    issues.push(`prod_default must be one of ${[...PROD_DEFAULTS].join('|')}`);
  }
  if (typeof r.auto_flip_on_in_prod !== 'boolean') {
    issues.push('auto_flip_on_in_prod must be boolean');
  }
  if (typeof r.owner !== 'string' || !OWNERS.has(r.owner as Owner)) {
    issues.push(`owner must be one of ${[...OWNERS].join('|')}`);
  }
  if (typeof r.description !== 'string' || r.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    issues.push(`description must be a non-blank string of at least ${MIN_DESCRIPTION_LENGTH} characters`);
  }
  if (issues.length) {
    return { error: `switches[${idx}] (${typeof r.name === 'string' ? r.name : '<no-name>'}): ${issues.join('; ')}` };
  }
  return {
    entry: {
      name: r.name as string,
      tier: r.tier as SwitchTier,
      prod_default: r.prod_default as ProdDefault,
      auto_flip_on_in_prod: r.auto_flip_on_in_prod as boolean,
      owner: r.owner as Owner,
      description: r.description as string,
    },
  };
}
