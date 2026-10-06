// scripts/setup-branch-protection.sh — the required-check list is exactly the
// 11 contexts live branch protection on main requires.
//
// EXPECTED_REQUIRED_CHECKS was read back from
//   gh api repos/BradleyGleavePortfolio/growth-project-backend/branches/main/protection
// on 2026-10-02 after 16:41 PDT (required_status_checks.checks, all app_id
// 15368 = GitHub Actions), in the order GitHub returns them. "Schema parity
// (migrations match schema.prisma)" is the 10th (operator ruling OR-110-3);
// "community-live-tests" is the 11th (owner 2026-10-02 16:38: "Add
// community-live-tests as a required check on backend main").
//
// The payload (strict, admins, reviews, linear history OFF, conversation
// resolution OFF, ...) is pinned to the live read-back of 2026-10-02 13:27 PDT.
//
// The script is never executed here. Only its REQUIRED_CHECKS=( ... ) array
// block (and, for the payload, the block from the array through the jq PAYLOAD
// assignment, which runs no network command) is evaluated by bash (so comments and quoting are read exactly as the
// script would read them); nothing else in the script runs and no network
// call is made.

import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = 'scripts/setup-branch-protection.sh';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const EXPECTED_REQUIRED_CHECKS = [
  'build-and-test',
  'rls-floor-guard',
  'rls-live-tests',
  'mwb-3-live-tests',
  'npm audit (high+critical, whole graph)',
  'CodeQL JS/TS (javascript-typescript)',
  'Banned cast tokens (R75 / R100.A2)',
  'build-sbom',
  'danger',
  'Schema parity (migrations match schema.prisma)',
  'community-live-tests',
];

function arrayBlock(script: string): string {
  const start = script.indexOf('\nREQUIRED_CHECKS=(\n');
  if (start < 0) throw new Error('REQUIRED_CHECKS=( block not found');
  const end = script.indexOf('\n)\n', start);
  if (end < 0) throw new Error('REQUIRED_CHECKS block is not closed');
  return script.slice(start + 1, end + 2);
}

/** Evaluate ONLY the array block with bash and return its elements. */
function scriptRequiredChecks(script: string): string[] {
  const block = arrayBlock(script);
  const r = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `set -euo pipefail\n${block}\nprintf '%s\\n' "\${REQUIRED_CHECKS[@]}"`,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
  );
  if (r.status !== 0) throw new Error(`bash failed: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

/**
 * Evaluate the script from its REQUIRED_CHECKS block through the PAYLOAD
 * assignment (array, input checks, CHECKS_JSON, code-owner switch, jq payload)
 * and print PAYLOAD. Only bash builtins, grep and jq run: the backup GET and
 * the PUT come after this block and are never reached.
 */
function scriptPayload(script: string, reviewCount: string): Record<string, unknown> {
  const start = script.indexOf('\nREQUIRED_CHECKS=(\n');
  const marker = "\n  }')\n";
  const end = script.indexOf(marker, script.indexOf('\nPAYLOAD=$(jq -n', start));
  if (start < 0 || end < 0) throw new Error('payload block not found');
  const block = script.slice(start + 1, end + marker.length);
  expect(block).not.toMatch(/curl|GH_TOKEN|PROTECTION_URL/);
  const r = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-c', `set -euo pipefail\n${block}\nprintf '%s' "$PAYLOAD"`],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        REQUIRED_APPROVING_REVIEW_COUNT: reviewCount,
        CHECKS_APP_ID: '15368',
      },
    },
  );
  if (r.status !== 0) throw new Error(`bash failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

// Live protection on main, read back 2026-10-02 13:35 PDT and again after the
// 16:41 PDT check addition (linear history and conversation resolution both
// off; the 13:27 linear-history change was reverted because it lacked the
// owner's explicit words; only the checks list changed at 16:41).
const LIVE_MIRROR_PAYLOAD = {
  required_status_checks: {
    strict: true,
    checks: EXPECTED_REQUIRED_CHECKS.map((context) => ({ context, app_id: 15368 })),
  },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 0,
    require_last_push_approval: false,
  },
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false,
};

