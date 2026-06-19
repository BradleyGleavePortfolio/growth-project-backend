// auto-flipper.ts — plans and (optionally) commits Fly secrets for every
// prod-readiness switch the registry marks auto-flippable, so a fresh prod
// environment can be brought to its declared default state without an operator
// hand-typing `flyctl secrets set` per switch (R100).
//
// Two phases, both pure-ish and unit-testable:
//   1. plan(): compares the registry's auto-flip rows against the current Fly
//      secret list and partitions them into to_set / already_set / to_skip.
//      Always safe — performs no mutation.
//   2. commit(): for each `to_set` row, shells out to `flyctl secrets set`.
//      Gated behind READINESS_AUTO_FLIP=true so a stray invocation cannot
//      mutate prod. Runs strictly sequentially (one inflight flyctl at a time)
//      so we never storm the Fly API.
//
// Security invariants (binding):
//   - Uses execFileSync with an explicit argv — never `exec`, so no shell is
//     ever spawned and a secret value can never be interpreted as shell syntax.
//   - Every log line redacts the secret value: we emit `KEY=***`, never the
//     literal. The value is passed to flyctl over argv only.
//
// Field semantics come from registry-loader.ts (H4.A): a row with
// `auto_flip_on_in_prod: true` is a candidate; `prod_default` decides the
// target value (ON -> "true", OFF -> "false"). MUST_SET / STUB_ALLOWED rows are
// never auto-flipped — they need human judgement — so they land in to_skip.

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';
import type { RegistryRow } from './registry-loader';
import { RegistryParseError } from './registry-loader';

/** Env flag that must equal "true" before any real secret mutation runs. */
export const AUTO_FLIP_ENV = 'READINESS_AUTO_FLIP';
/** Operator recorded in the audit trail; matches the repo's commit identity. */
export const AUDIT_OPERATOR = 'Bradley Gleave';
/** Env var that overrides the flyctl binary path (F007). */
export const FLY_BIN_ENV = 'FLY_BIN';
/** The bare default that relies on PATH resolution (operators SHOULD override). */
export const FLY_BIN_DEFAULT = 'flyctl';
/**
 * Env flag that forces an absolute, resolved {@link FLY_BIN} regardless of
 * `NODE_ENV` (F003). When `"true"`, the bare PATH-resolved default is REJECTED
 * at module load — used to lock CI/staging/prod down explicitly.
 */
export const FLY_BIN_REQUIRE_ABSOLUTE_ENV = 'FLY_BIN_REQUIRE_ABSOLUTE';

/**
 * Filesystem operations the resolver depends on, injectable so tests never
 * touch a real binary (F003). Defaults to the real `node:fs` sync calls.
 */
export interface FlyBinFs {
  realpathSync: (p: string) => string;
  statSync: (p: string) => Pick<Stats, 'isFile'>;
  accessSync: (p: string, mode: number) => void;
}

const DEFAULT_FLY_BIN_FS: FlyBinFs = {
  realpathSync: (p) => realpathSync(p),
  statSync: (p) => statSync(p),
  accessSync: (p, mode) => accessSync(p, mode),
};

/**
 * Non-strict environments where the bare PATH default is tolerated: `development`
 * and the unit-test runner (`test`), plus an unset NODE_ENV (local shells). Any
 * other concrete NODE_ENV (production / staging / ci) is STRICT and rejects the
 * bare default on this secret-mutating path (F003). An explicit
 * FLY_BIN_REQUIRE_ABSOLUTE=true forces strict regardless of NODE_ENV.
 */
const NON_STRICT_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test']);
function isStrictEnv(env: NodeJS.ProcessEnv): boolean {
  if (env[FLY_BIN_REQUIRE_ABSOLUTE_ENV] === 'true') return true;
  return env.NODE_ENV !== undefined && !NON_STRICT_NODE_ENVS.has(env.NODE_ENV);
}

/**
 * The canonical (realpath-resolved) absolute path we will actually exec, cached
 * at module load so {@link assertFlyBinUnchanged} can detect a TOCTOU swap. It
 * is `undefined` when {@link FLY_BIN} is the bare PATH default (dev only).
 */
let _resolvedFlyBinPath: string | undefined;

/**
 * Resolve the flyctl binary path from `FLY_BIN`, validating it at module load
 * (F003/F007 — R24/R58/R95/R110). A PATH-resolved binary on a secret-mutating
 * path is a spoof vector, and an absolute SYMLINK can still point at a
 * malicious target. So:
 *   - An explicit `FLY_BIN` MUST be an absolute path (relative = rejected).
 *   - The absolute path is `realpathSync`-resolved; the resolved target must be
 *     a REGULAR FILE and `X_OK`-executable, else rejected. The resolved
 *     canonical path is cached for per-invocation TOCTOU revalidation.
 *   - The bare default `flyctl` is REJECTED in CI/staging/prod (NODE_ENV !==
 *     "development") or when FLY_BIN_REQUIRE_ABSOLUTE=true. In development only,
 *     it is permitted with a one-time WARN.
 */
