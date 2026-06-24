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
   * more than one auth mode — e.g. AWS S3 is wired with static access keys
   * (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) OR the IRSA web-identity pair
   * (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE) OR the EKS Pod Identity pair
   * (AWS_CONTAINER_CREDENTIALS_FULL_URI + AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE).
   * Every var WITHIN a chosen group is required. The provider is STUB only when
   * NO group is fully satisfied.
   */
  requiresAnyOf?: string[][];
  /** Optional fallback domains (paths) to also confirm provider wiring. */
  filePathHints?: string[];
}

export const PROVIDERS: ProviderDef[] = [
  // ----- Auth / identity -----
  {
    id: 'supabase',
    label: 'Supabase (auth + DB)',
    packages: ['@supabase/supabase-js'],
    requires: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  },
  // ----- Payments -----
  {
    id: 'stripe',
    label: 'Stripe',
    packages: ['stripe'],
    filePathHints: ['src/billing', 'src/stripe', 'src/checkout'],
    requires: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  },
  // ----- Model vendors -----
  { id: 'openai', label: 'OpenAI', packages: ['openai'], requires: ['OPENAI_API_KEY'] },
  // ----- Email -----
  {
    id: 'sendgrid',
    label: 'SendGrid (email)',
    packages: ['@sendgrid/mail'],
    filePathHints: ['src/email'],
    requires: ['SENDGRID_API_KEY'],
  },
  // ----- SMS / voice -----
  {
    id: 'twilio',
    label: 'Twilio (SMS)',
    packages: ['twilio'],
    filePathHints: ['src/sms'],
    requires: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
  },
  // ----- Edge / CDN -----
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    packages: ['cloudflare'],
    filePathHints: ['src/cdn', 'src/cloudflare'],
    requires: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
  },
  // ----- Media / video -----
  {
    id: 'mux',
    label: 'Mux (video)',
    packages: ['@mux/mux-node'],
    filePathHints: ['src/video', 'src/coach-media'],
    requires: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'],
  },
  // ----- Storage / files -----
  {
    id: 'aws-s3',
    label: 'AWS S3',
    packages: ['@aws-sdk/client-s3'],
    // AWS_REGION is always needed; credentials may arrive via one of three
    // mutually-exclusive modes, so they form an either/or group:
    //   - static keys (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY);
    //   - IRSA / web identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE) — BOTH
    //     are required: the EKS pod-identity webhook injects the role ARN and the
    //     token file together, and the SDK assumes the role named by the ARN;
    //   - EKS Pod Identity (AWS_CONTAINER_CREDENTIALS_FULL_URI +
    //     AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) — AWS's recommended default for
    //     new EKS workloads; both are injected by the Pod Identity daemon.
    requires: ['AWS_REGION'],
    requiresAnyOf: [
      ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      ['AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'],
      ['AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'],
    ],
  },
  // ----- Hosting / platform -----
  {
    id: 'fly',
    label: 'Fly.io',
    packages: [],
    filePathHints: ['src/platform', 'fly.toml'],
    requires: ['FLY_API_TOKEN'],
  },
  // ----- Observability -----
  {
    id: 'sentry',
    label: 'Sentry',
    packages: ['@sentry/node'],
    requires: ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN'],
  },
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
/**
 * Decode one base64url JWT segment to a UTF-8 string and `JSON.parse` it,
 * returning the parsed object or `undefined` on any failure (invalid base64url,
 * invalid UTF-8, or non-object JSON). OFFLINE only — never calls out to Supabase
 * and never verifies the signature. `Buffer.from(seg, 'base64url')` is Node 16+.
 */
