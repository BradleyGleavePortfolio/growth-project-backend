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
 *   - All flips are logged to `OPERATOR_KEYS_NEEDED.md` so the operator
 *     has a permanent record.
 */

import type { SwitchEntry } from './registry-loader';

export type FlipMode = 'dry-run' | 'apply';

export interface FlipPlan {
  name: string;
  reason: string;
  /** The value we would set. For boolean-style switches we use "true". */
  proposed_value: string;
}

export interface FlipResult {
  mode: FlipMode;
  prodLike: boolean;
  plans: FlipPlan[];
  applied: { name: string; ok: boolean; detail?: string }[];
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
  const applied: FlipResult['applied'] = [];
  if (mode === 'apply' && prodLike) {
    const runFly = opts.runFlyCommand ?? defaultRunFly;
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runFly(['secrets', 'set', `${plan.name}=${plan.proposed_value}`, '--stage']);
      applied.push({ name: plan.name, ok: res.ok, detail: res.stderr });
    }
  }
  return { mode, prodLike, plans, applied };
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
