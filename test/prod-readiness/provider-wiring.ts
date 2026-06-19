/**
 * prod-readiness/provider-wiring.ts
 *
 * Scans the source tree for external provider integrations and reports
 * whether each one is "wired" (an SDK is imported AND the env vars it
 * depends on are registered AND at least one of those env vars is set in
 * the supplied environment map).
 *
 * Provider list seeded from the operator integration inventory
 * (wearables, mail, payments, media, model-vendors, storage,
 * observability, push, cache). This file IS that list, plus discovery
 * for anything else the
 * inventory omitted.
 *
 * For each provider, we record:
 *   - sdk_imported: at least one `import ... from '<package>'` exists
 *     (or a file-path hint resolves), confirming the provider is used.
 *   - env_vars_present: the env vars from `requires` that are set + non
 *     placeholder in the supplied environment map (i.e. wired).
 *   - status: WIRED | STUB | NOT_USED
 *
 * status semantics:
 *   - WIRED:    SDK imported AND all required vars set AND none look
 *               like placeholders.
 *   - STUB:     SDK imported BUT at least one required var missing or
 *               placeholder. Ship-blocker when targeting prod.
 *   - NOT_USED: SDK not imported anywhere — provider is dormant. OK.
 *
 * Testability boundary: the CORE classification logic
 * (`classifyProvider`) reads only the injected `env` map and never
 * touches `process.env` or the filesystem. The only place the real
 * process environment / working directory is consulted is the thin
 * `scanProvidersFromProcess` edge wrapper, so unit tests drive every
 * branch with an explicit env map and explicit import set.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ProviderStatus = 'WIRED' | 'STUB' | 'NOT_USED';

/** Minimal injectable environment shape — a plain string→string map. */
export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface ProviderDef {
  /** Stable identifier, e.g. "stripe", "supabase", "aws-s3". */
  id: string;
  /** Human-readable label for reports. */
  label: string;
  /** Match-any: provider is considered used if ANY of these packages is imported. */
  packages: string[];
  /** Env vars the SDK ALWAYS requires (every var here must be set + non-placeholder). */
  requires: string[];
  /**
   * Credential alternatives: an array of mutually-exclusive var groups where
   * AT LEAST ONE group must be fully satisfied. Used for providers that accept
   * more than one auth mode — e.g. AWS S3 is wired with either static access
   * keys (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) OR a web-identity token
   * file (AWS_WEB_IDENTITY_TOKEN_FILE, the IAM-role / IRSA path). The provider
   * is STUB only when NO group is fully satisfied.
   */
  requiresAnyOf?: string[][];
  /** Optional fallback domains (paths) to also confirm provider wiring. */
  filePathHints?: string[];
}