function resolveFlyBin(env: NodeJS.ProcessEnv, fs: FlyBinFs = DEFAULT_FLY_BIN_FS): string {
  const override = env[FLY_BIN_ENV];
  if (override !== undefined && override !== FLY_BIN_DEFAULT) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `${FLY_BIN_ENV} must be an absolute path (got "${override}"); a PATH-relative ` +
          `flyctl is a spoof vector on a secret-mutating path. Set ${FLY_BIN_ENV} to an ` +
          `absolute binary path, or unset it to fall back to PATH-resolved "${FLY_BIN_DEFAULT}".`,
      );
    }
    // F003: resolve symlinks to their real target, then verify it is a regular
    // executable file. A symlink to a malicious binary, a dangling symlink, or
    // a non-executable target are all rejected here.
    const resolved = resolveAndVerifyBinary(override, fs);
    _resolvedFlyBinPath = resolved;
    return resolved;
  }
  // Bare PATH default: forbidden on any secret-mutating path outside dev.
  if (isStrictEnv(env)) {
    throw new Error(
      `${FLY_BIN_ENV} is unset and a bare PATH-resolved "${FLY_BIN_DEFAULT}" is not allowed ` +
        `outside development (NODE_ENV=${env.NODE_ENV ?? 'unset'}). Set ${FLY_BIN_ENV} to an ` +
        `absolute binary path on this secret-mutating path.`,
    );
  }
  _resolvedFlyBinPath = undefined;
  return FLY_BIN_DEFAULT;
}

/**
 * Realpath-resolve an absolute candidate and verify the canonical target is a
 * regular, executable file (F003). Throws a descriptive error otherwise. Shared
 * by module-load resolution and per-invocation TOCTOU revalidation.
 */
