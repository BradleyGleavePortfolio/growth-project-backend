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
import * as ts from 'typescript';

export type ProviderStatus = 'WIRED' | 'STUB' | 'NOT_USED';

/** Minimal injectable environment shape — a plain string→string map. */
export type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * Injectable EVIDENCE map: out-of-band facts the pure core cannot derive from
 * the env map alone (e.g. whether a credential FILE actually exists on disk).
 * Keys are `<ENV_VAR>_FILE_EXISTS` booleans, populated by the I/O edge wrapper
 * (`scanProvidersFromProcess`) via `fs.existsSync`. The core stays pure: it only
 * reads what the caller injects here and never touches the filesystem itself.
 */
export type EvidenceMap = Readonly<Record<string, boolean | undefined>>;

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
  /**
   * Optional human-readable explanation for a non-WIRED status that the
   * present/missing/placeholder buckets alone don't capture — e.g. a credential
   * file that is referenced but does not exist on disk. Absent when the buckets
   * fully explain the status.
   */
  diagnostic?: string;
}

/**
 * Provider-specific KEY-SHAPE validators. A value that is set and not a generic
 * placeholder can STILL be malformed for its slot — e.g. a Stripe publishable
 * key (`pk_live_…`) or restricted key (`rk_live_…`) pasted into the SECRET-key
 * slot, or a secret key truncated below any plausible length. These predicates
 * return `true` only when the value is a STRUCTURALLY VALID credential for that
 * exact env var. A var with a validator that returns `false` is treated like a
 * placeholder (→ STUB), so malformed/wrong-type keys can never report WIRED.
 *
 * Conservative bounds: real Stripe secret keys are ~99 chars, but enforcing
 * ≥24 chars after the `sk_(live|test)_` prefix catches the obvious truncated /
 * wrong-type cases without coupling to Stripe's exact (and historically
 * changing) length. Vars with no known shape fall back to the placeholder /
 * length checks already applied in `classifyVars`.
 */
export const KEY_SHAPE_VALIDATORS: Readonly<Record<string, (v: string) => boolean>> = {
  // Must be a SECRET key (sk_), live or test, with a long-enough body. This
  // rejects publishable (pk_) and restricted (rk_) keys outright — they are the
  // wrong type for this slot — as well as truncated secret keys.
  STRIPE_SECRET_KEY: (v) => /^sk_(live|test)_[A-Za-z0-9]{24,}$/.test(v),
  // Stripe webhook signing secret: `whsec_` + ≥20 chars of body.
  STRIPE_WEBHOOK_SECRET: (v) => /^whsec_[A-Za-z0-9]{20,}$/.test(v),
  // Supabase service-role key is a JWT: three base64url segments, dot-separated,
  // header starting `eyJ`.
  SUPABASE_SERVICE_ROLE_KEY: (v) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v),
  // OpenAI API key: `sk-` prefix + ≥20 chars of body (covers `sk-proj-…` too).
  OPENAI_API_KEY: (v) => /^sk-[A-Za-z0-9_-]{20,}$/.test(v),
};

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
    else if (looksLikePlaceholder(raw) || !passesShapeCheck(v, raw)) g.placeholder.push(v);
    else g.present.push(v);
  }
  return g;
}

/**
 * Returns `true` when `raw` is structurally valid for env var `name`. A var with
 * a registered `KEY_SHAPE_VALIDATORS` entry must satisfy its predicate; vars with
 * no known shape always pass here (length/placeholder is enforced elsewhere).
 * A failing shape causes `classifyVars` to bucket the var as a placeholder, so a
 * malformed or wrong-type key (e.g. `pk_live_…` in the secret slot) never wires.
 */
export function passesShapeCheck(name: string, raw: string): boolean {
  const validator = KEY_SHAPE_VALIDATORS[name];
  if (validator === undefined) return true;
  return validator(raw.trim());
}

/**
 * The env-var name suffix that marks a credential whose VALUE is a filesystem
 * path (e.g. `AWS_WEB_IDENTITY_TOKEN_FILE`). For each such var the edge wrapper
 * injects `<VAR>_FILE_EXISTS` into the evidence map.
 */
