/**
 * prod-readiness/provider-wiring.ts
 *
 * H4.B — scans the source tree for external provider integrations and
 * reports whether each one is "wired" (an SDK is imported AND the env
 * vars it depends on are registered AND at least one of those env vars
 * is set in the current process).
 *
 * Provider list seeded from Q7 (operator): "dozens via wearables, mail,
 * apple, sms, whisper, etc. — needs a list made." This file IS that
 * list, plus discovery for anything else the operator forgot to mention.
 *
 * For each provider, we record:
 *   - sdk_imported: at least one `import ... from '<package>'` exists
 *   - env_vars_present: the env vars from `requires` that are in
 *     process.env (i.e. wired in the running environment)
 *   - status: WIRED | STUB | NOT_USED
 *
 * status semantics:
 *   - WIRED:    SDK imported AND all required vars set AND none look
 *               like placeholders.
 *   - STUB:     SDK imported BUT at least one required var missing or
 *               placeholder. Ship-blocker when targeting prod.
 *   - NOT_USED: SDK not imported anywhere — provider is dormant. OK.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ProviderStatus = 'WIRED' | 'STUB' | 'NOT_USED';

export interface ProviderDef {
  /** Stable identifier, e.g. "stripe", "google-oauth", "apple-signin". */
  id: string;
  /** Human-readable label for reports. */
  label: string;
  /** Match-any: provider is considered used if ANY of these packages is imported. */
  packages: string[];
  /** Env vars the SDK ALWAYS requires (every var here must be set + non-placeholder). */
  requires: string[];
  /**
   * Credential alternatives (F-B13): an array of mutually-exclusive var groups
   * where AT LEAST ONE group must be fully satisfied. Used for providers that
   * accept more than one auth mode — e.g. AWS S3 is wired with either static
   * access keys (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) OR a web-identity
   * token file (AWS_WEB_IDENTITY_TOKEN_FILE, the IAM-role / IRSA path). The
   * provider is STUB only when NO group is fully satisfied.
   */
  requiresAnyOf?: string[][];
  /** Optional fallback domains (paths) to also confirm provider wiring. */
  filePathHints?: string[];
}