function resolveAndVerifyBinary(candidate: string, fs: FlyBinFs): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(
      `${FLY_BIN_ENV}="${candidate}" could not be resolved (dangling symlink or missing target); ` +
        `refusing to run flyctl on a secret-mutating path.`,
    );
  }
  let stat: Pick<Stats, 'isFile'>;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(
      `${FLY_BIN_ENV} resolved target "${resolved}" could not be stat'd; refusing to run flyctl.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `${FLY_BIN_ENV} resolved target "${resolved}" is not a regular file; refusing to run flyctl.`,
    );
  }
  try {
    fs.accessSync(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(
      `${FLY_BIN_ENV} resolved target "${resolved}" is not executable; refusing to run flyctl.`,
    );
  }
  return resolved;
}

/**
 * TOCTOU revalidation (F003): before EVERY flyctl invocation, re-`statSync` the
 * cached canonical path and refuse if it has been swapped for a non-regular or
 * non-executable file since module load. No-op when running the bare PATH
 * default (dev only) since there is no canonical path to revalidate.
 */
export function assertFlyBinUnchanged(fs: FlyBinFs = DEFAULT_FLY_BIN_FS): void {
  if (_resolvedFlyBinPath === undefined) return;
  resolveAndVerifyBinary(_resolvedFlyBinPath, fs);
}

/** Test-only: re-run resolution with injected env/fs, returning the result. */
export function __resolveFlyBinForTest(env: NodeJS.ProcessEnv, fs: FlyBinFs): string {
  return resolveFlyBin(env, fs);
}

/** Test-only: read the cached canonical resolved path (or undefined). */
export function __getResolvedFlyBinPathForTest(): string | undefined {
  return _resolvedFlyBinPath;
}

/** Test-only: clear the cached canonical path so suites cannot contaminate each other. */
export function __resetResolvedFlyBinForTest(): void {
  _resolvedFlyBinPath = undefined;
}

/** Binary we shell out to; an absolute, verified `FLY_BIN` override, else (dev) `flyctl`. */
export const FLY_BIN = resolveFlyBin(process.env);

/** Guards the one-time PATH-dependency warning for the bare-`flyctl` default. */
let _flyBinWarned = false;

/**
 * Emit a single WARN (per process) when we are about to invoke the bare,
 * PATH-resolved `flyctl` on a secret-mutating path so operators can see the
 * dependency and pin an absolute {@link FLY_BIN_ENV}. No-op once an absolute
 * path is configured. The optional sink keeps it testable; defaults to
 * `console.warn`.
 */
export function warnIfPathResolvedFlyBin(warn: (line: string) => void = console.warn): void {
  if (FLY_BIN !== FLY_BIN_DEFAULT) return; // an absolute path was configured
  if (_flyBinWarned) return;
  _flyBinWarned = true;
  warn(
    `warning: ${FLY_BIN_ENV} is unset — relying on PATH to resolve "${FLY_BIN_DEFAULT}" on a ` +
      `secret-mutating path. Set ${FLY_BIN_ENV} to an absolute path in CI/staging/prod.`,
  );
}

/** Test-only reset of the one-time warning latch. */
export function __resetFlyBinWarnedForTest(): void {
  _flyBinWarned = false;
}
/** Where to point operators when flyctl is not installed. */
export const FLY_INSTALL_DOCS = 'https://fly.io/docs/flyctl/install/';
/** Hard cap on a single flyctl invocation so a hung CLI cannot block forever. */
export const FLY_TIMEOUT_MS = 60_000;
/** The token every redacted secret value collapses to — value is never emitted. */
export const REDACTED = '***';

/**
 * Lowercase keyword fragments that mark an assignment/field as secret-bearing
 * regardless of case (`apikey=`, `password:`, `"token":`, `X-API-Key:` …). An
 * UPPER_SNAKE key is always treated as a candidate; these handle the lower- and
 * mixed-case JSON/YAML/header/URL-encoded shapes that an UPPER_SNAKE-only
 * matcher missed (F001). Kept deliberately narrow so a benign `count=5` is NOT
 * redacted — only keys whose NAME signals a credential.
 */
const SECRET_KEY_HINT =
  /(api[-_]?key|secret|token|password|passwd|pwd|auth|authorization|bearer|credential|private[-_]?key|access[-_]?key|session|cookie|jwt|client[-_]?secret)/i;

/** A key is a redaction candidate if it is UPPER_SNAKE or name-signals a secret. */
function isSecretKey(key: string): boolean {
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) return true; // UPPER_SNAKE — always a candidate
  return SECRET_KEY_HINT.test(key);
}

/**
 * Escape a literal string for safe use inside a RegExp. Used by value-based
 * redaction so an arbitrary secret value (which may contain regex metachars)
 * can be matched literally anywhere in the text.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Value-aware, format-aware secret redactor. This is the load-bearing fix
 * (H4.F R2 F001): the previous implementation only handled UPPER_SNAKE
 * `KEY=VALUE` runs and leaked quoted/JSON/YAML/header/URL-encoded/lowercase
 * shapes plus bare secret strings carried in error text.
 *
 * It runs TWO complementary passes:
 *
 *  1. **Value-based** — when `secretValues` is supplied (the literal secret
 *     strings the caller is about to set, gathered from the plan), every
 *     occurrence of each literal is replaced with `***` wherever it appears,
 *     even in free-form prose with no `KEY=VAL` shape. This is the only
 *     defence against an error message that embeds the raw secret with no
 *     key context.
 *  2. **Pattern-based** — covers assignment/field shapes whose VALUE we may
 *     not know up front: env `KEY=VALUE`, quoted forms, JSON `"KEY":"value"`
 *     / `"KEY":value`, YAML inline `KEY: value`, HTTP headers
 *     (`Authorization: Bearer <secret>`, `X-API-Key: <secret>`), and
 *     URL-encoded assignments. UPPER_SNAKE keys always match; lower-/mixed-
 *     case keys match only when the key NAME signals a credential, so a
 *     benign `count=5` is left intact.
 *
 * The value is collapsed wholesale to `***` — never a prefix — because even a
 * few characters of a real secret are a leak.
 */
export function redactSecretValues(text: string, secretValues?: Iterable<string>): string {
  if (text.length === 0) return text;
  let out = text;

  // De-duplicated, longest-first literal set, reused by every pass below so a
  // value that is a prefix of another is never partially revealed.
  const literals =
    secretValues === undefined
      ? []
      : Array.from(new Set(Array.from(secretValues)))
          .filter((v) => v.trim().length > 0)
          .sort((a, b) => b.length - a.length);

  // Pass 1 — value-based: replace every known literal secret wherever it
  // appears, even in free-form prose with no KEY=VAL shape (F001).
  out = redactLiterals(out, literals);

  // Pass 2 — structural JSON walk (F001 nested/escaped). If the input parses as
  // JSON, walk the tree and redact every value at ANY depth whose KEY signals a
  // secret, then re-stringify. This is the only pass that reaches a secret
  // nested under a non-secret outer key (`{"error":{"SECRET":"…"}}`), which the
  // greedy outer regex below cannot. Escaped-JSON strings
  // (`"{\"SECRET\":\"…\"}"`) are unescaped and re-walked to a bounded fixed point.
  out = redactStructuralJson(out, literals);

  // Pass 3 — base64 (F001): if a value alternative looks base64-shaped, decode
  // it and re-run literal + structural redaction on the decoded text; if the
  // decoded form contained a known secret, drop the whole encoded blob to ***.
  out = redactBase64Values(out, literals);

  // Pass 4 — pattern-based, applied in most-specific-first order.

  // (a) HTTP auth headers: `Authorization: Bearer <secret>` / `Authorization: <scheme> <secret>`.
  out = out.replace(
    /\b(Authorization)(\s*:\s*)(Bearer|Token|Basic)(\s+)\S+/gi,
    `$1$2$3 ${REDACTED}`,
  );
  // (b) Other secret-named HTTP headers: `X-API-Key: <secret>`, `X-Auth-Token: <secret>`.
  out = out.replace(
    /\b(X-[A-Za-z0-9-]*(?:Api-?Key|Auth|Token|Secret)[A-Za-z0-9-]*)(\s*:\s*)\S+/gi,
    `$1$2${REDACTED}`,
  );
  // (c) `KEY="quoted value"` / `KEY='quoted value'` (quote AFTER the equals;
  //     value may contain spaces). Drop the whole quoted run to ***.
  out = out.replace(
    /([A-Za-z][A-Za-z0-9_-]*)(\s*=\s*)(['"])[^'"]*\3/g,
    (m, key: string, sep: string, q: string) =>
      isSecretKey(key) ? `${key}${sep}${q}${REDACTED}${q}` : m,
  );
  // (d) `'KEY=value'` / `"KEY=value"` (the equals lives INSIDE the quotes).
  out = out.replace(
    /(['"])([A-Za-z][A-Za-z0-9_-]*)\s*=\s*[^'"]*\1/g,
    (m, q: string, key: string) => (isSecretKey(key) ? `${q}${key}=${REDACTED}${q}` : m),
  );
  // (e) JSON fields: "KEY":"value" or "KEY":value (number/bool/bareword).
  out = out.replace(
    /("([A-Za-z][A-Za-z0-9_-]*)"\s*:\s*)("[^"]*"|[^\s,}\]]+)/g,
    (m, prefix: string, key: string) => (isSecretKey(key) ? `${prefix}"${REDACTED}"` : m),
  );
  // (f) YAML inline / header-style `KEY: value` (not a URL `http://`, not an
  //     already-redacted header, not a YAML block-scalar indicator `|`/`>`).
  out = out.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)(:[ \t]+)(?!\/\/)([^\s,}\]][^\n]*?)(?=$|[\n,}\]])/g,
    (m, key: string, sep: string, value: string) => {
      if (!isSecretKey(key)) return m;
      // Leave block-scalar headers (`secret: |`, `key: >`) and already-redacted
      // values intact — Pass 1 / pattern (a)(b) handled the real content.
      if (value === '|' || value === '>' || value.includes(REDACTED)) return m;
      return `${key}${sep}${REDACTED}`;
    },
  );
  // (g) Bare/URL-encoded env-style pairs: KEY=value (value runs to next space/quote).
  out = out.replace(/([A-Za-z][A-Za-z0-9_-]*)\s*=\s*[^\s'"&]+/g, (m, key: string) =>
    isSecretKey(key) ? `${key}=${REDACTED}` : m,
  );
  // (h) YAML block scalar (F001): `KEY: |` / `KEY: >` followed by more-indented
  //     continuation lines that hold the value. Redact each line's content.
  out = redactYamlBlockScalars(out);

  return out;
}