export const PROVIDERS: ProviderDef[] = [
  // ----- Auth / identity -----
  { id: 'supabase', label: 'Supabase (auth + DB)', packages: ['@supabase/supabase-js'], requires: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
  // ----- Payments -----
  { id: 'stripe', label: 'Stripe', packages: ['stripe'], filePathHints: ['src/billing', 'src/stripe', 'src/checkout'], requires: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  // ----- Model vendors -----
  { id: 'openai', label: 'OpenAI', packages: ['openai'], requires: ['OPENAI_API_KEY'] },
  // ----- Email -----
  { id: 'sendgrid', label: 'SendGrid (email)', packages: ['@sendgrid/mail'], filePathHints: ['src/email'], requires: ['SENDGRID_API_KEY'] },
  // ----- SMS / voice -----
  { id: 'twilio', label: 'Twilio (SMS)', packages: ['twilio'], filePathHints: ['src/sms'], requires: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'] },
  // ----- Edge / CDN -----
  { id: 'cloudflare', label: 'Cloudflare', packages: ['cloudflare'], filePathHints: ['src/cdn', 'src/cloudflare'], requires: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] },
  // ----- Media / video -----
  { id: 'mux', label: 'Mux (video)', packages: ['@mux/mux-node'], filePathHints: ['src/video', 'src/coach-media'], requires: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'] },
  // ----- Storage / files -----
  {
    id: 'aws-s3',
    label: 'AWS S3',
    packages: ['@aws-sdk/client-s3'],
    // AWS_REGION is always needed; credentials may arrive via static keys OR an
    // IAM web-identity token file (IRSA / OIDC), so those are an either/or group.
    requires: ['AWS_REGION'],
    requiresAnyOf: [
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      ['AWS_WEB_IDENTITY_TOKEN_FILE'],
    ],
  },
  // ----- Hosting / platform -----
  { id: 'fly', label: 'Fly.io', packages: [], filePathHints: ['src/platform', 'fly.toml'], requires: ['FLY_API_TOKEN'] },
  // ----- Observability -----
  { id: 'sentry', label: 'Sentry', packages: ['@sentry/node'], requires: ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN'] },
];

export interface ProviderReport {
  id: string;
  label: string;
  packages: string[];
  required_vars: string[];
  sdk_imported: boolean;
  env_vars_present: string[];
  env_vars_missing: string[];
  env_vars_placeholder: string[];
  status: ProviderStatus;
}

interface VarGroupClassification {
  present: string[];
  missing: string[];
  placeholder: string[];
}

/**
 * Classify a single env var group against the injected map. Pure: reads only
 * the supplied `env`, never `process.env`.
 */
function classifyVars(vars: string[], env: EnvMap): VarGroupClassification {
  const g: VarGroupClassification = { present: [], missing: [], placeholder: [] };
  for (const v of vars) {
    const raw = env[v];
    if (raw === undefined || raw === '') g.missing.push(v);
    else if (looksLikePlaceholder(raw)) g.placeholder.push(v);
    else g.present.push(v);
  }
  return g;
}

/**
 * CORE classification logic for one provider. Pure and fully injectable: the
 * caller supplies whether the SDK was detected as imported (`sdkImported`) and
 * the environment map (`env`). No `process.env`, no filesystem access — every
 * status branch is reachable from a unit test with explicit inputs.
 */
export function classifyProvider(def: ProviderDef, sdkImported: boolean, env: EnvMap): ProviderReport {
  const present: string[] = [];
  const missing: string[] = [];
  const placeholder: string[] = [];

  const always = classifyVars(def.requires, env);
  present.push(...always.present);
  missing.push(...always.missing);
  placeholder.push(...always.placeholder);
  const alwaysSatisfied = always.missing.length === 0 && always.placeholder.length === 0;

  // Either/or credential groups: satisfied when ANY group is fully set with
  // non-placeholder values. We report the BEST (most-satisfied) group's gaps so
  // the operator sees the shortest path to wiring it.
  let anyOfSatisfied = true;
  if (def.requiresAnyOf && def.requiresAnyOf.length > 0) {
    const classified = def.requiresAnyOf.map((group) => classifyVars(group, env));
    anyOfSatisfied = classified.some((g) => g.missing.length === 0 && g.placeholder.length === 0);
    if (anyOfSatisfied) {
      // Record the satisfied group's present vars for transparency.
      const sat = classified.find((g) => g.missing.length === 0 && g.placeholder.length === 0);
      if (sat) present.push(...sat.present);
    } else {
      // Surface the group with the fewest gaps as the actionable one.
      const best = classified.reduce((a, b) =>
        b.missing.length + b.placeholder.length < a.missing.length + a.placeholder.length ? b : a,
      );
      present.push(...best.present);
      missing.push(...best.missing);
      placeholder.push(...best.placeholder);
    }
  }

  let status: ProviderStatus;
  if (!sdkImported) status = 'NOT_USED';
  else if (alwaysSatisfied && anyOfSatisfied) status = 'WIRED';
  else status = 'STUB';

  return {
    id: def.id,
    label: def.label,
    packages: def.packages,
    required_vars: def.requires,
    sdk_imported: sdkImported,
    env_vars_present: present,
    env_vars_missing: missing,
    env_vars_placeholder: placeholder,
    status,
  };
}

/**
 * Determine, from a detected-imports set and a path-presence set, whether a
 * provider's SDK is considered imported. Pure helper (no fs/process access).
 */
export function isSdkImported(def: ProviderDef, importedPackages: ReadonlySet<string>, pathPresence: ReadonlySet<string>): boolean {
  return (
    def.packages.some((pkg) => importedPackages.has(pkg)) ||
    Boolean(def.filePathHints?.some((hint) => pathPresence.has(hint)))
  );
}

/**
 * Classify ALL providers against an injected import set + env map. This is the
 * fully-pure scan entry point used by tests — it performs no I/O.
 */
export function scanProvidersWith(
  importedPackages: ReadonlySet<string>,
  pathPresence: ReadonlySet<string>,
  env: EnvMap,
  providers: ProviderDef[] = PROVIDERS,
): ProviderReport[] {
  return providers.map((def) => classifyProvider(def, isSdkImported(def, importedPackages, pathPresence), env));
}

/**
 * Filter a list of provider definitions down to a single id (the `--provider`
 * filter). Returns an empty list when the id is unknown.
 */
export function filterProviders(providers: ProviderDef[], id: string): ProviderDef[] {
  return providers.filter((p) => p.id === id);
}

/**
 * Summary helper: production blockers are providers whose SDK is imported but
 * not fully wired (status STUB). Dormant (NOT_USED) providers never block.
 */
export function getProductionBlockers(reports: ProviderReport[]): ProviderReport[] {
  return reports.filter((r) => r.status === 'STUB');
}

/**
 * I/O EDGE: walk `<repoRoot>/src` once and collect the set of bare package
 * names that appear in `from '...'` import statements. Never reads env.
 */
export function collectImports(repoRoot: string): Set<string> {
  const root = path.join(repoRoot, 'src');
  const found = new Set<string>();
  if (!fs.existsSync(root)) return found;
  const importRe = /from\s+['"]([^'"]+)['"]/g;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const text = fs.readFileSync(p, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(text))) {
          const pkg = m[1];
          if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
            // Normalize scoped packages: @x/y or @x/y/sub → @x/y.
            const parts = pkg.split('/');
            const id = pkg.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
            found.add(id);
          }
        }
      }
    }
  };
  walk(root);
  return found;
}

