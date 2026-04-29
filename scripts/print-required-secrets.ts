/**
 * scripts/print-required-secrets.ts
 *
 * Lists which env vars are required, prod-required, or optional for a given
 * NODE_ENV target — and which of those are currently *missing* from the
 * caller's environment. Reads the canonical ENV_RULES list from
 * `src/common/env-validation.ts` so this stays in sync with what the boot
 * actually enforces.
 *
 * Designed to be run *before* `fly secrets set` so the operator can see the
 * full set of names without needing to copy/paste from the deploy runbook.
 *
 * Usage:
 *   # Print rules for a staging deploy (default).
 *   npx ts-node scripts/print-required-secrets.ts
 *
 *   # Same but explicit.
 *   TARGET_ENV=staging npx ts-node scripts/print-required-secrets.ts
 *
 *   # Production rules.
 *   TARGET_ENV=production npx ts-node scripts/print-required-secrets.ts
 *
 *   # Emit as `fly secrets set` template (values are placeholders).
 *   TARGET_ENV=staging FORMAT=fly npx ts-node scripts/print-required-secrets.ts
 *
 *   # Emit as a .env stub.
 *   TARGET_ENV=staging FORMAT=env npx ts-node scripts/print-required-secrets.ts
 *
 *   # Show which required vars are CURRENTLY missing in your shell. Exits 1
 *   # if any hard or prod-tier var is missing for the target env.
 *   TARGET_ENV=staging FORMAT=missing npx ts-node scripts/print-required-secrets.ts
 *
 * No secret values are read from disk or written anywhere. Safe to run in
 * any environment — only env-var *names* and *placeholder* values are emitted.
 */

import { ENV_RULES, EnvRule, isProdLike, looksLikePlaceholder } from '../src/common/env-validation';

type Format = 'table' | 'fly' | 'env' | 'missing';

function parseFormat(v: string | undefined): Format {
  switch ((v || '').toLowerCase()) {
    case 'fly':
      return 'fly';
    case 'env':
      return 'env';
    case 'missing':
      return 'missing';
    default:
      return 'table';
  }
}

function tierLabel(rule: EnvRule, isProd: boolean): string {
  if (rule.tier === 'hard') return 'REQUIRED';
  if (rule.tier === 'prod') return isProd ? 'REQUIRED' : 'optional (dev)';
  if (rule.tier === 'feature') return 'feature (warn)';
  return 'optional';
}

function shouldHaveValue(rule: EnvRule, isProd: boolean): boolean {
  if (rule.tier === 'hard') return true;
  if (rule.tier === 'prod') return isProd;
  return false;
}