/**
 * Pass 1 helper: replace every known literal secret wherever it appears
 * (longest-first so a prefix value is not partially revealed).
 */
function redactLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    out = out.replace(new RegExp(escapeRegExp(literal), 'g'), REDACTED);
  }
  return out;
}

/**
 * Recursively redact a parsed-JSON value: any object entry whose KEY is
 * secret-named has its value collapsed to `***` at ANY depth; other values are
 * walked. Closes the nested-under-a-non-secret-outer-key leak
 * (`{"error":{"SECRET":"..."}}`) the greedy outer regex cannot reach (F001).
 */
function redactJsonNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((el) => redactJsonNode(el));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactJsonNode(value);
    }
    return out;
  }
  return node;
}

/**
 * Pass 2 helper (F001): structural + escaped-JSON redaction to a bounded fixed
 * point. If `text` parses as JSON, walk it and re-stringify with secret-named
 * fields collapsed. If it does not parse but contains escaped-quote JSON, one
 * layer of escapes is removed and the parse retried. Capped at 3 iterations.
 */
function redactStructuralJson(text: string, literals: readonly string[]): string {
  let current = text;
  for (let i = 0; i < 3; i++) {
    const trimmed = current.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return redactLiterals(JSON.stringify(redactJsonNode(parsed)), literals);
      } catch {
        // not parseable as-is — fall through to the unescape attempt
      }
    }
    if (current.includes('\\"')) {
      const unescaped = current.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (unescaped !== current) {
        current = unescaped;
        continue;
      }
    }
    break;
  }
  return current;
}

/** Base64 alphabet, >=20 chars, optional `=`/`==` padding — a likely encoded blob. */
const BASE64_SHAPED = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Pass 3 helper (F001): find base64-shaped runs, decode them, and if the
 * decoded text contains a known literal secret, collapse the ENTIRE encoded run
 * to `***`. Padding (`=`) is matched explicitly so an over-greedy `=` cannot
 * break the redactor or leave a tail uncovered.
 */
function redactBase64Values(text: string, literals: readonly string[]): string {
  if (literals.length === 0) return text;
  return text.replace(BASE64_SHAPED, (candidate) => {
    let decoded: string;
    try {
      decoded = Buffer.from(candidate, 'base64').toString('utf8');
    } catch {
      return candidate;
    }
    const norm = (s: string): string => s.replace(/=+$/, '');
    if (norm(Buffer.from(decoded, 'utf8').toString('base64')) !== norm(candidate)) {
      return candidate; // not a clean round-trip — leave as-is
    }
    return literals.some((lit) => decoded.includes(lit)) ? REDACTED : candidate;
  });
}

/**
 * Pass (h) helper (F001): redact YAML block scalars. A header line
 * `KEY: |` / `KEY: >` (with optional chomping/indent indicators) whose KEY is
 * secret-named is followed by more-indented continuation lines holding the
 * value; collapse each continuation line's content to `***` while keeping its
 * indentation. Non-secret block headers are left untouched.
 */
