// dangerfile.js — R107 PR hygiene checks. Runs via `npx danger ci` in CI.
//
// Purpose: surface risk markers a human reviewer should know about, without
// blocking merge. (Hard fails belong in r100-quality-gate.yml; Danger is for
// soft signals — "you touched migrations + a controller in the same PR, are
// you sure?").
//
// Conventions are AGENT_RULES-aligned, but no rule here is enforced as a
// gate. The PR template + R100 checklist do the gating; Danger does the
// nudging.

const { danger, message, warn, fail, markdown } = require('danger');

// ---------- 1) Risk markers ----------
const touched = [...danger.git.modified_files, ...danger.git.created_files];

const touchedMigrations = touched.some((f) => f.startsWith('prisma/migrations/'));
const touchedPrismaSchema = touched.includes('prisma/schema.prisma');
const touchedEnvValidation = touched.includes('src/common/env-validation.ts');
const touchedAuth = touched.some((f) => /\bsrc\/auth\b/.test(f) || /\bsrc\/.*oauth\b/.test(f));
const touchedRls = touched.some((f) => /rls|policy|rbac/i.test(f));
const touchedBilling = touched.some((f) => f.startsWith('src/billing/') || f.startsWith('src/stripe'));
const touchedWebhooks = touched.some((f) => /webhook/i.test(f));
const touchedRules = touched.some((f) => /AGENT_RULES\.md$|ENGINEERING_RULES\.md$/.test(f));

if (touchedMigrations) warn('🛢 This PR touches **prisma/migrations/**. Confirm `down.sql` exists or `-- IRREVERSIBLE: <reason>` is present (R106).');
if (touchedPrismaSchema && !touchedMigrations) warn('📐 You changed **prisma/schema.prisma** without a matching migration. Did you run `prisma migrate dev`?');
if (touchedEnvValidation) warn('🔐 You changed **env-validation.ts**. Boot-time invariant change — extra scrutiny.');
if (touchedAuth) warn('🔑 This PR touches **auth/oauth** code. Pair with a unit test that exercises an expired-token path.');
if (touchedRls) warn('🛡 This PR touches **RLS / policy** code. Run `npm run test:rls-mwb2-concurrency` locally.');
if (touchedBilling) warn('💳 This PR touches **billing/stripe**. Idempotency keys and webhook signatures present?');
if (touchedWebhooks) warn('📬 This PR touches **webhook** code. Replay-protected? Signature-verified? Returns 200 even on duplicate?');
if (touchedRules) warn('📜 This PR edits the **rule doctrine**. Operator review required. Mention rationale in PR body.');

// ---------- 2) PR hygiene ----------
const titleLooksConventional = /^(feat|fix|perf|deps|revert|docs|refactor|test|build|ci|chore)(\([^)]+\))?!?:\s/.test(danger.github.pr.title);
if (!titleLooksConventional) {
  fail(
    'PR title is not Conventional Commits format. release-please reads commit messages / PR titles to compute SemVer bumps. ' +
    'Expected: `feat: …`, `fix: …`, `feat(billing)!: …`, etc. See .release-please-config.json.'
  );
}

if (danger.github.pr.body.length < 80) {
  warn('PR description is short. Use the PR template — describe what changed, why, and the test plan.');
}

// ---------- 3) Lockfile hygiene ----------
const touchedPackage = touched.includes('package.json');
const touchedLock = touched.includes('package-lock.json');
if (touchedPackage && !touchedLock) {
  fail('You changed **package.json** without updating **package-lock.json**. Run `npm install` and commit the lockfile.');
}
if (touchedLock && !touchedPackage) {
  message('Lockfile-only update — looks like a `npm install` ran cleanly. ✅');
}

// ---------- 4) Sensitive-file additions ----------
const addedSensitive = danger.git.created_files.filter((f) => /\.env(\.|$)|\.pem$|\.key$|\.crt$|secrets?\.json$/.test(f));
if (addedSensitive.length) {
  fail(`Sensitive file(s) added to the repo: ${addedSensitive.map((f) => '`' + f + '`').join(', ')}. Move secrets to Fly secrets, not git.`);
}

// ---------- 5) TODO / FIXME density ----------
const addedTodoCount = (async () => {
  let n = 0;
  for (const f of touched.filter((f) => /\.(ts|tsx|js)$/.test(f))) {
    try {
      const diff = await danger.git.diffForFile(f);
      if (!diff) continue;
      const matches = (diff.added.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []).length;
      n += matches;
    } catch (_) {
      /* file missing or binary — skip */
    }
  }
  return n;
})();

addedTodoCount.then((n) => {
  if (n >= 5) warn(`This PR introduces **${n}** new TODO/FIXME/XXX/HACK markers. Track them in BACKLOG.md or an issue, not as drive-by markers.`);
});

// ---------- 6) Friendly summary ----------
const summary = [
  `**Touched areas:** ${[
    touchedMigrations && 'migrations',
    touchedAuth && 'auth',
    touchedBilling && 'billing',
    touchedRls && 'rls',
    touchedWebhooks && 'webhooks',
    touchedRules && 'rules',
  ].filter(Boolean).join(', ') || '_none of the sensitive paths_'}`,
  `**Files changed:** ${touched.length}`,
];
markdown(`### Danger summary\n\n- ${summary.join('\n- ')}\n`);
