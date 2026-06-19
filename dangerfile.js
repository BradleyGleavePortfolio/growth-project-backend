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

const { danger, message, warn, fail, markdown, schedule } = require('danger');

// ---------- 1) Risk markers ----------
// Include deleted_files: a removed migration / auth / billing file is at
// least as risky as a new one and must still trigger its warning.
const touched = [
  ...danger.git.modified_files,
  ...danger.git.created_files,
  ...danger.git.deleted_files,
];
const deleted = danger.git.deleted_files;

const touchedMigrations = touched.some((f) => f.startsWith('prisma/migrations/'));
const touchedPrismaSchema = touched.includes('prisma/schema.prisma');
const touchedEnvValidation = touched.includes('src/common/env-validation.ts');
const touchedAuth = touched.some((f) => /\bsrc\/auth\b/.test(f) || /\bsrc\/.*oauth\b/.test(f));
const touchedRls = touched.some((f) => /rls|policy|rbac/i.test(f));
const touchedBilling = touched.some((f) => f.startsWith('src/billing/') || f.startsWith('src/stripe'));
const touchedWebhooks = touched.some((f) => /webhook/i.test(f));
const touchedRules = touched.some((f) => /AGENT_RULES\.md$|ENGINEERING_RULES\.md$/.test(f));

if (touchedMigrations) warn('🛢 This PR touches **prisma/migrations/**. Confirm `down.sql` exists or `-- IRREVERSIBLE: <reason>` is present (R106).');
if (deleted.some((f) => f.startsWith('prisma/migrations/'))) warn('🗑 This PR **deletes** files under **prisma/migrations/**. Deleting a shipped migration can desync environments — confirm this is intentional and coordinated (R106).');
if (deleted.some((f) => /\bsrc\/auth\b/.test(f) || /\bsrc\/.*oauth\b/.test(f))) warn('🗑 This PR **deletes** files under **src/auth**. Removing auth code can silently drop a security control — extra scrutiny.');
if (deleted.some((f) => f.startsWith('src/billing/') || f.startsWith('src/stripe'))) warn('🗑 This PR **deletes** files under **src/billing**. Confirm no live payment path is being removed.');
if (touchedPrismaSchema && !touchedMigrations) warn('📐 You changed **prisma/schema.prisma** without a matching migration. Did you run `prisma migrate dev`?');
if (touchedEnvValidation) warn('🔐 You changed **env-validation.ts**. Boot-time invariant change — extra scrutiny.');
if (touchedAuth) warn('🔑 This PR touches **auth/oauth** code. Pair with a unit test that exercises an expired-token path.');
if (touchedRls) warn('🛡 This PR touches **RLS / policy** code. Run `npm run test:rls-mwb2-concurrency` locally.');
if (touchedBilling) warn('💳 This PR touches **billing/stripe**. Idempotency keys and webhook signatures present?');
if (touchedWebhooks) warn('📬 This PR touches **webhook** code. Replay-protected? Signature-verified? Returns 200 even on duplicate?');
if (touchedRules) warn('📜 This PR edits the **rule doctrine**. Operator review required. Mention rationale in PR body.');

// ---------- 2) PR hygiene ----------
const CONVENTIONAL_RE = /^(feat|fix|perf|deps|revert|docs|refactor|test|build|ci|chore)(\([^)]+\))?!?:\s/;

// Resolve the subject release-please will actually parse for the SemVer bump.
// Prefer the PR title, but fall back to the latest commit's first line: some
// CI hosts (mirrors / proxies) hydrate danger.github.pr.title as undefined
// even though the commit DSL is fully populated, and release-please reads the
// commit subjects anyway. Squash-merge uses the PR title; merge-commit uses
// the commit subjects — both are valid sources, so accept either.
const prTitle = (danger.github.pr && danger.github.pr.title) || '';
const commits = danger.git.commits || [];
const latestCommitSubject = commits.length
  ? String(commits[commits.length - 1].message || '').split('\n')[0]
  : '';
const conventionalSubject = CONVENTIONAL_RE.test(prTitle)
  ? prTitle
  : (CONVENTIONAL_RE.test(latestCommitSubject) ? latestCommitSubject : '');

if (!prTitle && !latestCommitSubject) {
  // Neither source is available (CI could not hydrate the PR/commit DSL).
  // Don't hard-fail on missing data — surface it as a nudge instead.
  warn('Could not read the PR title or commit subjects to validate Conventional Commits format. Verify the title parses for release-please.');
} else if (!conventionalSubject) {
  fail(
    'PR title is not Conventional Commits format. release-please reads commit messages / PR titles to compute SemVer bumps. ' +
    'Expected: `feat: …`, `fix: …`, `feat(billing)!: …`, etc. See .release-please-config.json.'
  );
}

const prBody = (danger.github.pr && danger.github.pr.body) || '';
if (prBody.length < 80) {
  warn('PR description is short. Use the PR template — describe what changed, why, and the test plan.');
}

// Conventional Commits permits a `BREAKING CHANGE:` footer in the body even
// when the title has no `!`. release-please parses that footer for the major
// bump, but the title regex above would not surface it — so warn explicitly.
if (prBody.includes('BREAKING CHANGE:')) {
  warn('This PR contains a **BREAKING CHANGE:** footer. Confirm the major version bump is intentional and the migration/rollback path is documented.');
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
// Wrapped in Danger's `schedule()` rather than an async IIFE + .then(): the
// previous .then() could fire after Danger had already flushed its messages,
// so the warning silently never appeared. `schedule` is the documented async
// hook — Danger awaits every scheduled closure before flushing. (Dangerfiles
// are evaluated as scripts, not ES modules, so top-level await is unavailable.)
// Errors are surfaced via warn() instead of being swallowed, so a failed
// diffForFile is visible in the Danger output rather than counting as 0.
schedule(async () => {
  let n = 0;
  for (const f of touched.filter((f) => /\.(ts|tsx|js)$/.test(f))) {
    try {
      const diff = await danger.git.diffForFile(f);
      if (!diff) continue;
      const matches = (diff.added.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []).length;
      n += matches;
    } catch (err) {
      warn(`Could not diff ${f} for TODO density: ${err && err.message ? err.message : String(err)}`);
    }
  }
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