function redactYamlBlockScalars(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const headerRe = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*[|>][+-]?\s*$/;
  let i = 0;
  while (i < lines.length) {
    const m = headerRe.exec(lines[i]);
    if (m && isSecretKey(m[2])) {
      const headerIndent = m[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim().length === 0) {
          j++;
          continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent <= headerIndent) break;
        lines[j] = `${line.slice(0, indent)}${REDACTED}`;
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return lines.join('\n');
}

/** Thrown when a flyctl invocation exceeds {@link FLY_TIMEOUT_MS}. */
export class FlyctlTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlyctlTimeoutError';
    Object.setPrototypeOf(this, FlyctlTimeoutError.prototype);
  }
}

/**
 * Thrown when `registryFor` fails for any reason other than a
 * {@link RegistryParseError} (F005). Its message is ALWAYS run through the
 * redactor so a raw error that embedded a secret cannot leak via `flip()`'s
 * rethrow. The original error is attached as `cause` WITHOUT its (possibly
 * secret-bearing) message — only its name/constructor is preserved for triage.
 */
export class AutoFlipperRegistryError extends Error {
  /** Non-sensitive class name of the original error (no message retained). */
  readonly causeName: string;
  constructor(message: string, causeName: string) {
    super(message);
    this.name = 'AutoFlipperRegistryError';
    this.causeName = causeName;
    Object.setPrototypeOf(this, AutoFlipperRegistryError.prototype);
  }
}

/**
 * Allowlist of cause-class names that are safe to surface verbatim in
 * `causeName` (F002). An attacker (or accidental upstream) can throw
 * `class SecretValueABC123 extends Error {}` and `error.constructor.name` would
 * otherwise leak that name into log/audit output. Any name NOT in this set is
 * replaced with `"UnknownError"`, and the chosen name is additionally run
 * through the value-aware redactor before assignment (defence in depth, R125).
 */
export const SAFE_CAUSE_NAMES: ReadonlySet<string> = new Set([
  'RegistryParseError',
  'SyntaxError',
  'TypeError',
  'Error',
  'RangeError',
]);

/**
 * Map an arbitrary thrown error to a SAFE, redacted cause name (F002). Returns
 * one of {@link SAFE_CAUSE_NAMES} verbatim, or `"UnknownError"` for anything
 * else; the result is always passed through the value-aware redactor so a name
 * that itself embeds a plan secret cannot leak.
 */
export function safeCauseName(err: unknown, secretValues?: ReadonlyArray<string>): string {
  const raw = err instanceof Error ? err.constructor.name : typeof err;
  const allowed = SAFE_CAUSE_NAMES.has(raw) ? raw : 'UnknownError';
  return redactSecretValues(allowed, secretValues);
}

/** The value a switch should hold in prod, derived from its prod_default. */
export type TargetValue = 'true' | 'false';

/** One reason a candidate row was excluded from the set plan. */
export type SkipReason = 'not-auto-flip' | 'needs-human-judgement' | 'already-current';

/** A row paired with the value it should hold in prod. */
export interface PlannedRow {
  row: RegistryRow;
  target: TargetValue;
  /**
   * The current Fly value observed at plan time (`undefined` when missing).
   * Used by the optional commit-time TOCTOU recheck to detect drift between
   * plan and commit before mutating.
   */
  was: string | undefined;
}

/** A row excluded from flipping, with the reason why. */
export interface SkippedRow {
  row: RegistryRow;
  reason: SkipReason;
}

/** Partition of the registry against the current Fly secret state. */
export interface FlipPlan {
  /** Rows whose Fly value is missing or stale and would be set. */
  to_set: PlannedRow[];
  /** Rows whose Fly value already matches the target. */
  already_set: PlannedRow[];
  /** Rows deliberately not auto-flipped (with reason). */
  to_skip: SkippedRow[];
}

/** A flip that failed to apply, with the captured (redacted) error context. */
export interface FailedFlip {
  row: RegistryRow;
  error: string;
}

/** Why a planned set was not applied at commit time. */
export type CommitSkipReason = 'current state changed since plan' | 'forced over changed state';

/** A planned set that commit deliberately did not apply (TOCTOU recheck). */
export interface CommitSkippedFlip {
  row: RegistryRow;
  reason: CommitSkipReason;
}

/** Outcome of a commit run. */
export interface FlipResult {
  succeeded: RegistryRow[];
  failed: FailedFlip[];
  /** Rows skipped at commit time because Fly state drifted since plan. */
  skipped: CommitSkippedFlip[];
}

/** Structured, secret-free audit entry emitted per flip (jsonl). */
export interface AuditEntry {
  operator: string;
  action: 'set';
  key: string;
  before: 'missing' | 'stale';
  after: 'set';
  timestamp: string;
}

/** Current Fly secret state: map of secret name -> current digest/value. */
export type FlySecrets = Readonly<Record<string, string>>;

/** Injectable sink so tests can capture audit/log output without stdout. */
export type LogSink = (line: string) => void;

/** Injectable flyctl runner; the default uses execFileSync (no shell). */
export type FlyRunner = (args: readonly string[]) => void;

/**
 * Optional commit-time recheck of the live Fly value for a key. Returns the
 * current value (or `undefined` if unset). Used to detect drift between plan
 * and commit; we await it so it may be sync or async.
 */
