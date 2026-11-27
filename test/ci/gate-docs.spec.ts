// GATE-DOCS-BE: since #1261 (owner decision ALM-D7 op 2) the release evidence gate accepts a
// `production` environment with no required reviewer. These rows keep every doc and workflow comment
// that describes the deploy's human steps true to the gate.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string, keep: (p: string) => boolean): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = `${dir}/${name}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
  });

// Sentences that say a person approves each production deploy, or that the gate demands a reviewer.
const STALE: RegExp[] = [
  /environment\s+reviewer\s+must\s+approve/i,
  /lacks\s+a\s+required\s+reviewer/i,
  /already\s+has\s+required\s+reviewers/i,
  /required\s+reviewers\s+on\s+the\s+`production`\s+environment/i,
  /reviewers\s+\(once\s+configured\)\s+gate/i,
  /its\s+required\s+reviewers\s+gate/i,
];

// Also bound to `production`; what their comments should say waits on DECISIONS ALM-D11 (op 1 moves them
// to a new environment with a required reviewer, op 2 keeps them on dispatch). The job that follows the
// answer removes them from this list.
const AWAITING_ALM_D11 = new Set([
  '.github/workflows/fly-secrets-set.yml',
  '.github/workflows/fly-db-secrets-set.yml',
  '.github/workflows/fly-apple-signin-set.yml',
  '.github/workflows/fly-launch-env-set.yml',
  '.github/workflows/fly-recent-auth-set.yml',
  '.github/workflows/fly-env-truth.yml',
  '.github/workflows/house-seed.yml',
]);

const ROWS: { file: string; present: RegExp[]; absent?: RegExp[] }[] = [
  {
    file: 'docs/deploy-runbook.md',
    present: [/no\s+required\s+reviewer\s+since\s+2026-11-26/, /only\s+human\s+step/],
  },
  {
    file: '.github/workflows/fly-deploy.yml',
    present: [
      /missing\s+or\s+allows\s+admin\s+bypass/,
      /exists\s+with\s+admin\s+bypass\s+off/,
      /ALM-D7\s+op\s+2/,
    ],
  },
  {
    file: 'docs/delivery-controls.md',
    present: [/revert\s+#1261/, /standing\s+approval\s+for\s+every\s+deploy/],
    absent: [/approves\s+every\s+deploy\s+himself/],
  },
];

describe('GATE-DOCS-BE: the deploy docs say what the release gate does since #1261', () => {
  it.each(ROWS)('$file says it', ({ file, present, absent = [] }) => {
    const text = read(file);
    for (const re of present) expect(text).toMatch(re);
    for (const re of absent) expect(text).not.toMatch(re);
  });

  it('no doc, workflow or script says a reviewer approves each production deploy', () => {
    const files = [
      ...walk('docs', (p) => p.endsWith('.md')),
      ...walk('.github/workflows', (p) => /\.ya?ml$/.test(p)),
      ...walk('scripts', (p) => p.endsWith('.sh')),
    ].filter((p) => !AWAITING_ALM_D11.has(p));
    const hits = files.flatMap((p) =>
      STALE.filter((re) => re.test(read(p))).map((re) => `${p} ${re}`),
    );
    expect(hits).toEqual([]);
  });
});