function placeholderFor(name: string): string {
  if (name === 'DATABASE_URL') return 'postgresql://USER:PASS@HOST:5432/postgres';
  if (name === 'SUPABASE_URL') return 'https://<project-ref>.supabase.co';
  if (name === 'SUPABASE_SERVICE_ROLE_KEY') return '<supabase-service-role-key>';
  if (name === 'PUBLIC_INVITE_BASE_URL') return 'https://staging.thegrowthproject.app/join';
  if (name === 'PUBLIC_WEB_SIGNUP_URL') return 'https://staging.thegrowthproject.app/signup';
  if (name === 'APP_STORE_URL') return 'https://apps.apple.com/app/idXXXXXXXXX';
  if (name === 'PLAY_STORE_URL') return 'https://play.google.com/store/apps/details?id=YOUR_ID';
  if (name === 'CORS_ORIGINS') return 'https://console-staging.thegrowthproject.app';
  if (name === 'STRIPE_SECRET_KEY') return 'sk_test_XXXXXXXXXXXXXXXX';
  if (name === 'STRIPE_WEBHOOK_SECRET') return 'whsec_XXXXXXXXXXXXXXXX';
  if (name === 'STRIPE_PRICE_ID_FITNESS') return 'price_XXXXXXXXXXXXXXXX';
  if (name === 'SENTRY_DSN') return 'https://<key>@o0.ingest.sentry.io/0';
  if (name === 'POSTHOG_KEY') return 'phc_XXXXXXXXXXXXXXXX';
  if (name === 'PERPLEXITY_API_KEY') return 'pplx-XXXXXXXXXXXXXXXX';
  if (name === 'USDA_API_KEY') return 'XXXXXXXXXXXXXXXX';
  if (name === 'COACH_CODE_GATE_ENABLED') return 'false';
  if (name === 'BILLING_ENFORCEMENT') return 'observe';
  if (name === 'STRIPE_PRICE_ID_FINANCE') return 'price_XXXXXXXXXXXXXXXX';
  return '<value>';
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function printTable(target: string, isProd: boolean): void {
  const nameW = Math.max(...ENV_RULES.map((r) => r.name.length), 8) + 2;
  const tierW = 16;
  console.log(`\n[print-required-secrets] target NODE_ENV=${target} (prod-tier enforced=${isProd})\n`);
  console.log(`${pad('NAME', nameW)}${pad('TIER', tierW)}REASON`);
  console.log(`${pad('----', nameW)}${pad('----', tierW)}------`);
  for (const rule of ENV_RULES) {
    console.log(`${pad(rule.name, nameW)}${pad(tierLabel(rule, isProd), tierW)}${rule.reason}`);
  }
  console.log('');
}

function printFly(target: string, isProd: boolean): void {
  const required = ENV_RULES.filter((r) => shouldHaveValue(r, isProd));
  console.log(`# fly secrets set template — target NODE_ENV=${target}`);
  console.log(`# Replace placeholders, then run as one command (no real values committed).`);
  console.log(`fly secrets set -a <app> \\`);
  required.forEach((rule, i) => {
    const last = i === required.length - 1;
    console.log(`  ${rule.name}=${placeholderFor(rule.name)}${last ? '' : ' \\'}`);
  });
  console.log('');
  console.log(`# Optional (set only if you need the related feature):`);
  for (const rule of ENV_RULES.filter((r) => !shouldHaveValue(r, isProd))) {
    console.log(`#   ${rule.name}=${placeholderFor(rule.name)}`);
  }
}

function printEnv(target: string, isProd: boolean): void {
  console.log(`# .env stub — target NODE_ENV=${target}`);
  console.log(`NODE_ENV=${target}`);
  for (const rule of ENV_RULES) {
    const tag = shouldHaveValue(rule, isProd) ? 'REQUIRED' : 'optional';
    console.log(`# [${tag}] ${rule.reason}`);
    console.log(`${rule.name}=${shouldHaveValue(rule, isProd) ? placeholderFor(rule.name) : ''}`);
  }
}

function printMissing(target: string, isProd: boolean): number {
  const missingHard: string[] = [];
  const missingProd: string[] = [];
  const missingFeature: string[] = [];
  const missingOptional: string[] = [];
  const placeholderHard: string[] = [];
  const placeholderProd: string[] = [];
  for (const rule of ENV_RULES) {
    const v = process.env[rule.name];
    const isSet = typeof v === 'string' && v.trim().length > 0;
    if (!isSet) {
      if (rule.tier === 'hard') missingHard.push(rule.name);
      else if (rule.tier === 'prod') missingProd.push(rule.name);
      else if (rule.tier === 'feature') missingFeature.push(rule.name);
      else missingOptional.push(rule.name);
      continue;
    }
    // Only flag placeholders for hard/prod-tier vars — same policy as the
    // runtime env validator. Values are NEVER printed.
    if ((rule.tier === 'hard' || rule.tier === 'prod') && looksLikePlaceholder(v!)) {
      if (rule.tier === 'hard') placeholderHard.push(rule.name);
      else placeholderProd.push(rule.name);
    }
  }

  console.log(`[print-required-secrets] target NODE_ENV=${target} (prod-tier enforced=${isProd})`);
  console.log(`  missing HARD          (${missingHard.length}): ${missingHard.join(', ') || '-'}`);
  console.log(`  missing PROD-tier     (${missingProd.length}): ${missingProd.join(', ') || '-'}`);
  console.log(`  missing feature       (${missingFeature.length}): ${missingFeature.join(', ') || '-'}`);
  console.log(`  missing optional      (${missingOptional.length}): ${missingOptional.join(', ') || '-'}`);
  console.log(`  placeholder HARD      (${placeholderHard.length}): ${placeholderHard.join(', ') || '-'}`);
  console.log(`  placeholder PROD-tier (${placeholderProd.length}): ${placeholderProd.join(', ') || '-'}`);

  // Feature-tier vars warn but never block boot. Hard tier and (in prod)
  // prod tier — including placeholder values — are blocking.
  const blocking =
    missingHard.length +
    placeholderHard.length +
    (isProd ? missingProd.length + placeholderProd.length : 0);
  return blocking > 0 ? 1 : 0;
}

function main(): void {
  const target = (process.env.TARGET_ENV || 'staging').toLowerCase();
  const isProd = isProdLike(target);
  const fmt = parseFormat(process.env.FORMAT);

  if (fmt === 'fly') {
    printFly(target, isProd);
    return;
  }
  if (fmt === 'env') {
    printEnv(target, isProd);
    return;
  }
  if (fmt === 'missing') {
    process.exit(printMissing(target, isProd));
  }
  printTable(target, isProd);
}

main();
