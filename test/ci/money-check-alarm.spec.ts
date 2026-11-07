// MONEY-ALARM-BE (owner #202-E3, 202-S1 op 1): the daily money check's own
// alarm. Parses the REAL workflow and runs the REAL script with fake curl, gh
// and sleep first on PATH (real jq), so no network, GitHub or production call
// is made. Mirrors test/ci/production-uptime.spec.ts.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load as parseYaml } from 'js-yaml';

const ROOT = join(__dirname, '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'money-check-alarm.yml');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'money-check-alarm.sh');
const BODY_MARKER = 'RESPONSE-BODY-MUST-NOT-BE-PRINTED';
const STATUS_URL = 'https://backend-spring-lake-3890.fly.dev/api/money-check/status';
const RUN_URL = 'https://github.com/o/r/actions/runs/99';

/** One answer per curl call: "<code> <body>"; "000" is a connection failure (curl exits 7). */
const answer = (status: string, lastDay: string | null = '2026-11-06') =>
  `200 ${JSON.stringify({ status, lastDay, note: BODY_MARKER })}`;
const ON_TIME = answer('on_time');
const LATE = answer('late');
const OFF = answer('off');

// Fake curl prints "<body>\n<code>" like `curl -w '\n%{http_code}'`.
const FAKE_CURL = [
  '#!/usr/bin/env bash',
  'n=$(cat "$FAKE/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/n"',
  'line=$(printf \'%s\\n\' "$ANSWERS" | sed -n "$((n + 1))p")',
  'printf \'%s\\n\' "$*" >> "$FAKE/curl.log"',
  'code=${line%% *}; body=${line#* }',
  'if [ "$code" = 000 ]; then printf \'\\n000\'; exit 7; fi',
  'printf \'%s\\n%s\' "$body" "$code"',
  '',
].join('\n');
const FAKE_GH = [
  '#!/usr/bin/env bash',
  'args="$*"; printf \'%s\\n\' "${args//$\'\\n\'/ }" >> "$FAKE/gh.log"',
  '[ "$1 $2" = "issue list" ] && printf \'%s\\n\' "$OPEN_ISSUE"; exit 0',
  '',
].join('\n');
const FAKE_SLEEP = ['#!/usr/bin/env bash', 'echo "$1" >> "$FAKE/sleep.log"', ''].join('\n');

function run(answers: string[], openIssue = '') {
  const fake = fs.mkdtempSync(join(tmpdir(), 'money-alarm-'));
  for (const [name, body] of Object.entries({ curl: FAKE_CURL, gh: FAKE_GH, sleep: FAKE_SLEEP }))
    fs.writeFileSync(join(fake, name), body, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: `${fake}:${process.env.PATH}`,
      FAKE: fake,
      ANSWERS: answers.join('\n'),
      OPEN_ISSUE: openIssue,
      OWNER: 'repo-owner',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '99',
    },
  });
  const read = (f: string) =>
    fs.existsSync(join(fake, f)) ? fs.readFileSync(join(fake, f), 'utf8') : '';
  const gh = read('gh.log').split('\n').filter(Boolean);
  const writes = gh.filter((l) => !l.startsWith('issue list'));
  const curls = read('curl.log').split('\n').filter(Boolean);
  const sleeps = read('sleep.log');
  fs.rmSync(fake, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, gh, writes, sleeps, curls };
}