/**
 * I/O EDGE: resolve which file-path hints exist under `<repoRoot>`. Never reads
 * env. A hint is present when the path exists directly, or any file under src/
 * has the hint as a path substring.
 */
export function collectPathPresence(repoRoot: string, providers: ProviderDef[]): Set<string> {
  const hints = new Set<string>();
  for (const p of providers) {
    for (const hint of p.filePathHints ?? []) {
      const direct = path.join(repoRoot, hint);
      if (fs.existsSync(direct)) {
        hints.add(hint);
        continue;
      }
      const root = path.join(repoRoot, 'src');
      if (!fs.existsSync(root)) continue;
      let found = false;
      const stack: string[] = [root];
      while (stack.length && !found) {
        const dir = stack.pop();
        if (dir === undefined) break;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (found) break;
          const pp = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            stack.push(pp);
          } else if (e.isFile() && pp.includes(hint)) {
            found = true;
          }
        }
      }
      if (found) hints.add(hint);
    }
  }
  return hints;
}

/**
 * I/O EDGE wrapper: the ONLY function that touches `process.env` /
 * `process.cwd()`. It performs the filesystem import discovery and then hands
 * off to the pure `scanProvidersWith` core. Tests must NOT call this; they call
 * the pure entry points with explicit inputs.
 */
export function scanProvidersFromProcess(
  repoRoot: string = process.cwd(),
  env: EnvMap = process.env,
  providers: ProviderDef[] = PROVIDERS,
): ProviderReport[] {
  const importedPackages = collectImports(repoRoot);
  const pathPresence = collectPathPresence(repoRoot, providers);
  return scanProvidersWith(importedPackages, pathPresence, env, providers);
}

/**
 * Substring sentinels that mark a value as a placeholder anywhere it appears.
 * Mirrors src/common/env-validation.ts placeholder vocabulary — intentionally
 * re-implemented here so the scanner runs even when the boot validator cannot
 * be imported (e.g. when the DB is unreachable).
 */
const PLACEHOLDER_SUBSTRINGS = [
  'changeme', 'change-me', 'your-key', 'your_key', 'yourkey',
  'placeholder', 'todo', 'tbd', 'xxx', 'fixme', 'fake', 'example',
  'insert_key_here', 'sk_test_replace', 'whsec_replace', 'redacted',
] as const;

/**
 * Prefix sentinels: a value is a placeholder when it STARTS WITH one of these.
 * `sk_test_` is Stripe test mode — a real production Stripe secret is
 * `sk_live_`, so any `sk_test_*` value in a prod environment is a stub that
 * must never ship. We anchor at the start (not substring) so a legitimate
 * value that merely contains the fragment elsewhere is not falsely flagged.
 */
const PLACEHOLDER_PREFIXES = ['sk_test_'] as const;

/**
 * Single source of truth for placeholder detection. Pure string predicate.
 */
export function looksLikePlaceholder(v: string): boolean {
  const trimmed = v.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
}