type Workflow = {
  on?: unknown;
  true?: unknown; // js-yaml (YAML 1.1) may read a bare `on:` key as boolean true
  jobs?: Record<
    string,
    { name?: string; if?: unknown; strategy?: { matrix?: Record<string, unknown> } }
  >;
};

/** The check-run names a workflow's jobs report (name, or job id; plus matrix values). */
function reportedNames(wf: Workflow): string[] {
  return reportingJobs(wf).map(([name]) => name);
}

/** [reported check-run name, job] pairs for every job of a workflow. */
function reportingJobs(wf: Workflow): Array<[string, NonNullable<Workflow['jobs']>[string]]> {
  return Object.entries(wf.jobs ?? {}).flatMap(([id, job]) => {
    const base = job.name ?? id;
    const matrix = job.strategy?.matrix;
    if (!matrix || /\$\{\{/.test(base)) return [[base, job]];
    const dims = Object.entries(matrix).filter(([k]) => k !== 'include' && k !== 'exclude');
    if (dims.length !== 1 || !Array.isArray(dims[0][1])) return [[base, job]];
    return (dims[0][1] as unknown[]).map((v): [string, typeof job] => [
      `${base} (${String(v)})`,
      job,
    ]);
  });
}

/** True when the workflow runs on every pull request to main (no paths filter). */
function runsOnEveryPrToMain(wf: Workflow): boolean {
  const on = wf.on ?? wf.true;
  if (on === 'pull_request') return true;
  if (Array.isArray(on)) return on.includes('pull_request');
  if (!on || typeof on !== 'object' || !('pull_request' in on)) return false;
  const pr = (on as Record<string, unknown>).pull_request as Record<string, unknown> | null;
  if (!pr) return true;
  if ('paths' in pr || 'paths-ignore' in pr) return false;
  if ('branches-ignore' in pr) return false;
  const branches = pr.branches as string[] | undefined;
  return !branches || branches.includes('main');
}

describe('setup-branch-protection.sh — required checks and payload equal live branch protection', () => {
  const script = read(SCRIPT);
  const checks = scriptRequiredChecks(script);

  it('lists exactly the 11 live required checks, in the live order', () => {
    expect(checks).toEqual(EXPECTED_REQUIRED_CHECKS);
    expect(checks).toHaveLength(11);
    expect(new Set(checks).size).toBe(checks.length);
  });

  it('includes the schema-parity gate under its exact job name', () => {
    expect(checks).toContain('Schema parity (migrations match schema.prisma)');
    const wf = parseYaml(read('.github/workflows/schema-parity.yml')) as Workflow;
    expect(reportedNames(wf)).toContain('Schema parity (migrations match schema.prisma)');
    expect(runsOnEveryPrToMain(wf)).toBe(true);
  });

  it('includes community-live-tests as the ci.yml job that runs on every pull request, unconditionally', () => {
    expect(checks[checks.length - 1]).toBe('community-live-tests');
    const wf = parseYaml(read('.github/workflows/ci.yml')) as Workflow;
    expect(runsOnEveryPrToMain(wf)).toBe(true);
    const job = reportingJobs(wf).find(([name]) => name === 'community-live-tests');
    expect(job).toBeDefined();
    expect(job?.[1].if).toBeUndefined();
  });

  it('does not list checks that are informational, never run on a PR, retired, or path-filtered', () => {
    for (const notRequired of [
      'test-deploy-readiness',
      'deploy-readiness-gate',
      'LOC budget',
      'Test density',
      'shellcheck (scripts/*.sh)',
      'actionlint (.github/workflows/*.yml)',
      'danger dry-run (dangerfile.js)',
    ]) {
      expect(checks).not.toContain(notRequired);
    }
  });

  it('every listed check is reported by a workflow job that runs on every pull request to main', () => {
    const dir = join(ROOT, '.github', 'workflows');
    const workflows = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => ({ f, wf: parseYaml(readFileSync(join(dir, f), 'utf8')) as Workflow }));
    const missing = checks.filter(
      (c) => !workflows.some(({ wf }) => runsOnEveryPrToMain(wf) && reportedNames(wf).includes(c)),
    );
    expect(missing).toEqual([]);
  });

  it('every listed check is reported by a job with no job-level if: (a skipped job would satisfy the requirement)', () => {
    const dir = join(ROOT, '.github', 'workflows');
    const workflows = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => parseYaml(readFileSync(join(dir, f), 'utf8')) as Workflow);
    const conditional = (wfs: Workflow[]) => {
      const jobs = wfs.filter((wf) => runsOnEveryPrToMain(wf)).flatMap((wf) => reportingJobs(wf));
      return checks.filter((c) => jobs.some(([name, job]) => name === c && job.if !== undefined));
    };
    expect(conditional(workflows)).toEqual([]);
    // Negative control: a job-level if: on community-live-tests is detected.
    const ci = parseYaml(read('.github/workflows/ci.yml')) as Workflow;
    const gated: Workflow = {
      ...ci,
      jobs: {
        ...ci.jobs,
        'community-live-tests': {
          ...ci.jobs?.['community-live-tests'],
          if: "github.event_name == 'push'",
        },
      },
    };
    expect(conditional([gated])).toEqual(['community-live-tests']);
  });

  it('the evaluated block is the one the script uses (count echo and app-bound payload read the same array)', () => {
    expect(script).toMatch(
      /printf '%s\\n' "\$\{REQUIRED_CHECKS\[@\]\}" \| jq -R \. \| jq -s --argjson app "\$CHECKS_APP_ID"/,
    );
    expect(script).toContain('echo "Required checks (${#REQUIRED_CHECKS[@]}):"');
    expect(script.match(/^REQUIRED_CHECKS=\(/gm)).toHaveLength(1);
    expect(script).not.toMatch(/REQUIRED_CHECKS\+=/);
  });

  it('negative control: the evaluator sees a removed or added check', () => {
    const minusParity = script.replace(
      /^\s*"Schema parity \(migrations match schema\.prisma\)"\n/m,
      '',
    );
    expect(scriptRequiredChecks(minusParity)).not.toContain(
      'Schema parity (migrations match schema.prisma)',
    );
    const plusExtra = script.replace(
      '\nREQUIRED_CHECKS=(\n',
      '\nREQUIRED_CHECKS=(\n  "test-deploy-readiness"\n',
    );
    expect(scriptRequiredChecks(plusExtra)).toHaveLength(12);
    const minusCommunity = script.replace(/^\s*"community-live-tests"\n/m, '');
    expect(scriptRequiredChecks(minusCommunity)).not.toContain('community-live-tests');
    expect(scriptRequiredChecks(minusCommunity)).toHaveLength(10);
    expect(scriptRequiredChecks(minusCommunity)).not.toEqual(EXPECTED_REQUIRED_CHECKS);
    // A commented-out line is not a check.
    const commented = script.replace(/^(\s*)"danger"$/m, '$1# "danger"');
    expect(scriptRequiredChecks(commented)).not.toContain('danger');
  });

  it('the payload mirrors live protection exactly (linear history OFF, conversation resolution OFF)', () => {
    const payload = scriptPayload(script, '0');
    expect(payload).toEqual(LIVE_MIRROR_PAYLOAD);
    expect(payload.required_linear_history).toBe(false);
    expect(payload.required_conversation_resolution).toBe(false);
  });

  it('with a second maintainer (count 1) only the review fields change', () => {
    const payload = scriptPayload(script, '1');
    expect(payload).toEqual({
      ...LIVE_MIRROR_PAYLOAD,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      },
    });
  });

  it('negative control: the payload evaluator sees a flipped linear-history or conversation-resolution flag', () => {
    const linear = script.replace(
      'required_linear_history: false,',
      'required_linear_history: true,',
    );
    expect(scriptPayload(linear, '0').required_linear_history).toBe(true);
    const conv = script.replace(
      'required_conversation_resolution: false,',
      'required_conversation_resolution: true,',
    );
    expect(scriptPayload(conv, '0').required_conversation_resolution).toBe(true);
  });
});
