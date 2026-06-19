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
import type { RegistryRow } from './registry-loader';
import { RegistryParseError } from './registry-loader';

/** Env flag that must equal "true" before any real secret mutation runs. */
export const AUTO_FLIP_ENV = 'READINESS_AUTO_FLIP';
/** Operator recorded in the audit trail; matches the repo's commit identity. */
export const AUDIT_OPERATOR = 'Bradley Gleave';
/** Binary we shell out to; resolved on PATH by execFileSync. */
export const FLY_BIN = 'flyctl';
/** Where to point operators when flyctl is not installed. */
export const FLY_INSTALL_DOCS = 'https://fly.io/docs/flyctl/install/';
/** Hard cap on a single flyctl invocation so a hung CLI cannot block forever. */
export const FLY_TIMEOUT_MS = 60_000;
/** The token every redacted secret value collapses to — value is never emitted. */
export const REDACTED = '***';

/**
 * Replace every `KEY=VALUE` pair (env-style, `--secret KEY=VALUE`, or single/
 * double quoted) with `KEY=***` so a secret value can never reach a log line,
 * an Error message, or an audit record. The value is collapsed entirely — we
 * deliberately do NOT keep a prefix of it, because even a few characters of a
 * real secret are a leak. KEY matches an UPPER_SNAKE identifier; the value runs
 * up to the next whitespace or matching quote and is dropped wholesale.
 */
export function redactSecretValues(text: string): string {
  if (text.length === 0) return text;
  let out = text;
  // Quoted forms first: 'KEY=value with spaces' or "KEY=..." — drop to closing quote.
  out = out.replace(/(['"])([A-Z][A-Z0-9_]*)\s*=\s*[^'"]*\1/g, `$1$2=${REDACTED}$1`);
  // Bare env-style pairs: KEY=value (value is any run of non-space, non-quote chars).
  out = out.replace(/\b([A-Z][A-Z0-9_]*)\s*=\s*[^\s'"]+/g, `$1=${REDACTED}`);
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
 * Execute the plan's `to_set` flips. Refuses unless READINESS_AUTO_FLIP=true.
 * Runs strictly sequentially; one failing flip does not abort the rest. Never
 * logs a secret value — only `KEY=***` and the structured audit entry (which
 * carries the key name, never the value).
 */
export async function commit(opts: CommitOptions): Promise<FlipResult> {
  const env = opts.env ?? process.env;
  if (!autoFlipEnabled(env)) {
    throw new Error(
      `refusing to commit: set ${AUTO_FLIP_ENV}=true to authorise real flyctl secret mutation (dry-run only otherwise)`,
    );
  }
  const run = opts.run ?? runFlyctl;
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
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
    const before: AuditEntry['before'] = row.name in env ? 'stale' : 'missing';
    // Commit-time TOCTOU recheck: if the live value drifted from the value we
    // planned against, skip the set (unless force). Only the KEY is logged.
    if (opts.recheckCurrent !== undefined) {
      const live = await opts.recheckCurrent(row.name);
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
      // Defence-in-depth: redact before this message reaches result.failed[i].error
      // so a custom runner that echoes a `KEY=VALUE` cannot leak the value.
      failed.push({ row, error: redactSecretValues(raw) });
    }
  }
  return { succeeded, failed, skipped };
}

/**
 * Plan + (optionally) commit in one call. `registryFor` resolves the rows and
 * may throw a RegistryParseError, which we re-throw with auto-flipper context
 * so the caller sees where the failure surfaced.
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
      throw new RegistryParseError(`auto-flipper could not load the registry: ${err.message}`);
    }
    throw err;
  }
  const flipPlan = plan({ registry, current });
  const env = commitOpts?.env ?? process.env;
  if (!autoFlipEnabled(env)) {
    return { plan: flipPlan, result: null };
  }
  return { plan: flipPlan, result: await commit({ ...commitOpts, plan: flipPlan }) };
}
