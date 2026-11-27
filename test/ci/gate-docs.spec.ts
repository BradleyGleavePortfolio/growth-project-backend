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

// Still bound to `production` with its old comment: house-seed.yml moves to `production-secrets` in
// HOUSE-SEED-ENV-BE (DECISIONS ALM-D13), which removes it from this list. The other seven moved in
// PRODUCTION-SECRETS-ENV-BE (ALM-D11 op 1) and are swept like every other workflow.
const AWAITING_HOUSE_SEED_ENV = new Set(['.github/workflows/house-seed.yml']);

// ALM-D11 op 1: each moved workflow names its environment and the decision.
const MOVED_TO_SECRETS_ENV = [
  'fly-secrets-set',
  'fly-db-secrets-set',
  'fly-apple-signin-set',
  'fly-launch-env-set',
  'fly-recent-auth-set',
  'fly-env-sync',
  'fly-env-truth',
].map((f) => ({
  file: `.github/workflows/${f}.yml`,
  present: [/production-secrets/, /ALM-D11\s+op\s+1/],
}));

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
  ...MOVED_TO_SECRETS_ENV,
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
    ].filter((p) => !AWAITING_HOUSE_SEED_ENV.has(p));
    const hits = files.flatMap((p) =>
      STALE.filter((re) => re.test(read(p))).map((re) => `${p} ${re}`),
    );
    expect(hits).toEqual([]);
  });
});