describe('money check alarm workflow', () => {
  const wf = parseYaml(fs.readFileSync(WORKFLOW, 'utf8')) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<
      string,
      {
        steps: {
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
          env?: Record<string, string>;
        }[];
      }
    >;
  };
  const text = fs.readFileSync(WORKFLOW, 'utf8') + fs.readFileSync(SCRIPT, 'utf8');
  const steps = Object.values(wf.jobs)[0].steps;

  it('runs every hour off minute 0 (and by hand) with only contents: read and issues: write', () => {
    expect(wf.on.schedule).toEqual([{ cron: '17 * * * *' }]);
    expect('workflow_dispatch' in wf.on).toBe(true);
    expect(wf.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(wf.concurrency).toEqual({ group: 'money-check-alarm', 'cancel-in-progress': false });
    expect(Object.keys(wf.jobs)).toHaveLength(1);
  });

  it('uses only the default token: no secrets, no fly commands, credentials not kept', () => {
    expect(text).not.toMatch(/secrets\.|flyctl|\bfly\s+(deploy|ssh|logs|status|secrets)/);
    const step = steps.find((s) => s.run?.includes('money-check-alarm.sh'));
    expect(step?.run).toBe('bash scripts/ci/money-check-alarm.sh');
    expect(step?.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      OWNER: '${{ github.repository_owner }}',
    });
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout?.with).toEqual({ 'persist-credentials': false });
  });

  it('reads the status route on the production URL that the fly-deploy smoke test uses', () => {
    const deploy = fs.readFileSync(join(ROOT, '.github', 'workflows', 'fly-deploy.yml'), 'utf8');
    const url = /url: (https:\/\/\S+\.fly\.dev)/.exec(deploy)?.[1];
    expect(url).toBe('https://backend-spring-lake-3890.fly.dev');
    const script = fs.readFileSync(SCRIPT, 'utf8');
    expect(script).toContain(`BASE_URL="\${BASE_URL:-${url}}"`);
    expect(script).toContain('STATUS_URL="${BASE_URL}/api/money-check/status"');
    // The route behind it: /api (the global prefix; money-check is not excluded) + money-check/status.
    const controller = fs.readFileSync(
      join(ROOT, 'src', 'checkout', 'money-check-status.controller.ts'),
      'utf8',
    );
    expect(controller).toContain("@Controller('money-check')");
    expect(controller).toContain("@Get('status')");
    const main = fs.readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    expect(main).toContain("app.setGlobalPrefix('api'");
    expect(main).not.toContain("'money-check");
  });

  it('is its own alarm: the uptime workflow and its production-down issue are not touched', () => {
    const uptime =
      fs.readFileSync(join(ROOT, '.github', 'workflows', 'production-uptime.yml'), 'utf8') +
      fs.readFileSync(join(ROOT, 'scripts', 'ci', 'production-uptime.sh'), 'utf8');
    expect(uptime).not.toMatch(/money/i);
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

describe('money check alarm script', () => {
  it('on time: one read, no issue touched, no retry wait', () => {
    const r = run([ON_TIME]);
    expect([r.status, r.writes, r.sleeps]).toEqual([0, [], '']);
    expect(r.curls).toEqual([`-s --max-time 20 -w \\n%{http_code} ${STATUS_URL}`]);
    expect(r.out).toMatch(/\S+Z money check: on_time \(HTTP 200\); last finished day: 2026-11-06/);
  });

  it('on time with an open issue: closes it with a comment (recovery)', () => {
    const r = run([ON_TIME], '42');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(
      /^issue close 42 --comment Recovered: the money check status is on time \(last finished day: 2026-11-06, UTC; checked \S+Z\)\. /,
    );
    expect(r.writes[0]).toContain(
      'A queued push does not prove that it reached your phone or that you read it.',
    );
    expect(r.writes[0]).toContain(`Run: ${RUN_URL}`);
  });

  it('late twice, 60 seconds apart: opens one money-check-late issue assigned to the owner', () => {
    const r = run([LATE, LATE]);
    expect([r.status, r.sleeps, r.curls.length]).toEqual([0, '60\n', 2]);
    expect(r.writes).toEqual([
      'label create money-check-late --color D93F0B --description The daily money check has not reported in 26 hours --force',
      expect.stringMatching(
        /^issue create --title Money check is late: no daily result in 26 hours --label money-check-late --assignee repo-owner --body /,
      ),
    ]);
    const body = r.writes[1];
    expect(body).toContain(
      'The daily money check has not finished with a notice to you in the last 26 hours.',
    );
    expect(body).toContain('- Last finished day: 2026-11-06 (UTC)');
    expect(body).toMatch(/- Checked: \S+Z, twice, 60 seconds apart/);
    expect(body).toContain(`- Status: ${STATUS_URL}`);
    expect(body).toContain(`- Run: ${RUN_URL}`);
    expect(body).toContain('This alarm counts a day only when that push was queued.');
    expect(body).toContain(
      'A queued push does not prove that it reached your phone or that you read it.',
    );
    // Plain words: no shell escapes reach the owner.
    expect(body).not.toMatch(/\\"|\\n/);
    expect(r.out).toContain(
      '::warning::The daily money check is late; last finished day: 2026-11-06',
    );
  });

  it('late, then on time on the second read (the run just finished): no issue', () => {
    const r = run([LATE, ON_TIME]);
    expect([r.status, r.writes, r.sleeps]).toEqual([0, [], '60\n']);
  });

  it('still late with an open issue: refreshes that issue, opens no second one', () => {
    const r = run([LATE, LATE], '42');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^issue edit 42 --body The daily money check has not finished/);
  });

  it('switched off: no issue is opened, and an open one is closed with a comment', () => {
    const quiet = run([OFF]);
    expect([quiet.status, quiet.writes, quiet.sleeps]).toEqual([0, [], '']);
    expect(quiet.out).toContain(
      "::notice::The daily money check is switched off (RECONCILIATION_DAILY_ENABLED is 'false').",
    );
    const open = run([OFF], '42');
    expect(open.writes).toHaveLength(1);
    expect(open.writes[0]).toMatch(
      /^issue close 42 --comment Switched off: the daily money check is off \(RECONCILIATION_DAILY_ENABLED is 'false'\), so it is not late; /,
    );
    expect(open.writes[0]).toContain('Last finished day: 2026-11-06 (UTC)');
  });

  it.each([
    ['a 503 (the status could not be read)', ['503 {}']],
    ['no answer at all (connection failure)', ['000']],
    ['a 404 (the route is missing)', ['404 Not Found']],
    ['a 200 that is not JSON', ['200 <html>maintenance</html>']],
    ['a 200 with an unknown state', [`200 {"status":"unknown","note":"${BODY_MARKER}"}`]],
    ['late, then unreadable on the second read', [LATE, '503 {}']],
  ])('%s: changes no issue, open or not, and says so', (_name, answers) => {
    for (const open of ['', '42']) {
      const r = run(answers, open);
      expect([r.status, r.writes]).toEqual([0, []]);
      expect(r.out).toMatch(
        /::warning::The money check status could not be read \(HTTP \d{3}\); no issue was changed\./,
      );
    }
  });

  it('no finished day on record (null or not a YYYY-MM-DD day) reads "none on record"', () => {
    for (const lastDay of [null, '2026-11-06T11:00:00Z', '<b>x</b>']) {
      const r = run([answer('late', lastDay), answer('late', lastDay)]);
      expect(r.writes[1]).toContain('- Last finished day: none on record (UTC)');
    }
  });

  it('never prints a response body, never reads /health or /readyz, never writes production-down', () => {
    const runs = [
      run([ON_TIME]),
      run([ON_TIME], '42'),
      run([LATE, LATE]),
      run([LATE, LATE], '42'),
      run([OFF], '42'),
      run([LATE, '503 {}'], '42'),
    ];
    for (const r of runs) {
      expect(r.out).not.toContain(BODY_MARKER);
      expect(r.gh.join('\n')).not.toContain(BODY_MARKER);
      expect(r.gh.join('\n')).not.toMatch(/production-down/);
      for (const c of r.curls) expect(c).toMatch(/ https:\/\/\S+\/api\/money-check\/status$/);
      expect(r.gh.every((l) => /^(issue (list|create|edit|close)|label create) /.test(l))).toBe(
        true,
      );
    }
  });
});
