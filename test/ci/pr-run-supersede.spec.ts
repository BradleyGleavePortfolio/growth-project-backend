// CI-SUPERSEDED-BE: a new commit on a pull request cancels that pull request's
// older workflow runs; a push to main, a schedule or a manual run is never
// grouped, queued behind another run or cancelled.
//
// Why: the account's GitHub Actions run at the 20-job cap, and an older head's
// runs hold runner slots that the newest head and main need.
//
// The rule, for every workflow whose on: includes pull_request:
//   concurrency:
//     group: <prefix>-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}
//     cancel-in-progress: ${{ github.event_name == 'pull_request' }}
// A pull_request run joins its pull request's group and cancels the older run
// there. Any other event gets a group of its own run id, so it shares a group
// with nothing. A group keyed on github.ref is refused: on main it would put
// every main run in one group, where a newer main run replaces a pending one.
//
// pr-size-labeler is the one shape difference. pascalgn/size-label-action
// v0.5.4 labels only on opened, synchronize and reopened; for edited it logs
// "Action will be ignored" and does nothing (index.js at the tag). So an
// edited run takes a group of its own run id too: a title edit must never
// cancel the labelling run of a new commit.
//
// Nine workflows had a group before this change; each is pinned exactly as it
// is, so a later edit to any of them is seen here.
//
// The blocks are read as text and also evaluated for every event each workflow
// runs on, by a small evaluator for the part of GitHub's expression syntax the
// blocks use (context paths, 'strings', ==, !=, !, &&, ||, parentheses), with
// GitHub's rules: && and || return an operand, a missing property is null, and
// strings compare without case.

import { readdirSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, '.github', 'workflows');

type Job = { name?: string; if?: unknown; strategy?: { matrix?: Record<string, unknown> } };
type Workflow = {
  name?: string;
  on?: unknown;
  true?: unknown; // a YAML 1.1 reader may turn a bare `on:` key into true
  concurrency?: unknown;
  jobs?: Record<string, Job>;
};

const CANCEL_ON_PR = "${{ github.event_name == 'pull_request' }}";
const prGroup = (prefix: string) =>
  `${prefix}\${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}`;

/** The three workflows this change groups, with their exact blocks. */
const SUPERSEDED: Record<string, { group: string; cancel: string }> = {
  'ci.yml': { group: prGroup('ci-pr-'), cancel: CANCEL_ON_PR },
  'codeql.yml': { group: prGroup('codeql-pr-'), cancel: CANCEL_ON_PR },
  'pr-size-labeler.yml': {
    group:
      "pr-size-${{ github.event_name == 'pull_request' && github.event.action != 'edited' && github.event.pull_request.number || github.run_id }}",
    cancel: CANCEL_ON_PR,
  },
};

/** Workflows that already had a group at 27be6474, pinned as they are. */
const PINNED: Record<string, { group: string; cancel: boolean }> = {
  'danger.yml': { group: 'danger-${{ github.ref }}', cancel: true },
  'dependency-audit.yml': { group: 'dependency-audit-${{ github.ref }}', cancel: true },
  'h4-readiness.yml': { group: 'h4-readiness-${{ github.ref }}', cancel: true },
  'infra-lint.yml': { group: 'infra-lint-${{ github.ref }}', cancel: true },
  'migration-dry-run.yml': { group: 'migration-dry-run-${{ github.ref }}', cancel: true },
  'migration-order.yml': { group: 'migration-order-${{ github.ref }}', cancel: true },
  'r100-quality-gate.yml': { group: 'r100-quality-gate-${{ github.ref }}', cancel: true },
  'sbom.yml': { group: 'sbom-${{ github.ref }}', cancel: false },
  'schema-parity.yml': { group: 'schema-parity-${{ github.ref }}', cancel: true },
};

const workflowFiles = () =>
  readdirSync(DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
const readWorkflow = (f: string) => parseYaml(readFileSync(join(DIR, f), 'utf8')) as Workflow;
const triggers = (wf: Workflow): Record<string, unknown> => {
  const on = wf.on ?? wf.true;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), null]));
  return on && typeof on === 'object' ? (on as Record<string, unknown>) : {};
};
const runsOnPullRequest = (wf: Workflow) => 'pull_request' in triggers(wf);
const block = (wf: Workflow) =>
  wf.concurrency && typeof wf.concurrency === 'object'
    ? (wf.concurrency as Record<string, unknown>)
    : undefined;

/** The pull_request actions a workflow runs on (GitHub's default when no types). */
function prActions(wf: Workflow): string[] {
  const pr = triggers(wf).pull_request as { types?: string[] } | null | undefined;
  return pr?.types ?? ['opened', 'synchronize', 'reopened'];
}

// ---- a small evaluator for GitHub expressions --------------------------------