const PROVIDERS: ProviderDef[] = [
  // ----- Auth / identity -----
  { id: 'supabase', label: 'Supabase (auth + DB)', packages: ['@supabase/supabase-js'], requires: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { id: 'apple-signin', label: 'Sign in with Apple', packages: [], filePathHints: ['src/auth', 'apple-auth'], requires: ['APPLE_AUDIENCES'] },
  { id: 'google-oauth', label: 'Google OAuth', packages: [], filePathHints: ['src/scheduling/google-oauth', 'src/auth'], requires: ['GOOGLE_CLIENT_ID'] },
  // ----- Payments -----
  { id: 'stripe', label: 'Stripe', packages: [], filePathHints: ['src/billing', 'src/stripe', 'src/checkout'], requires: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  // ----- AI -----
  { id: 'openai', label: 'OpenAI', packages: ['openai'], requires: ['OPENAI_API_KEY'] },
  { id: 'anthropic', label: 'Anthropic', packages: ['@anthropic-ai/sdk'], requires: ['ANTHROPIC_API_KEY'] },
  { id: 'perplexity', label: 'Perplexity', packages: ['@perplexity-ai/perplexity_ai'], filePathHints: ['src/perplexity'], requires: ['PERPLEXITY_API_KEY'] },
  // ----- Email -----
  { id: 'resend', label: 'Resend (email)', packages: [], filePathHints: ['src/email'], requires: ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'] },
  // ----- Media / video -----
  { id: 'mux', label: 'Mux (video)', packages: [], filePathHints: ['src/video', 'src/coach-media'], requires: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'] },
  // ----- Wearables -----
  { id: 'oura', label: 'Oura Ring', packages: [], filePathHints: ['src/wearables/connectors/oura'], requires: ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET'] },
  { id: 'whoop', label: 'WHOOP', packages: [], filePathHints: ['src/wearables/connectors/whoop'], requires: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'] },
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
  // ----- Document signing -----
  { id: 'dropbox-sign', label: 'Dropbox Sign (e-sign)', packages: ['@dropbox/sign'], requires: ['DROPBOX_SIGN_API_KEY'] },
  // ----- Observability -----
  { id: 'sentry', label: 'Sentry', packages: ['@sentry/node'], requires: ['SENTRY_DSN'] },
  { id: 'posthog', label: 'PostHog', packages: ['posthog-node'], requires: ['POSTHOG_KEY'] },
  // ----- Push -----
  { id: 'expo-push', label: 'Expo push notifications', packages: ['expo-server-sdk'], requires: ['EXPO_ACCESS_TOKEN'] },
  // ----- Cache / queue -----
  { id: 'redis', label: 'Redis (cache + throttle)', packages: ['ioredis'], requires: ['REDIS_URL'] },
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

export function scanProviders(repoRoot: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): ProviderReport[] {
  const importsByPackage = collectImports(repoRoot);
  const pathPresence = collectPathPresence(repoRoot, PROVIDERS);
  const reports: ProviderReport[] = [];
  for (const p of PROVIDERS) {
    const sdkImported =
      p.packages.some((pkg) => importsByPackage.has(pkg)) ||
      Boolean(p.filePathHints?.some((hint) => pathPresence.has(hint)));
    const present: string[] = [];
    const missing: string[] = [];
    const placeholder: string[] = [];
    // Classify each var in a group into present/missing/placeholder.
    const classify = (vars: string[]): { present: string[]; missing: string[]; placeholder: string[] } => {
      const g = { present: [] as string[], missing: [] as string[], placeholder: [] as string[] };
      for (const v of vars) {
        const raw = env[v];
        if (raw === undefined || raw === '') g.missing.push(v);
        else if (looksLikePlaceholder(raw)) g.placeholder.push(v);
        else g.present.push(v);
      }
      return g;
    };

    const always = classify(p.requires);
    present.push(...always.present);
    missing.push(...always.missing);
    placeholder.push(...always.placeholder);
    const alwaysSatisfied = always.missing.length === 0 && always.placeholder.length === 0;

    // Either/or credential groups (F-B13): satisfied when ANY group is fully
    // set with non-placeholder values. We report the BEST (most-satisfied)
    // group's gaps so the operator sees the shortest path to wiring it.
    let anyOfSatisfied = true;
    if (p.requiresAnyOf && p.requiresAnyOf.length > 0) {
      const classified = p.requiresAnyOf.map(classify);
      anyOfSatisfied = classified.some((g) => g.missing.length === 0 && g.placeholder.length === 0);
      if (!anyOfSatisfied) {
        // Surface the group with the fewest gaps as the actionable one.
        const best = classified.reduce((a, b) =>
          (b.missing.length + b.placeholder.length) < (a.missing.length + a.placeholder.length) ? b : a,
        );
        present.push(...best.present);
        missing.push(...best.missing);
        placeholder.push(...best.placeholder);
      } else {
        // Record the satisfied group's present vars for transparency.
        const sat = classified.find((g) => g.missing.length === 0 && g.placeholder.length === 0)!;
        present.push(...sat.present);
      }
    }

    let status: ProviderStatus;
    if (!sdkImported) {
      status = 'NOT_USED';
    } else if (alwaysSatisfied && anyOfSatisfied) {
      status = 'WIRED';
    } else {
      status = 'STUB';
    }
    reports.push({
      id: p.id,
      label: p.label,
      packages: p.packages,
      required_vars: p.requires,
      sdk_imported: sdkImported,
      env_vars_present: present,
      env_vars_missing: missing,
      env_vars_placeholder: placeholder,
      status,
    });
  }
  return reports;
}

function collectImports(repoRoot: string): Set<string> {
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
          // Only record bare package names (no relative paths).
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

function collectPathPresence(repoRoot: string, providers: ProviderDef[]): Set<string> {
  const hints = new Set<string>();
  for (const p of providers) {
    for (const hint of p.filePathHints ?? []) {
      // Path-based: directory exists, OR any file path under src/ contains the hint.
      const direct = path.join(repoRoot, hint);
      if (fs.existsSync(direct)) {
        hints.add(hint);
        continue;
      }
      // Substring fallback: walk src/ once and check filename inclusion.
      const root = path.join(repoRoot, 'src');
      if (!fs.existsSync(root)) continue;
      let found = false;
      const stack: string[] = [root];
      while (stack.length && !found) {
        const dir = stack.pop()!;
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
 * Substring sentinels that mark a value as a placeholder anywhere it appears.
 * Mirrors src/common/env-validation.ts placeholder vocabulary — intentionally
 * re-implemented here so the test runs even when the boot validator cannot be
 * imported (e.g. when the DB is unreachable).
 */
const PLACEHOLDER_SUBSTRINGS = [
  'changeme', 'change-me', 'your-key', 'your_key', 'yourkey',
  'placeholder', 'todo', 'tbd', 'xxx', 'fixme', 'fake', 'example',
  'insert_key_here', 'sk_test_replace', 'whsec_replace', 'redacted',
] as const;

/**
 * Prefix sentinels: a value is a placeholder when it STARTS WITH one of these.
 * `sk_test_` is Stripe test mode (F-A08) — a real production Stripe secret is
 * `sk_live_`, so any `sk_test_*` value in a prod environment is a stub that
 * must never ship. We anchor at the start (not substring) so a legitimate
 * value that merely contains the fragment elsewhere is not falsely flagged.
 */
const PLACEHOLDER_PREFIXES = ['sk_test_'] as const;

/**
 * Single source of truth for placeholder detection (F-A09 / F-B05). Exported
 * so the orchestrator spec imports it instead of maintaining a divergent
 * inline copy.
 */
export function looksLikePlaceholder(v: string): boolean {
  const trimmed = v.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return PLACEHOLDER_SUBSTRINGS.some((needle) => lower.includes(needle));
}