export type RecheckCurrent = (key: string) => Promise<string | undefined>;

export interface PlanOptions {
  registry: readonly RegistryRow[];
  current: FlySecrets;
}

export interface CommitOptions {
  plan: FlipPlan;
  env?: NodeJS.ProcessEnv;
  /** Defaults to runFlyctl (execFileSync). Override in tests. */
  run?: FlyRunner;
  /** Defaults to a no-op. Receives redacted log + jsonl audit lines. */
  log?: LogSink;
  /** Clock injection for deterministic audit timestamps in tests. */
  now?: () => Date;
  /**
   * Optional TOCTOU guard. When provided, commit re-reads each key's live Fly
   * value immediately before setting it; if that value no longer equals the
   * `was` captured at plan time, the row is skipped (unless {@link force}).
   * When omitted, commit preserves the original blind-apply behaviour and logs
   * a single warning that no recheck is configured.
   */
  recheckCurrent?: RecheckCurrent;
  /** Apply planned sets even when {@link recheckCurrent} reports drift. */
  force?: boolean;
  /**
   * Explicit opt-in to real mutation (F004). `flip()` is dry-run BY DEFAULT and
   * commits only when BOTH this is `true` AND the {@link AUTO_FLIP_ENV} env gate
   * is set. Setting the env flag alone is NOT enough — a stray env var must
   * never mutate prod without an explicit API request.
   */
  commit?: boolean;
  /**
   * Explicit opt-out of dry-run (F004), equivalent to `commit: true`. Provided
   * for callers that think in terms of `dryRun: false`. When set to `false` it
   * authorises the commit (still subject to the env gate); the default
   * (`undefined`/`true`) keeps dry-run behaviour.
   */
  dryRun?: boolean;
}

/** Map a row's prod_default onto the concrete value it should hold in prod. */
export function targetValueFor(row: RegistryRow): TargetValue | null {
  if (row.prod_default === 'ON') return 'true';
  if (row.prod_default === 'OFF') return 'false';
  return null; // MUST_SET / STUB_ALLOWED — not auto-flippable.
}

/**
 * Partition the registry against the current Fly secret values. Pure and
 * mutation-free: callers inspect the plan before deciding to commit.
 */
export function plan(opts: PlanOptions): FlipPlan {
  const to_set: PlannedRow[] = [];
  const already_set: PlannedRow[] = [];
  const to_skip: SkippedRow[] = [];
  for (const row of opts.registry) {
    if (!row.auto_flip_on_in_prod) {
      to_skip.push({ row, reason: 'not-auto-flip' });
      continue;
    }
    const target = targetValueFor(row);
    if (target === null) {
      to_skip.push({ row, reason: 'needs-human-judgement' });
      continue;
    }
    const current = opts.current[row.name];
    if (current === target) {
      already_set.push({ row, target, was: current });
      continue;
    }
    to_set.push({ row, target, was: current });
  }
  return { to_set, already_set, to_skip };
}

/** True when the env flag explicitly authorises real mutation. */
export function autoFlipEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[AUTO_FLIP_ENV] === 'true';
}

/**
 * Default flyctl runner: execFileSync with an explicit argv (no shell) and a
 * hard {@link FLY_TIMEOUT_MS} cap so a hung CLI cannot block the run forever.
 * On timeout the child is sent SIGTERM and we surface a {@link FlyctlTimeoutError}
 * whose message is built only from the (non-secret) subcommand verbs — never
 * from argv pairs that carry a `KEY=VALUE` secret.
 */
export function runFlyctl(args: readonly string[]): void {
  // F007: surface the PATH-dependency once if no absolute FLY_BIN was pinned,
  // before we hand a secret to a possibly-spoofable binary.
  warnIfPathResolvedFlyBin();
  // F003: TOCTOU revalidation — re-verify the cached canonical binary is still a
  // regular executable file before every invocation (no-op for the dev PATH
  // default). Refuses if the path was swapped since module load.
  assertFlyBinUnchanged();
  try {
    execFileSync(FLY_BIN, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FLY_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
  } catch (err: unknown) {
    if (isBinaryMissing(err)) {
      throw new Error(
        `${FLY_BIN} not found on PATH — install it (${FLY_INSTALL_DOCS}) before running --commit`,
      );
    }
    if (isTimeout(err)) {
      throw new FlyctlTimeoutError(
        `${FLY_BIN} ${flyArgvContext(args)} timed out after ${FLY_TIMEOUT_MS}ms and was sent SIGTERM`,
      );
    }
    // F001: seed the value-aware redactor with the literal secret values from
    // this invocation's argv so a stderr/message echo of the raw value is
    // scrubbed even when it carries no KEY=VAL shape.
    throw new Error(flyErrorMessage(err, argvSecretValues(args)));
  }
}

/**
 * Extract the literal VALUE side of each `KEY=VALUE` argv pair so the redactor
 * can scrub it from any error echo (F001). Never returns the KEY or the verbs.
 */
function argvSecretValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(a.slice(0, eq))) {
      const value = a.slice(eq + 1);
      if (value.length > 0) values.push(value);
    }
  }
  return values;
}

