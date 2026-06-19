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
 * Resolve the flyctl binary path from `FLY_BIN`, validating it at module load
 * (F007 — R24/R58/R95). A PATH-resolved binary on a secret-mutating path is a
 * spoof vector: anything earlier on PATH named `flyctl` would receive every
 * secret over argv. So:
 *   - An explicit `FLY_BIN` MUST be an absolute path — a relative override is
 *     rejected at load time (it is almost certainly a mistake or an attack).
 *   - The bare default `flyctl` is still permitted for local/dev ergonomics,
 *     but emits a one-time WARN on first use so operators see the PATH
 *     dependency and pin an absolute path in CI/staging/prod.
 */
function resolveFlyBin(env: NodeJS.ProcessEnv): string {
  const override = env[FLY_BIN_ENV];
  if (override !== undefined && override !== FLY_BIN_DEFAULT) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `${FLY_BIN_ENV} must be an absolute path (got "${override}"); a PATH-relative ` +
          `flyctl is a spoof vector on a secret-mutating path. Set ${FLY_BIN_ENV} to an ` +
          `absolute binary path, or unset it to fall back to PATH-resolved "${FLY_BIN_DEFAULT}".`,
      );
    }
    return override;
  }
  return FLY_BIN_DEFAULT;
}

/** Binary we shell out to; an absolute `FLY_BIN` override, else PATH-resolved `flyctl`. */
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

  // Pass 1 — value-based: replace every known literal secret wherever it
  // appears (longest first so a value that is a prefix of another is not
  // partially revealed). Empty/whitespace-only values are ignored.
  if (secretValues !== undefined) {
    const literals = Array.from(new Set(Array.from(secretValues)))
      .filter((v) => v.trim().length > 0)
      .sort((a, b) => b.length - a.length);
    for (const literal of literals) {
      out = out.replace(new RegExp(escapeRegExp(literal), 'g'), REDACTED);
    }
  }

  // Pass 2 — pattern-based, applied in most-specific-first order.

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

  return out;
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
    throw new Error(flyErrorMessage(err));
  }
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
export function flyErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    if (e.stderr != null) {
      const text = Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : String(e.stderr);
      const trimmed = text.trim();
      if (trimmed.length > 0) return redactSecretValues(trimmed);
    }
    if (typeof e.message === 'string' && e.message.length > 0) {
      return redactSecretValues(e.message);
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
    // F005: any other error may carry a secret in its message. Do NOT echo it.
    const causeName = err instanceof Error ? err.name : typeof err;
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