function decodeJwtJsonSegment(seg: string): Record<string, unknown> | undefined {
  let json: string;
  try {
    json = Buffer.from(seg, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Defensive cap on a single JWT segment's character length before we attempt a
 * base64url decode. Real Supabase headers/payloads are well under 1 KB; an
 * attacker-supplied env value could otherwise feed a multi-megabyte segment
 * into `Buffer.from` + `JSON.parse`. Anything longer than this is rejected
 * outright as malformed/oversized (H4.D R4 F001).
 */
const MAX_JWT_SEGMENT_CHARS = 8192;

/**
 * Allowlist of plausible Supabase signing algorithms (H4.D R4 F001). Supabase's
 * canonical service-role token is signed `HS256`, but `RS256`/`ES256` (and the
 * wider HMAC/RSA/ECDSA families) appear in some self-hosted or rotated
 * deployments, so the allowlist is defensive without being brittle. Crucially
 * it EXCLUDES `"none"` (an unsigned token any env-file editor could forge) and
 * any unknown/garbage value. Comparison is case-insensitive — `"none"`,
 * `"NONE"`, and `"None"` are all rejected; the canonical casing of the listed
 * algs is upper-case, so we upper-case the candidate before membership test.
 */
const ALLOWED_JWT_ALGS: ReadonlySet<string> = new Set([
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
]);

/**
 * OFFLINE structural validator for a Supabase service-role JWT. A bare regex on
 * the `eyJ….….…` segment shape lets malformed values through (`eyJbad.abc.def`
 * decodes to broken JSON yet matches the old regex). We instead require:
 *   1. exactly three dot-separated segments, each within `MAX_JWT_SEGMENT_CHARS`;
 *   2. header decodes to valid JSON with a string `alg` claim that is on the
 *      `ALLOWED_JWT_ALGS` allowlist (NOT `"none"` in any casing, NOT unknown/
 *      garbage) and, if a `typ` claim is present, it equals `"JWT"` — real
 *      Supabase tokens set `typ: "JWT"`, but we stay lenient when it is omitted;
 *   3. payload decodes to valid JSON whose `role` claim is EXACTLY the string
 *      `"service_role"`. This is a HARD GATE.
 *
 * Algorithm awareness (step 2 `alg` allowlist) is the H4.D R4 F001 fix. The
 * prior revision accepted ANY non-empty string `alg`, so a token with
 * `header.alg = "none"` (or a garbage alg) plus `payload.role = "service_role"`
 * classified WIRED. Since this validator advertises "looks like a real
 * service_role JWT" as the wired signal, accepting an unsigned/forgeable token
 * lets anyone who can edit the env file fabricate a "looks-real" key with no
 * signing material — defeating the heuristic and the R30 secret-hygiene /
 * R108 provider-wiring surface it guards. The header is now validated BEFORE
 * the payload role gate.
 *
 * The role gate is deliberate (H4.D R3 F001). An earlier revision also accepted
 * a token merely because it carried a non-empty `iss` or `ref` claim. That was
 * too permissive: virtually every well-formed JWT (including a Supabase `anon`
 * token, whose payload also carries `iss`/`ref`) has an `iss`, so the OR-on-iss/
 * ref let non-service-role tokens validate as service-role keys. The `iss`/`ref`
 * claims remain useful *corroborating* evidence, but they are NOT sufficient on
 * their own and never substitute for the role check. A token with the wrong
 * role (e.g. `role: "anon"`) or no role at all is rejected even if it carries a
 * project `ref` and an `iss`.
 *
 * The signature segment is only required to be present and non-empty — it is
 * never verified offline. Any failure returns `false`, so the value is bucketed
 * as a placeholder (→ STUB) rather than wired.
 */
export function isPlausibleSupabaseServiceRoleJwt(v: unknown): boolean {
  // Fail-closed type guard (R31): the TS signature is compile-time only, and this
  // function is part of the public module surface with a documented "any failure
  // returns false" contract. A JS caller or a future refactor passing a non-string
  // (null/undefined/number/object) must return false, never throw on `.split`.
  if (typeof v !== 'string' || v.length === 0) return false;
  const segments = v.split('.');
  if (segments.length !== 3) return false;
  const [headerSeg, payloadSeg, signatureSeg] = segments;
  if (signatureSeg.length === 0) return false;

  // Defensive size cap (R4 F001): reject oversized segments before decoding so a
  // malicious env value cannot force a huge base64url decode / JSON.parse.
  if (
    headerSeg.length > MAX_JWT_SEGMENT_CHARS ||
    payloadSeg.length > MAX_JWT_SEGMENT_CHARS ||
    signatureSeg.length > MAX_JWT_SEGMENT_CHARS
  ) {
    return false;
  }

  // Validate the HEADER first (R4 F001), before the payload role gate.
  const header = decodeJwtJsonSegment(headerSeg);
  if (header === undefined) return false;
  if (typeof header.alg !== 'string' || header.alg.length === 0) return false;
  // Reject `alg=none` (any casing) and any value not on the allowlist. The
  // allowlist members are upper-case, so upper-case the candidate to compare
  // case-insensitively while still rejecting `"none"`/`"NONE"`/`"None"`.
  if (!ALLOWED_JWT_ALGS.has(header.alg.toUpperCase())) return false;
  // If a `typ` claim is present it must be exactly "JWT"; absent is tolerated.
  if (header.typ !== undefined && header.typ !== 'JWT') return false;

  const payload = decodeJwtJsonSegment(payloadSeg);
  if (payload === undefined) return false;

  // HARD GATE (R30/R31/R40): the role claim MUST be exactly "service_role".
  // `iss`/`ref` are corroborating evidence only and never accepted alone.
  return payload.role === 'service_role';
}

/**
 * Loose structural check that a value LOOKS like a filesystem path (absolute or
 * relative) rather than a URL or an opaque secret blob. Used for `*_FILE`
 * credential vars (AWS_WEB_IDENTITY_TOKEN_FILE, AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE):
 * actual on-disk existence is gated separately through the injected evidence map
 * (`fileEvidenceOk`). Rejects empty values and any value containing whitespace
 * or characters that never appear in a credential-file path.
 */
function isPathShaped(v: string): boolean {
  return v.length > 0 && /^[\w.\-/@+=,:~]+$/.test(v);
}

export const KEY_SHAPE_VALIDATORS: Readonly<Record<string, (v: string) => boolean>> = {
  // Must be a SECRET key (sk_), live or test, with a long-enough body. This
  // rejects publishable (pk_) and restricted (rk_) keys outright — they are the
  // wrong type for this slot — as well as truncated secret keys.
  STRIPE_SECRET_KEY: (v) => /^sk_(live|test)_[A-Za-z0-9]{24,}$/.test(v),
  // Stripe webhook signing secret: `whsec_` + ≥20 chars of body.
  STRIPE_WEBHOOK_SECRET: (v) => /^whsec_[A-Za-z0-9]{20,}$/.test(v),
  // Supabase service-role key is a JWT. A regex on the segment shape is NOT
  // sufficient — strings like `eyJbad.abc.def` match `eyJ…\.…\.…` yet are not
  // valid base64url-encoded JSON. We decode and parse the header + payload
  // OFFLINE (no signature verification, no network) and require plausible
  // service-role claims. See `isPlausibleSupabaseServiceRoleJwt`.
  SUPABASE_SERVICE_ROLE_KEY: (v) => isPlausibleSupabaseServiceRoleJwt(v),
  // OpenAI API key: `sk-` prefix + ≥20 chars of body (covers `sk-proj-…` too).
  OPENAI_API_KEY: (v) => /^sk-[A-Za-z0-9_-]{20,}$/.test(v),
  // AWS IAM role ARN (IRSA path): `arn:aws[partition]:iam::<12-digit acct>:role/<name>`.
  AWS_ROLE_ARN: (v) => /^arn:aws[a-z0-9-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(v),
  // EKS Pod Identity credentials endpoint: an HTTP(S) URL. The Pod Identity
  // daemon serves credentials over plain HTTP on the loopback link-local address
  // (169.254.170.23), so `http://` MUST be accepted alongside `https://`.
  AWS_CONTAINER_CREDENTIALS_FULL_URI: (v) => /^https?:\/\/[^\s]+$/.test(v),
  // Credential-FILE vars: structurally a filesystem path. On-disk existence /
  // readability is gated separately via the evidence map (`fileEvidenceOk`).
  AWS_WEB_IDENTITY_TOKEN_FILE: (v) => isPathShaped(v),
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: (v) => isPathShaped(v),
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
  const missingFileVar = fileVarsOf(group).find(
    (v) => evidence[fileExistsEvidenceKey(v)] === false,
  );
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
  // The same `*_FILE` evidence-existence rule applied to requiresAnyOf groups
  // (below) must also gate the always-bucket: a `*_FILE` var placed in `requires`
  // is otherwise classified on env-string presence alone, so a missing/unusable
  // file on disk would fail open to WIRED (R5-F002). `fileEvidenceOk` is inert
  // for groups with no `*_FILE` var, so this is a no-op for all current providers.
  const alwaysSatisfied =
    always.missing.length === 0 &&
    always.placeholder.length === 0 &&
    fileEvidenceOk(def.requires, evidence);

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
export function isSdkImported(
  def: ProviderDef,
  importedPackages: ReadonlySet<string>,
  pathPresence: ReadonlySet<string>,
): boolean {
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
export function collectFileEvidence(
  env: EnvMap,
  providers: ProviderDef[] = PROVIDERS,
): EvidenceMap {
  const out: Record<string, boolean> = {};
  for (const p of providers) {
    const groups = [p.requires, ...(p.requiresAnyOf ?? [])];
    for (const fileVar of fileVarsOf(groups.flat())) {
      const value = env[fileVar];
      if (value !== undefined && value !== '') {
        out[fileExistsEvidenceKey(fileVar)] = isReadableRegularFile(value);
      }
    }
  }
  return out;
}

/**
 * I/O EDGE helper: `true` only when `p` resolves to a REGULAR file that is
 * readable. `fs.existsSync` alone is insufficient — a DIRECTORY (or socket/fifo)
 * at a credential path satisfies existence yet is not a usable token file, so
 * the provider would wrongly classify WIRED.
 *
 * Symlink handling (H4.D R3 F002): we `lstatSync` FIRST so we can tell a symlink
 * apart from a real file without following it blindly. An earlier revision
 * stopped there and rejected anything whose `lstat` was not itself a regular
 * file — which wrongly rejected a symlink pointing AT a valid token file. That
 * broke legitimate `AWS_WEB_IDENTITY_TOKEN_FILE` deployments: Kubernetes mounts
 * the projected service-account token through a symlink chain
 * (`..data/token` → timestamped dir), so the path the pod sees is a symlink to a
 * regular file. We now:
 *   - if the path itself is a regular file (or a hardlink, which `lstat` reports
 *     as a regular file), confirm read access and accept;
 *   - if the path is a symlink, resolve its target with `fs.realpathSync.native`
 *     (wrapped so a DANGLING link maps to `false`, never an unhandled throw),
 *     `statSync` the resolved target (following the full chain), and accept only
 *     when the target is a regular file that is readable;
 *   - reject everything else: directories, sockets, FIFOs, character/block
 *     devices, and symlinks pointing at any of those or at a dangling target.
 *
 * Any error (missing path, permission, non-file, dangling link) returns `false`
 * rather than propagating. Errors are not swallowed silently in the sense R59
 * guards against: each maps to a deterministic `false` (a usable-token-file
 * negative), not a hidden failure — the caller records the resulting evidence
 * bit, and a `false` here surfaces downstream as a STUB classification.
 */
function isReadableRegularFile(p: string): boolean {
  try {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) {
      // Resolve the (possibly multi-hop) symlink chain to its real target.
      // A dangling target throws ENOENT here — caught below → false.
      const target = fs.realpathSync.native(p);
      const tst = fs.statSync(target); // statSync follows links; target is real.
      if (!tst.isFile()) return false; // dir / socket / fifo / device target.
      fs.accessSync(target, fs.constants.R_OK);
      return true;
    }
    // Not a symlink: a regular file (incl. hardlinks) is acceptable; a
    // directory, socket, FIFO, or device is not.
    if (!lst.isFile()) return false;
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
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
 * Map a file name to the TypeScript `ScriptKind` so JSX-bearing files parse
 * correctly. `.tsx`/`.jsx` need `Tsx`/`Jsx`; everything else (incl. `.mts`,
 * `.cts`, `.ts`) parses as `TS`.
 */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
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
 * True when an `ImportDeclaration` contributes NO runtime binding and should be
 * ignored as provider usage (H4.D R3 F003). Two erased shapes:
 *   - declaration-level `import type { X } from 'pkg'` — `importClause.isTypeOnly`;
 *   - named-only imports where EVERY specifier is per-specifier type-only,
 *     e.g. `import { type X, type Y } from 'pkg'`.
 * A side-effect import (`import 'pkg'`, no `importClause`) is NOT type-only. A
 * default or namespace import always introduces a runtime binding, so a clause
 * carrying either is never treated as type-only here. A mixed named import
 * (`import { type X, Y }`) keeps the runtime binding `Y` and is not type-only.
 */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false; // side-effect import: runtime.
  if (clause.isTypeOnly) return true; // `import type ...`.
  // A default binding (`import D from`) or namespace (`import * as ns from`) is
  // a runtime binding regardless of any named bindings.
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return false; // `* as ns` is runtime.
  // NamedImports: type-only iff every element is per-specifier type-only.
  if (bindings.elements.length === 0) return false;
  return bindings.elements.every((el) => el.isTypeOnly);
}

/**
 * True when an `ExportDeclaration` re-export contributes NO runtime binding and
 * should be ignored as provider usage (H4.D R3 F003). Mirrors the import case:
 *   - declaration-level `export type { X } from 'pkg'` — `node.isTypeOnly`;
 *   - named re-exports where EVERY specifier is per-specifier type-only,
 *     e.g. `export { type X } from 'pkg'`.
 * A namespace/star re-export (`export * from 'pkg'`, `export * as ns from`) has
 * no `exportClause` and is a runtime re-export, so it is never type-only. A
 * mixed `export { type X, Y } from 'pkg'` keeps the runtime binding `Y`.
 */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true; // `export type ...`.
  const clause = node.exportClause;
  if (clause === undefined) return false; // `export * from 'pkg'`: runtime.
  if (ts.isNamespaceExport(clause)) return false; // `export * as ns`: runtime.
  // NamedExports: type-only iff every element is per-specifier type-only.
  if (clause.elements.length === 0) return false;
  return clause.elements.every((el) => el.isTypeOnly);
}

/**
 * Extract every statically-known module specifier from one source file's AST.
 * Covers: `import … from 'pkg'` and side-effect `import 'pkg'`
 * (ImportDeclaration), `require('pkg')` (CallExpression to the `require`
 * identifier with a string-literal arg), and dynamic `import('pkg')`
 * (CallExpression whose expression is the `import` keyword). Computed/dynamic
 * specifiers (e.g. `import(variable)`, `require(`a` + b)`) are NOT statically
 * known and are skipped safely.
 *
 * Type-only imports/exports are EXCLUDED (H4.D R3 F003). TypeScript erases
 * `import type { X } from 'pkg'` and `export type { X } from 'pkg'` at compile
 * time — they emit no runtime `require`/`import`, so counting them as runtime
 * provider usage produces false positives (a provider "used" only for its types
 * would wrongly classify as WIRED/blocking). We skip a declaration when:
 *   - the whole declaration is type-only (`importClause.isTypeOnly` on
 *     ImportDeclaration, `node.isTypeOnly` on ExportDeclaration), e.g.
 *     `import type { X } from 'pkg'` / `export type { X } from 'pkg'`; OR
 *   - every named binding is per-specifier type-only, e.g.
 *     `import { type X } from 'pkg'` / `export { type X } from 'pkg'`.
 * A MIXED import like `import { type X, Y } from 'pkg'` still counts (the
 * runtime binding `Y` keeps the package in the emit). Side-effect imports
 * (`import 'pkg'`), default/namespace imports, `require(...)`, and dynamic
 * `import(...)` are always runtime and always counted.
 *
 * The `ScriptKind` is derived from the file name so `.tsx` (and `.jsx`) sources
 * parse with JSX enabled — otherwise the `<Foo/>` syntax in a React component
 * would be misparsed and its `import` statements lost.
 */
export function extractModuleSpecifiers(sourceText: string, fileName = 'in-memory.ts'): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    // Static `import ... from 'pkg'` and side-effect `import 'pkg'`.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) specifiers.push(node.moduleSpecifier.text);
    }
    // `export ... from 'pkg'` re-exports also pull in the package.
    else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) specifiers.push(node.moduleSpecifier.text);
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
/**
 * Should this filename be scanned for provider imports? Includes TypeScript
 * sources (`.ts`), React TSX components (`.tsx`), and ESM/CJS module variants
 * (`.mts`/`.cts`) — while always excluding ambient declaration files (`.d.ts`),
 * which only declare types and never wire a real SDK. The old filter accepted
 * `.ts` only, so a provider imported solely from a `.tsx` component reported
 * NOT_USED even though it is genuinely used (F003).
 */
function isScannableSourceFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  return (
    name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.mts') || name.endsWith('.cts')
  );
}

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
      } else if (e.isFile() && isScannableSourceFile(e.name)) {
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
  'changeme',
  'change-me',
  'your-key',
  'your_key',
  'yourkey',
  'placeholder',
  'todo',
  'tbd',
  'xxx',
  'fixme',
  'fake',
  'example',
  'insert_key_here',
  'sk_test_replace',
  'whsec_replace',
  'redacted',
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