/** ENOENT from execFileSync means the binary is not installed. */
function isBinaryMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

/** Detect the execFileSync timeout/kill shape across its several variants. */
function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { signal?: unknown; killed?: unknown; code?: unknown };
  return e.signal === 'SIGTERM' || e.killed === true || e.code === 'ETIMEDOUT';
}

/**
 * Build a secret-free description of the argv for error context: keep only the
 * leading non-`KEY=VALUE` verbs (e.g. `secrets set`) and redact the rest. This
 * never emits a secret value even if the argv pair is present.
 */
function flyArgvContext(args: readonly string[]): string {
  const verbs = args.filter((a) => !/^[A-Z][A-Z0-9_]*\s*=/.test(a));
  return redactSecretValues(verbs.join(' ')) || 'secrets set';
}

/**
 * Extract a useful message from an execFileSync failure with the secret value
 * REDACTED. flyctl frequently echoes the offending `KEY=VALUE` back in its
 * stderr ("secret FEATURE_SECRET=true is rejected"), so every branch here runs
 * the text through {@link redactSecretValues} before returning it.
 */
export function flyErrorMessage(err: unknown, secretValues?: ReadonlyArray<string>): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    if (e.stderr != null) {
      const text = Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : String(e.stderr);
      const trimmed = text.trim();
      if (trimmed.length > 0) return redactSecretValues(trimmed, secretValues);
    }
    if (typeof e.message === 'string' && e.message.length > 0) {
      return redactSecretValues(e.message, secretValues);
    }
  }
  return `${FLY_BIN} secrets set failed`;
}

/**
 * Gather the literal secret values this plan will touch — every target value
 * about to be set plus every `was` value observed at plan time — so the
 * value-aware redactor (F001) can scrub them from ANY sink, even free-form
 * error text with no `KEY=VAL` shape. Returns a de-duplicated set.
 */
export function collectSecretValues(flipPlan: FlipPlan): Set<string> {
  const values = new Set<string>();
  const consider = (v: string | undefined): void => {
    if (typeof v === 'string' && v.length > 0) values.add(v);
  };
  for (const p of flipPlan.to_set) {
    consider(p.target);
    consider(p.was);
  }
  for (const p of flipPlan.already_set) {
    consider(p.target);
    consider(p.was);
  }
  return values;
}

/** Build the structured, secret-free jsonl audit line for one flip. */
export function auditEntry(
  row: RegistryRow,
  before: AuditEntry['before'],
  now: () => Date,
): AuditEntry {
  return {
    operator: AUDIT_OPERATOR,
    action: 'set',
    key: row.name,
    before,
    after: 'set',
    timestamp: now().toISOString(),
  };
}

/**
 * Module-local serialization chain (F006). The per-row loop is already
 * sequential WITHIN one `commit()` call, but two CONCURRENT callers could
 * previously interleave their flyctl invocations, violating the file-level
 * "one inflight flyctl at a time" invariant. This promise chain serializes
 * every `commit()` body across callers in the same process: each call awaits
 * the previous one before running and releases the next when it settles.
 */
let _commitChain: Promise<unknown> = Promise.resolve();

/**
 * Execute the plan's `to_set` flips. Refuses unless READINESS_AUTO_FLIP=true.
 * Runs strictly sequentially — and serialized ACROSS concurrent callers (F006)
 * — so the "one inflight flyctl at a time" invariant holds even when two
 * callers race. One failing flip does not abort the rest. Never logs a secret
 * value: every sink is routed through the value-aware redactor seeded with this
 * plan's literal secret values (F001).
 */
export async function commit(opts: CommitOptions): Promise<FlipResult> {
  const env = opts.env ?? process.env;
  if (!autoFlipEnabled(env)) {
    throw new Error(
      `refusing to commit: set ${AUTO_FLIP_ENV}=true to authorise real flyctl secret mutation (dry-run only otherwise)`,
    );
  }
  // F006: take a slot on the serialization chain before doing any work, and
  // release the next caller only after this call fully settles.
  const prev = _commitChain;
  let release!: () => void;
  _commitChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await doCommit(opts);
  } finally {
    release();
  }
}

