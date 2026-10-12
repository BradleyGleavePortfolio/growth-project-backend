// O2 (REL-09): an alert reaches the owner when production is down or failing.
// Parses the REAL workflow and runs the REAL script with fake curl, gh and
// sleep first on PATH, so no network, GitHub or production call is made.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load as parseYaml } from 'js-yaml';

const ROOT = join(__dirname, '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'production-uptime.yml');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'production-uptime.sh');
const BODY_MARKER = 'RESPONSE-BODY-MUST-NOT-BE-PRINTED';

// Fake curl answers the next code from $CODES (one per call); "000" is a
// connection failure (curl exits 7). Whatever -o names receives a body.
const FAKE_CURL = `#!/usr/bin/env bash
n=$(cat "$FAKE/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/n"
read -r -a codes <<< "$CODES"; code="\${codes[$n]:-200}"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
echo "${BODY_MARKER}" > "\${out:-/dev/stdout}"
printf '%s' "$code"; [ "$code" = "000" ] && exit 7; exit 0
`;
const FAKE_GH = `#!/usr/bin/env bash
args="$*"; printf '%s\\n' "\${args//$'\\n'/ }" >> "$FAKE/gh.log"
[ "$1 $2" = "issue list" ] && printf '%s\\n' "$OPEN_ISSUE"; exit 0
`;
const FAKE_SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$FAKE/sleep.log"
`;

function run(codes: string, openIssue = '') {
  const fake = fs.mkdtempSync(join(tmpdir(), 'uptime-'));
  for (const [name, body] of Object.entries({ curl: FAKE_CURL, gh: FAKE_GH, sleep: FAKE_SLEEP }))
    fs.writeFileSync(join(fake, name), body, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: `${fake}:${process.env.PATH}`,
      FAKE: fake,
      CODES: codes,
      OPEN_ISSUE: openIssue,
      OWNER: 'repo-owner',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '99',
    },
  });
  const read = (f: string) =>
    fs.existsSync(join(fake, f)) ? fs.readFileSync(join(fake, f), 'utf8') : '';
  const writes = read('gh.log')
    .split('\n')
    .filter((l) => l && !l.startsWith('issue list'));
  return { status: r.status, out: r.stdout + r.stderr, writes, sleeps: read('sleep.log') };
}

describe('production uptime workflow', () => {
  const wf = parseYaml(fs.readFileSync(WORKFLOW, 'utf8')) as {
    on: { schedule: { cron: string }[] };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
  };
  const text = fs.readFileSync(WORKFLOW, 'utf8') + fs.readFileSync(SCRIPT, 'utf8');

  it('runs every 10 minutes with only contents: read and issues: write', () => {
    expect(wf.on.schedule).toEqual([{ cron: '*/10 * * * *' }]);
    expect(wf.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('uses only the default token: no secrets, no fly commands', () => {
    expect(text).not.toMatch(/secrets\.|flyctl|\bfly\s+(deploy|ssh|logs|status|secrets)/);
    const step = Object.values(wf.jobs)[0].steps.find((s) =>
      s.run?.includes('production-uptime.sh'),
    );
    expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
  });

  it('probes the production URL that the fly-deploy smoke test uses', () => {
    const deploy = fs.readFileSync(join(ROOT, '.github', 'workflows', 'fly-deploy.yml'), 'utf8');
    const url = /url: (https:\/\/\S+\.fly\.dev)/.exec(deploy)?.[1];
    expect(url).toBe('https://backend-spring-lake-3890.fly.dev');
    expect(fs.readFileSync(SCRIPT, 'utf8')).toContain(`BASE_URL="\${BASE_URL:-${url}}"`);
  });
});

describe('production uptime script', () => {
  it('healthy: no issue is touched and no retry wait', () => {
    const r = run('200 200');
    expect([r.status, r.writes, r.sleeps]).toEqual([0, [], '']);
    expect(r.out).toContain('/health 200; /readyz 200');
  });

  it('one failed round then a pass (a blip): no issue', () => {
    const r = run('200 503 200 200');
    expect([r.status, r.writes, r.sleeps]).toEqual([0, [], '60\n']);
  });

  it('two failed rounds in a row: opens one production-down issue assigned to the owner', () => {
    const r = run('200 503 200 503');
    expect(r.status).toBe(0);
    expect(r.writes[0]).toMatch(/^label create production-down /);
    expect(r.writes[1]).toMatch(
      /^issue create --title Production is down: health checks are failing --label production-down --assignee repo-owner --body /,
    );
    expect(r.writes[1]).toContain('Results: /health 200; /readyz 503');
    expect(r.writes[1]).toContain('https://github.com/o/r/actions/runs/99');
    expect(r.writes).toHaveLength(2);
  });

  it('no answer at all (connection failure) counts as down', () => {
    const r = run('000 000 000 000');
    expect(r.writes[1]).toContain('Results: /health 000; /readyz 000');
  });

  it('still down with an open issue: refreshes that issue, opens no second one', () => {
    const r = run('503 503 503 503', '42');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^issue edit 42 --body /);
  });

  it('recovered with an open issue: closes it with a comment', () => {
    const r = run('200 200', '42');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(
      /^issue close 42 --comment Recovered: \/health 200; \/readyz 200 at \S+Z\./,
    );
  });

  it('never prints a response body', () => {
    for (const r of [run('200 200'), run('503 503 503 503'), run('200 200', '42')])
      expect(r.out).not.toContain(BODY_MARKER);
  });
});