const FILE_VAR_SUFFIX = '_FILE';

/** Evidence key for a `*_FILE` var: `<VAR>_FILE_EXISTS`. */
function fileExistsEvidenceKey(fileVar: string): string {
  return `${fileVar}_EXISTS`;
}

/** The `*_FILE` vars within a credential group. */
function fileVarsOf(group: string[]): string[] {
  return group.filter((v) => v.endsWith(FILE_VAR_SUFFIX));
}

/**
 * Pure evidence gate for a credential group: returns `false` only when the group
 * references a `*_FILE` var whose injected `<VAR>_FILE_EXISTS` evidence is
 * explicitly `false`. Missing evidence (undefined) is treated as OK so the core
 * stays backward-compatible when no edge wrapper populated it (tests of pure
 * env-only wiring don't need to assert disk state).
 */
function fileEvidenceOk(group: string[], evidence: EvidenceMap): boolean {
  return fileVarsOf(group).every((v) => evidence[fileExistsEvidenceKey(v)] !== false);
}

/** Diagnostic for the first `*_FILE` var in a group whose file is missing. */
function fileEvidenceDiagnostic(group: string[], evidence: EvidenceMap): string | undefined {
  const missingFileVar = fileVarsOf(group).find((v) => evidence[fileExistsEvidenceKey(v)] === false);
  return missingFileVar === undefined ? undefined : `${missingFileVar} points to non-existent path`;
}

/**
 * CORE classification logic for one provider. Pure and fully injectable: the
 * caller supplies whether the SDK was detected as imported (`sdkImported`), the
 * environment map (`env`), and an optional out-of-band `evidence` map (e.g.
 * credential-file existence). No `process.env`, no filesystem access — every
 * status branch is reachable from a unit test with explicit inputs.
 */