type Value = string | number | boolean | null;
type Context = { github: Record<string, unknown> };

function tokenize(src: string): string[] {
  const re = /\s*(==|!=|&&|\|\||!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*)/y;
  const out: string[] = [];
  let i = 0;
  while (src.slice(i).trim() !== '') {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read the expression at "${src.slice(i)}"`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

function evaluate(src: string, ctx: Context): Value {
  const toks = tokenize(src);
  let p = 0;
  const truthy = (v: Value) => v !== null && v !== false && v !== 0 && v !== '';
  const lookup = (path: string): Value => {
    if (path === 'true' || path === 'false') return path === 'true';
    if (path === 'null') return null;
    let cur: unknown = ctx;
    for (const key of path.split('.')) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    }
    return cur === undefined ? null : (cur as Value);
  };
  const equal = (a: Value, b: Value) =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const primary = (): Value => {
    const t = toks[p++];
    if (t === undefined) throw new Error(`expression ends early: ${src}`);
    if (t === '!') return !truthy(primary());
    if (t === '(') {
      const v = or();
      if (toks[p++] !== ')') throw new Error(`missing ) in ${src}`);
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`unexpected "${t}" in ${src}`);
  };
  const comparison = (): Value => {
    let v = primary();
    while (toks[p] === '==' || toks[p] === '!=') {
      const op = toks[p++];
      const r = primary();
      v = op === '==' ? equal(v, r) : !equal(v, r);
    }
    return v;
  };
  const and = (): Value => {
    let v = comparison();
    while (toks[p] === '&&') {
      p++;
      const r = comparison();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (toks[p] === '||') {
      p++;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const v = or();
  if (p !== toks.length) throw new Error(`unread tokens in ${src}`);
  return v;
}

/** A string with ${{ }} parts, as GitHub turns it into the group name. */
const interpolate = (s: string, ctx: Context) =>
  s.replace(/\$\{\{([^}]*)\}\}/g, (_, e: string) => {
    const v = evaluate(e, ctx);
    return v === null ? '' : String(v);
  });
/** cancel-in-progress: a YAML boolean, or one whole ${{ }} expression. */
function cancelValue(raw: unknown, ctx: Context): boolean {
  if (typeof raw === 'boolean') return raw;
  const m = typeof raw === 'string' ? /^\$\{\{(.*)\}\}$/.exec(raw.trim()) : null;
  if (!m)
    throw new Error(`cancel-in-progress is neither a boolean nor one expression: ${String(raw)}`);
  const v = evaluate(m[1], ctx);
  return v !== null && v !== false && v !== 0 && v !== '';
}

const prRun = (runId: string, pr: number, action: string): Context => ({
  github: {
    event_name: 'pull_request',
    run_id: runId,
    ref: `refs/pull/${pr}/merge`,
    head_ref: 'feature/x',
    event: { action, pull_request: { number: pr } },
  },
});
const otherRun = (runId: string, event: string): Context => ({
  github: { event_name: event, run_id: runId, ref: 'refs/heads/main', head_ref: '', event: {} },
});

/** [group, cancel-in-progress] GitHub would compute for one run of a workflow. */
function computed(wf: Workflow, ctx: Context): [string, boolean] {
  const b = block(wf);
  if (!b) throw new Error('no top-level concurrency block');
  return [interpolate(String(b.group), ctx), cancelValue(b['cancel-in-progress'], ctx)];
}

// ---- the rule ----------------------------------------------------------------

/** Every way a pull_request workflow's block breaks the rule (empty = follows it). */
function ruleBreaks(f: string, wf: Workflow): string[] {
  const b = block(wf);
  if (!b) return [`${f}: no top-level concurrency block`];
  const out: string[] = [];
  const keys = Object.keys(wf);
  if (!(keys.indexOf('concurrency') < keys.indexOf('jobs')))
    out.push(`${f}: block is not above jobs:`);
  if (Object.keys(b).sort().join(',') !== 'cancel-in-progress,group') {
    out.push(`${f}: block keys are ${Object.keys(b).join(',')}`);
  }
  const group = typeof b.group === 'string' ? b.group : '';
  if (!group.includes('github.event.pull_request.number')) out.push(`${f}: group has no PR number`);
  if (!/\|\|\s*github\.run_id\s*\}\}$/.test(group))
    out.push(`${f}: group does not fall back to github.run_id`);
  if (/\bgithub\.(head_)?ref/.test(group))
    out.push(`${f}: group reads github.ref or github.head_ref`);
  if (b['cancel-in-progress'] !== CANCEL_ON_PR) {
    out.push(`${f}: cancel-in-progress is ${JSON.stringify(b['cancel-in-progress'])}`);
  }
  for (const [ev] of Object.entries(triggers(wf)).filter(([e]) => e !== 'pull_request')) {
    const [g1, c1] = computed(wf, otherRun('1001', ev));
    const [g2] = computed(wf, otherRun('1002', ev));
    if (g1 === g2) out.push(`${f}: two ${ev} runs share the group ${g1}`);
    if (c1) out.push(`${f}: a ${ev} run cancels another run`);
  }
  return out;
}

describe('pull request runs: a newer commit cancels the older runs; main, schedule and manual runs are never grouped', () => {
  const files = workflowFiles();
  const prWorkflows = files.filter((f) => runsOnPullRequest(readWorkflow(f)));

  it('every workflow that runs on pull_request has a top-level concurrency block', () => {
    expect(prWorkflows.filter((f) => !block(readWorkflow(f)))).toEqual([]);
  });

  it('ci.yml, codeql.yml and pr-size-labeler.yml carry exactly the per-PR block', () => {
    const got = Object.fromEntries(
      Object.keys(SUPERSEDED).map((f) => {
        const b = block(readWorkflow(f));
        return [f, b ? { group: b.group, cancel: b['cancel-in-progress'] } : 'no block'];
      }),
    );
    expect(got).toEqual(SUPERSEDED);
    for (const f of Object.keys(SUPERSEDED)) expect(prWorkflows).toContain(f);
  });

  it('every pull_request workflow not pinned below follows the rule (PR number, run_id fallback, no github.ref, cancel only on pull_request)', () => {
    const breaks = prWorkflows
      .filter((f) => !(f in PINNED))
      .flatMap((f) => ruleBreaks(f, readWorkflow(f)));
    expect(breaks).toEqual([]);
  });

  it('the nine workflows that were already grouped keep their group and cancel value', () => {
    const got = Object.fromEntries(
      Object.keys(PINNED).map((f) => {
        const b = block(readWorkflow(f));
        return [f, b ? { group: b.group, cancel: b['cancel-in-progress'] } : 'no block'];
      }),
    );
    expect(got).toEqual(PINNED);
    for (const f of Object.keys(PINNED)) expect(prWorkflows).toContain(f);
  });

  it('evaluated: two runs of one PR share a group and the newer cancels; another PR, another workflow or a non-PR run never shares it', () => {
    for (const f of Object.keys(SUPERSEDED)) {
      const wf = readWorkflow(f);
      const prefix = String(block(wf)?.group ?? '').split('${{')[0];
      const [older, cOlder] = computed(wf, prRun('2001', 42, 'synchronize'));
      const [newer, cNewer] = computed(wf, prRun('2002', 42, 'synchronize'));
      expect([f, older, cOlder]).toEqual([f, `${prefix}42`, true]);
      expect([f, newer, cNewer]).toEqual([f, `${prefix}42`, true]);
      for (const action of prActions(wf).filter((a) => a !== 'edited')) {
        expect([f, computed(wf, prRun('2003', 42, action))]).toEqual([f, [`${prefix}42`, true]]);
      }
      expect(computed(wf, prRun('2004', 43, 'synchronize'))[0]).toBe(`${prefix}43`);
      for (const ev of Object.keys(triggers(wf)).filter((e) => e !== 'pull_request')) {
        expect([f, ev, computed(wf, otherRun('3001', ev))]).toEqual([
          f,
          ev,
          [`${prefix}3001`, false],
        ]);
      }
    }
    // One PR's runs of different workflows never share a group.
    const groups = Object.keys(SUPERSEDED).map(
      (f) => computed(readWorkflow(f), prRun('2001', 42, 'synchronize'))[0],
    );
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('pr-size-labeler: an edited run never joins the PR group, so a title edit cannot cancel the labelling run of a new commit', () => {
    const wf = readWorkflow('pr-size-labeler.yml');
    expect(prActions(wf)).toEqual(['opened', 'synchronize', 'reopened', 'edited']);
    // The action this exception rests on (it labels only opened, synchronize, reopened).
    const steps = JSON.stringify(wf.jobs?.['size-label']);
    expect(steps).toContain('pascalgn/size-label-action@v0.5.4');
    const [labelling] = computed(wf, prRun('4001', 42, 'synchronize'));
    const [edited, cEdited] = computed(wf, prRun('4002', 42, 'edited'));
    expect(labelling).toBe('pr-size-42');
    expect(edited).toBe('pr-size-4002');
    expect(edited).not.toBe(labelling);
    expect(cEdited).toBe(true); // alone in its own group, so it cancels nothing
  });

  it('no two workflows can compute the same group (no static prefix is a prefix of another)', () => {
    const prefixes = files.flatMap((f) => {
      const g = block(readWorkflow(f))?.group;
      return typeof g === 'string' ? [[f, g.split('${{')[0]] as const] : [];
    });
    const clashes = prefixes.flatMap(([f, a]) =>
      prefixes.filter(([h, b]) => h !== f && b.startsWith(a)).map(([h]) => `${f} / ${h}`),
    );
    expect(clashes).toEqual([]);
  });

  it('the release gate inputs are unchanged: ci.yml, codeql.yml and sbom.yml still run on every push to main, with no branch or path change', () => {
    expect(triggers(readWorkflow('ci.yml'))).toEqual({
      pull_request: null,
      push: { branches: ['main'] },
      workflow_dispatch: null,
    });
    expect(triggers(readWorkflow('codeql.yml'))).toEqual({
      pull_request: { branches: ['main'] },
      push: { branches: ['main'] },
      schedule: [{ cron: '0 6 * * 1' }],
    });
    expect(triggers(readWorkflow('sbom.yml'))).toEqual({
      pull_request: { branches: ['main'] },
      push: { branches: ['main'], tags: ['v*.*.*'] },
      workflow_dispatch: null,
    });
    expect(triggers(readWorkflow('pr-size-labeler.yml'))).toEqual({
      pull_request: { types: ['opened', 'synchronize', 'reopened', 'edited'] },
    });
  });

  it('no workflow, job or check is renamed, and no job gains an if:', () => {
    const shape = (f: string) => {
      const wf = readWorkflow(f);
      return {
        name: wf.name,
        jobs: Object.entries(wf.jobs ?? {}).map(([id, j]) => [id, j.name ?? null, j.if ?? null]),
      };
    };
    expect(shape('ci.yml')).toEqual({
      name: 'CI',
      jobs: [
        ['build-and-test', null, null],
        ['rls-floor-guard', null, null],
        ['rls-live-tests', null, null],
        ['community-live-tests', null, null],
        ['mwb-3-live-tests', null, null],
        ['speed-test', 'Speed test, 45 clients (not required)', null],
        ['all-switches-on', 'All switches on (not required) (${{ matrix.shard }}/4)', null],
      ],
    });
    expect(shape('codeql.yml')).toEqual({
      name: 'codeql',
      jobs: [['analyze', 'CodeQL JS/TS', null]],
    });
    expect(shape('pr-size-labeler.yml')).toEqual({
      name: 'pr-size-labeler',
      jobs: [['size-label', null, null]],
    });
  });

  it('negative controls: the rule sees a github.ref group, cancel: true, a lost run_id fallback and a removed block', () => {
    // ci.yml with the given block placed above jobs:, whatever the file holds.
    const { jobs, ...head } = readWorkflow('ci.yml');
    const withBlock = (concurrency: unknown): Workflow => ({ ...head, concurrency, jobs });
    const ok = { group: prGroup('ci-pr-'), 'cancel-in-progress': CANCEL_ON_PR };
    expect(ruleBreaks('ci.yml', withBlock(ok))).toEqual([]);
    // (a) keyed on github.ref: main runs would share one group.
    expect(
      ruleBreaks('ci.yml', withBlock({ ...ok, group: 'ci-pr-${{ github.ref }}' })).join('\n'),
    ).toMatch(/reads github\.ref[\s\S]*two push runs share the group ci-pr-refs\/heads\/main/);
    // (b) cancel-in-progress: true would cancel on main too.
    expect(
      ruleBreaks('ci.yml', withBlock({ ...ok, 'cancel-in-progress': true })).join('\n'),
    ).toMatch(/cancel-in-progress is true[\s\S]*a push run cancels another run/);
    // (c) no run_id fallback: every main run lands in the group "ci-pr-false".
    const noFallback = {
      ...ok,
      group: "ci-pr-${{ github.event_name == 'pull_request' && github.event.pull_request.number }}",
    };
    expect(ruleBreaks('ci.yml', withBlock(noFallback)).join('\n')).toMatch(
      /does not fall back to github\.run_id[\s\S]*two push runs share the group ci-pr-false/,
    );
    // (d) the block removed.
    const { concurrency: _removed, ...bare } = readWorkflow('codeql.yml');
    void _removed;
    expect(ruleBreaks('codeql.yml', bare)).toEqual(['codeql.yml: no top-level concurrency block']);
    // The evaluator: && and || return an operand, a missing property is null.
    const push = otherRun('7', 'push');
    expect(
      evaluate("github.event_name == 'pull_request' && github.event.pull_request.number", push),
    ).toBe(false);
    expect(
      evaluate("github.event_name == 'PULL_REQUEST' || github.run_id", prRun('8', 1, 'opened')),
    ).toBe(true);
    expect(evaluate("!(github.event.action != 'edited')", prRun('8', 1, 'edited'))).toBe(true);
    expect(evaluate('github.event.pull_request.number || github.run_id', push)).toBe('7');
  });
});