/** The actual per-row commit work, run under the {@link _commitChain} mutex. */
async function doCommit(opts: CommitOptions): Promise<FlipResult> {
  const run = opts.run ?? runFlyctl;
  const now = opts.now ?? (() => new Date());
  // F001: literal secret values this plan touches, so the redactor can scrub
  // them from ANY sink even when they appear with no KEY=VAL shape.
  const allSecretValues = collectSecretValues(opts.plan);
  // Single redacting sink: EVERY log/audit line flows through here.
  const rawLog = opts.log ?? (() => undefined);
  const log = (line: string): void => rawLog(redactSecretValues(line, allSecretValues));
  const succeeded: RegistryRow[] = [];
  const failed: FailedFlip[] = [];
  const skipped: CommitSkippedFlip[] = [];
  // TOCTOU guard: without a recheck callback we apply blindly (legacy
  // behaviour) but record a single warning so the operator knows drift was
  // not verified. The warning carries no secret value.
  if (opts.recheckCurrent === undefined && opts.plan.to_set.length > 0) {
    log('warning: no recheckCurrent configured — applying plan without TOCTOU re-verification');
  }
  for (const planned of opts.plan.to_set) {
    const { row, target, was } = planned;
    // F003: derive `before` from the PLAN's observed value (planned.was), not
    // from local `env` presence. `env` is the process environment, not the Fly
    // secret state, so `row.name in env` mislabels operators. `was === undefined`
    // means the key was absent at plan time (missing); any value means stale.
    const before: AuditEntry['before'] = was === undefined ? 'missing' : 'stale';
    // Commit-time TOCTOU recheck: if the live value drifted from the value we
    // planned against, skip the set (unless force). Only the KEY is logged.
    if (opts.recheckCurrent !== undefined) {
      // F002: the recheck callback is awaited inside a redacting error boundary.
      // If it throws an error whose message embeds a bare secret or KEY=VAL, that
      // error previously propagated RAW and aborted the entire commit. Now we
      // redact it, record a failed entry, and CONTINUE — no other row is touched.
      let live: string | undefined;
      try {
        live = await opts.recheckCurrent(row.name);
      } catch (err: unknown) {
        const safe = redactSecretValues(
          err instanceof Error ? err.message : String(err),
          allSecretValues,
        );
        failed.push({ row, error: `recheck failed: ${safe}` });
        continue; // do NOT abort the whole commit
      }
      if (live !== was) {
        if (opts.force === true) {
          log(
            JSON.stringify({
              operator: AUDIT_OPERATOR,
              action: 'force',
              key: row.name,
              reason: 'forced over changed state',
              timestamp: now().toISOString(),
            }),
          );
        } else {
          log(
            JSON.stringify({
              operator: AUDIT_OPERATOR,
              action: 'skip',
              key: row.name,
              reason: 'current state changed since plan',
              timestamp: now().toISOString(),
            }),
          );
          skipped.push({ row, reason: 'current state changed since plan' });
          continue;
        }
      }
    }
    // Redacted operator log — the value is NEVER emitted, only `KEY=***`.
    log(`flyctl secrets set ${row.name}=*** --app <prod>`);
    try {
      run(['secrets', 'set', `${row.name}=${target}`]);
      log(JSON.stringify(auditEntry(row, before, now)));
      succeeded.push(row);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      // Defence-in-depth (F001): redact pattern + value-based before this
      // message reaches result.failed[i].error so a custom runner that echoes a
      // secret — as KEY=VALUE or bare — cannot leak it.
      failed.push({ row, error: redactSecretValues(raw, allSecretValues) });
    }
  }
  return { succeeded, failed, skipped };
}

/**
 * Decide whether `flip()` should actually commit (F004). Dry-run is the
 * DEFAULT: a commit happens only when an explicit API opt-in (`commit === true`
 * or `dryRun === false`) is present AND the {@link AUTO_FLIP_ENV} env gate is
 * set to "true". Either alone yields a dry-run, so neither a stray env var nor
 * an API flag in a non-prod env can mutate secrets on its own.
 */
export function shouldCommit(
  opts: Pick<CommitOptions, 'commit' | 'dryRun'> | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const apiOptIn = opts?.commit === true || opts?.dryRun === false;
  return apiOptIn && autoFlipEnabled(env);
}

/**
 * Plan + (optionally) commit in one call. Dry-run by default (F004).
 *
 * `registryFor` may throw. A {@link RegistryParseError} is re-thrown with
 * auto-flipper context (its message is redacted as defence-in-depth). ANY other
 * error is wrapped in a typed {@link AutoFlipperRegistryError} whose message is
 * generic — the raw error text (which could embed a secret) is NEVER echoed;
 * only the original error's class name is preserved as non-sensitive cause
 * metadata (F005).
 */
export async function flip(
  registryFor: () => readonly RegistryRow[],
  current: FlySecrets,
  commitOpts?: Omit<CommitOptions, 'plan'>,
): Promise<{ plan: FlipPlan; result: FlipResult | null }> {
  let registry: readonly RegistryRow[];
  try {
    registry = registryFor();
  } catch (err: unknown) {
    if (err instanceof RegistryParseError) {
      // Known, structured parse error: keep the type + context, but still run
      // the (operator-authored) message through the redactor as belt-and-braces.
      throw new RegistryParseError(
        `auto-flipper could not load the registry: ${redactSecretValues(err.message)}`,
      );
    }
    // F005/F002: any other error may carry a secret in its message AND its
    // class NAME (an attacker can throw `class SecretValueABC extends Error{}`).
    // Do NOT echo the message; the cause name is allowlisted to a fixed set and
    // redacted against the known current Fly values before it is surfaced.
    const knownValues = Object.values(current).filter((v) => v.length > 0);
    const causeName = safeCauseName(err, knownValues);
    throw new AutoFlipperRegistryError(
      `auto-flipper could not load the registry (cause: ${causeName})`,
      causeName,
    );
  }
  const flipPlan = plan({ registry, current });
  const env = commitOpts?.env ?? process.env;
  if (!shouldCommit(commitOpts, env)) {
    return { plan: flipPlan, result: null };
  }
  return { plan: flipPlan, result: await commit({ ...commitOpts, plan: flipPlan }) };
}