export function classifyProvider(
  def: ProviderDef,
  sdkImported: boolean,
  env: EnvMap,
  evidence: EvidenceMap = {},
): ProviderReport {
  const present: string[] = [];
  const missing: string[] = [];
  const placeholder: string[] = [];
  let diagnostic: string | undefined;

  const always = classifyVars(def.requires, env);
  present.push(...always.present);
  missing.push(...always.missing);
  placeholder.push(...always.placeholder);
  const alwaysSatisfied = always.missing.length === 0 && always.placeholder.length === 0;

  // Either/or credential groups: satisfied when ANY group is fully set with
  // non-placeholder values AND any referenced credential FILE actually exists
  // (per injected evidence). We report the BEST (most-satisfied) group's gaps so
  // the operator sees the shortest path to wiring it.
  let anyOfSatisfied = true;
  if (def.requiresAnyOf && def.requiresAnyOf.length > 0) {
    const classified = def.requiresAnyOf.map((group) => ({
      group,
      result: classifyVars(group, env),
    }));
    const isSatisfied = (c: { group: string[]; result: VarGroupClassification }): boolean =>
      c.result.missing.length === 0 &&
      c.result.placeholder.length === 0 &&
      fileEvidenceOk(c.group, evidence);
    anyOfSatisfied = classified.some(isSatisfied);
    if (anyOfSatisfied) {
      // Record the satisfied group's present vars for transparency.
      const sat = classified.find(isSatisfied);
      if (sat) present.push(...sat.result.present);
    } else {
      // Surface the group with the fewest gaps as the actionable one.
      const best = classified.reduce((a, b) =>
        b.result.missing.length + b.result.placeholder.length <
        a.result.missing.length + a.result.placeholder.length
          ? b
          : a,
      );
      present.push(...best.result.present);
      missing.push(...best.result.missing);
      placeholder.push(...best.result.placeholder);
      // If the only thing wrong with the surfaced group is a missing FILE on
      // disk (vars set + non-placeholder but the file does not exist), explain
      // it: the env says wired but the referenced token file is unusable.
      if (
        best.result.missing.length === 0 &&
        best.result.placeholder.length === 0 &&
        !fileEvidenceOk(best.group, evidence)
      ) {
        diagnostic = fileEvidenceDiagnostic(best.group, evidence);
      }
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
    ...(diagnostic !== undefined ? { diagnostic } : {}),
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
 * Classify ALL providers against an injected import set + env map (+ optional
 * evidence map). This is the fully-pure scan entry point used by tests — it
 * performs no I/O; disk facts must arrive via the injected `evidence` map.
 */
export function scanProvidersWith(
  importedPackages: ReadonlySet<string>,
  pathPresence: ReadonlySet<string>,
  env: EnvMap,
  providers: ProviderDef[] = PROVIDERS,
  evidence: EvidenceMap = {},
): ProviderReport[] {
  return providers.map((def) =>
    classifyProvider(def, isSdkImported(def, importedPackages, pathPresence), env, evidence),
  );
}

/**
 * Build the file-existence EVIDENCE map for a set of providers from a real env
 * map: for every `*_FILE` var referenced by any provider's `requires` /
 * `requiresAnyOf` that is SET in `env`, probe the path with `fs.existsSync` and
 * record `<VAR>_FILE_EXISTS`. This is the ONLY place file existence is checked;
 * the result is injected into the pure core. Lives at the I/O edge.
 */
export function collectFileEvidence(env: EnvMap, providers: ProviderDef[] = PROVIDERS): EvidenceMap {
  const out: Record<string, boolean> = {};
  for (const p of providers) {
    const groups = [p.requires, ...(p.requiresAnyOf ?? [])];
    for (const fileVar of fileVarsOf(groups.flat())) {
      const value = env[fileVar];
      if (value !== undefined && value !== '') {
        out[fileExistsEvidenceKey(fileVar)] = fs.existsSync(value);
      }
    }
  }
  return out;
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
 * Normalize an import specifier to a bare package id, or return undefined when
 * it is a relative/absolute path (not a package). Scoped packages collapse to
 * `@scope/name` (dropping any deep sub-path).
 */
function normalizeSpecifier(spec: string): string | undefined {
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/')) return undefined;
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Extract every statically-known module specifier from one source file's AST.
 * Covers: `import … from 'pkg'` and side-effect `import 'pkg'`
 * (ImportDeclaration), `require('pkg')` (CallExpression to the `require`
 * identifier with a string-literal arg), and dynamic `import('pkg')`
 * (CallExpression whose expression is the `import` keyword). Computed/dynamic
 * specifiers (e.g. `import(variable)`, `require(`a` + b)`) are NOT statically
 * known and are skipped safely.
 */
export function extractModuleSpecifiers(sourceText: string, fileName = 'in-memory.ts'): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    // Static `import ... from 'pkg'` and side-effect `import 'pkg'`.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // `export ... from 'pkg'` re-exports also pull in the package.
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      // Only string-literal arguments are statically known specifiers.
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) specifiers.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

/**
 * I/O EDGE: walk `<repoRoot>/src` once and collect the set of bare package names
 * imported anywhere in the TypeScript sources. Uses the TypeScript AST (not a
 * regex) so it captures static `from` imports, side-effect imports,
 * `require(...)`, and dynamic `import(...)` while safely ignoring relative paths
 * and non-literal (computed) specifiers. Never reads env.
 */
export function collectImports(repoRoot: string): Set<string> {
  const root = path.join(repoRoot, 'src');
  const found = new Set<string>();
  if (!fs.existsSync(root)) return found;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const text = fs.readFileSync(p, 'utf8');
        for (const spec of extractModuleSpecifiers(text, p)) {
          const id = normalizeSpecifier(spec);
          if (id !== undefined) found.add(id);
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
 * `process.cwd()` and the credential-file filesystem. It performs the import
 * discovery, probes `*_FILE` credential paths for existence, and then hands off
 * to the pure `scanProvidersWith` core with an injected evidence map. Tests must
 * NOT call this; they call the pure entry points with explicit inputs.
 */
export function scanProvidersFromProcess(
  repoRoot: string = process.cwd(),
  env: EnvMap = process.env,
  providers: ProviderDef[] = PROVIDERS,
): ProviderReport[] {
  const importedPackages = collectImports(repoRoot);
  const pathPresence = collectPathPresence(repoRoot, providers);
  const evidence = collectFileEvidence(env, providers);
  return scanProvidersWith(importedPackages, pathPresence, env, providers, evidence);
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
