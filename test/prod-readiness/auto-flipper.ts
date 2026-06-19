/**
 * prod-readiness/auto-flipper.ts
 *
 * H4.B — Q9 case 1: "If something is flipped OFF — flip it on automatically
 * for production." Implements the auto-flip rule.
 *
 * Two modes:
 *
 *   1. dry-run (default): reports which switches WOULD be flipped, no
 *      action taken. Used by the test in CI to surface the would-be diff.
 *
 *   2. apply: shells out to `fly secrets set` for each switch whose
 *      auto_flip_on_in_prod=true is currently OFF/unset. Requires FLY_API_TOKEN
 *      in env; intended to be run from `npm run readiness:check:prod` by
 *      the operator OR by a dedicated GitHub Action with the token set.
 *
 * Safety:
 *   - Never auto-flips a `prod_default: MUST_SET` or `STUB_ALLOWED` switch
 *     — those require human judgment.
 *   - Only flips when target env is genuinely prod-like (NODE_ENV in
 *     {production, staging}).
 *   - apply mode requires FLY_APP_NAME (the target Fly app); absent, every
 *     flip fails fast with a clear error rather than shelling out blindly.
 *   - apply mode takes a single-holder file lock (F-A17) so two concurrent
 *     runs cannot race `fly secrets set` against each other.
 *   - On a successful flip, the in-process `env` is mutated (F-A12) so later
 *     checks in the SAME run observe the new value.
 *   - The structured `appliedFlips` result (F-A03) is returned to the caller,
 *     which records it in `OPERATOR_KEYS_NEEDED.md` and escalates the verdict
 *     if any flip failed. This module does NOT itself write that file — the
 *     prior JSDoc claimed it did, which was untrue (F-A03).
 */

import * as fs from 'fs';
import type { SwitchEntry } from './registry-loader';

/** Single-holder lock so concurrent apply runs cannot race (F-A17). */
export const LOCK_PATH = '/tmp/readiness-apply.lock';

export type FlipMode = 'dry-run' | 'apply';

export interface FlipPlan {
  name: string;
  reason: string;
  /** The value we would set. For boolean-style switches we use "true". */
  proposed_value: string;
}

export interface AppliedFlip {
  name: string;
  ok: boolean;
  error?: string;
}

export interface FlipResult {
  mode: FlipMode;
  prodLike: boolean;
  plans: FlipPlan[];
  /** Per-flip outcome for apply mode; empty in dry-run (F-A03). */
  appliedFlips: AppliedFlip[];
}

export interface AutoFlipOptions {
  switches: readonly SwitchEntry[];
  env?: NodeJS.ProcessEnv;
  mode?: FlipMode;
  /** Shell-out function; mockable in tests. */
  runFlyCommand?: (args: string[]) => Promise<{ ok: boolean; stderr?: string }>;
}

export async function autoFlip(opts: AutoFlipOptions): Promise<FlipResult> {
  const env = opts.env ?? process.env;
  const mode: FlipMode = opts.mode ?? 'dry-run';
  const prodLike = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  const plans: FlipPlan[] = [];
  for (const sw of opts.switches) {
    if (!sw.auto_flip_on_in_prod) continue;
    if (sw.prod_default !== 'OFF' && sw.prod_default !== 'ON') continue;
    if (sw.prod_default === 'OFF') {
      // OFF means the switch should default false; if a value is set to true
      // we flip it OFF. Otherwise no-op.
      const cur = env[sw.name];
      if (cur && cur !== 'false' && cur !== '0') {
        plans.push({
          name: sw.name,
          reason: `prod_default=OFF but env has "${cur}"; setting to "false".`,
          proposed_value: 'false',
        });
      }
      continue;
    }
    // prod_default === 'ON'
    const cur = env[sw.name];
    if (cur === undefined || cur === '' || cur === 'false' || cur === '0') {
      plans.push({
        name: sw.name,
        reason: `prod_default=ON but env is ${cur === undefined ? 'unset' : `"${cur}"`}; setting to "true".`,
        proposed_value: 'true',
      });
    }
  }
  const appliedFlips: AppliedFlip[] = [];
  if (mode === 'apply' && prodLike) {
    // FLY_APP_NAME is mandatory for `fly secrets set --app <name>` (F-A04).
    const flyApp = env.FLY_APP_NAME;
    if (!flyApp) {
      for (const plan of plans) {
        appliedFlips.push({ name: plan.name, ok: false, error: 'FLY_APP_NAME unset; cannot apply secrets' });
      }
      return { mode, prodLike, plans, appliedFlips };
    }

    // Single-holder lock (F-A17): refuse to apply if another run holds it.
    let lockHeld = false;
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      lockHeld = true;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'EEXIST') {
        for (const plan of plans) {
          appliedFlips.push({ name: plan.name, ok: false, error: 'another apply run in progress' });
        }
        return { mode, prodLike, plans, appliedFlips };
      }
      throw e;
    }

    try {
      const runFly = opts.runFlyCommand ?? defaultRunFly;
      for (const plan of plans) {
        // eslint-disable-next-line no-await-in-loop
        const res = await runFly(['secrets', 'set', `${plan.name}=${plan.proposed_value}`, '--app', flyApp]);
        if (res.ok) {
          // Mutate the in-process env so later same-run checks see the new
          // value (F-A12). proposed_value is always a concrete string here.
          env[plan.name] = plan.proposed_value;
          appliedFlips.push({ name: plan.name, ok: true });
        } else {
          appliedFlips.push({ name: plan.name, ok: false, error: res.stderr ?? 'flyctl exited non-zero' });
        }
      }
    } finally {
      if (lockHeld) {
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch {
          // Lock already removed; nothing to clean up.
        }
      }
    }
  }
  return { mode, prodLike, plans, appliedFlips };
}

async function defaultRunFly(args: string[]): Promise<{ ok: boolean; stderr?: string }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const proc = spawn('flyctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, stderr: stderr.trim() || undefined }));
    proc.on('error', (err) => resolve({ ok: false, stderr: err.message }));
  });
}
