// provider-wiring-twilio-aws-fly-sentry-supabase-openai-cf.spec.ts
//
// Coverage (part 2 of 2) for the provider-wiring scanner. Covers the remaining
// seven providers (Twilio, AWS S3, Fly.io, Sentry, Supabase, OpenAI,
// Cloudflare), the either/or AWS credential logic (static keys vs IAM
// web-identity token), the `--provider` filter, the `getProductionBlockers`
// summary, and the filesystem I/O edges (collectImports / collectPathPresence /
// scanProvidersFromProcess) driven against a throwaway temp directory.

import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, link } from 'node:fs/promises';
import { existsSync, readFileSync, accessSync, lstatSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import {
  PROVIDERS,
  classifyProvider,
  isSdkImported,
  scanProvidersWith,
  scanProvidersFromProcess,
  filterProviders,
  getProductionBlockers,
  collectImports,
  collectPathPresence,
  collectFileEvidence,
  extractModuleSpecifiers,
  isPlausibleSupabaseServiceRoleJwt,
  type ProviderDef,
  type EnvMap,
  type EvidenceMap,
  type ProviderReport,
} from './provider-wiring';

/** True when the current process genuinely cannot read `p` (root can read 0o000). */
function accessDenied(p: string): boolean {
  try {
    accessSync(p, fsConstants.R_OK);
    return false;
  } catch {
    return true;
  }
}

function def(id: string): ProviderDef {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`provider def not found: ${id}`);
  return found;
}

function wired(id: string, env: EnvMap): ProviderReport {
  return classifyProvider(def(id), true, env);
}

describe('Twilio provider', () => {
  const live: EnvMap = {
    TWILIO_ACCOUNT_SID: 'AC9f3kPq2rstuVWXyz0123456789abcd',
    TWILIO_AUTH_TOKEN: 'auth-9f3kPq2rstuVWX',
    TWILIO_PHONE_NUMBER: '+14155550100',
  };

  it('live: all three vars present → WIRED', () => {
    const r = wired('twilio', live);
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']),
    );
  });

  it('placeholder: auth token is a fake sentinel → STUB', () => {
    const r = wired('twilio', { ...live, TWILIO_AUTH_TOKEN: 'changeme' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('TWILIO_AUTH_TOKEN');
  });

  it('missing: phone number absent → STUB, missing populated', () => {
    const r = wired('twilio', {
      TWILIO_ACCOUNT_SID: live.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: live.TWILIO_AUTH_TOKEN,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('TWILIO_PHONE_NUMBER');
  });
});

describe('AWS S3 provider (either/or credential groups)', () => {
  it('live via static keys: region + access key id + secret → WIRED', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
      AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining(['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']),
    );
    expect(r.env_vars_missing).toEqual([]);
  });

  it('live via IAM role: region + role ARN + web-identity token file, no static keys → WIRED', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks.amazonaws.com/serviceaccount/token',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining(['AWS_REGION', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE']),
    );
  });

  it('missing creds: region present but NO credential group satisfied → STUB', () => {
    const r = wired('aws-s3', { AWS_REGION: 'us-east-1' });
    expect(r.status).toBe('STUB');
    // All three credential groups are equally empty; the reducer surfaces the
    // first (static-key) group as the actionable one.
    expect(r.env_vars_missing).toContain('AWS_ACCESS_KEY_ID');
  });

  it('missing region: always-required AWS_REGION absent → STUB even with static keys', () => {
    const r = wired('aws-s3', {
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
      AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_REGION');
  });

  it('partial static group: only access key id (no secret) → STUB, surfaces best group', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
    });
    expect(r.status).toBe('STUB');
    // Best (fewest-gaps) group here is the static-key group missing the secret.
    expect(r.env_vars_missing).toContain('AWS_SECRET_ACCESS_KEY');
  });
});

describe('AWS web-identity token-file existence (evidence map, pure core)', () => {
  const iamEnv: EnvMap = {
    AWS_REGION: 'us-east-1',
    AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks/token',
  };
  const evKey = 'AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS';

  it('no evidence supplied → backward-compatible WIRED (pure env-only path)', () => {
    const r = classifyProvider(def('aws-s3'), true, iamEnv);
    expect(r.status).toBe('WIRED');
    expect(r.diagnostic).toBeUndefined();
  });

  it('evidence FILE_EXISTS=true → WIRED', () => {
    const r = classifyProvider(def('aws-s3'), true, iamEnv, { [evKey]: true });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('AWS_WEB_IDENTITY_TOKEN_FILE');
  });

  it('evidence FILE_EXISTS=false → STUB with non-existent-path diagnostic', () => {
    const r = classifyProvider(def('aws-s3'), true, iamEnv, { [evKey]: false });
    expect(r.status).toBe('STUB');
    expect(r.diagnostic).toBe('AWS_WEB_IDENTITY_TOKEN_FILE points to non-existent path');
  });

  it('static-key group satisfied → file evidence is irrelevant, stays WIRED', () => {
    // When the static-key group fully wires AWS, a missing token FILE in the
    // OTHER (unused) group must not demote the provider.
    const r = classifyProvider(
      def('aws-s3'),
      true,
      {
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
        AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/definitely/not/here',
      },
      { [evKey]: false },
    );
    expect(r.status).toBe('WIRED');
  });
});

describe('scanProvidersWith threads the evidence map to the core', () => {
  it('demotes AWS to STUB when injected evidence says the token file is missing', () => {
    const imported = new Set(['@aws-sdk/client-s3']);
    const env: EnvMap = {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
    };
    const evidence: EvidenceMap = { AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS: false };
    const reports = scanProvidersWith(imported, new Set(), env, [def('aws-s3')], evidence);
    expect(reports[0].status).toBe('STUB');
    expect(reports[0].diagnostic).toBe('AWS_WEB_IDENTITY_TOKEN_FILE points to non-existent path');
  });

  it('keeps AWS WIRED when injected evidence confirms the token file exists', () => {
    const imported = new Set(['@aws-sdk/client-s3']);
    const env: EnvMap = {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
    };
    const evidence: EvidenceMap = { AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS: true };
    const reports = scanProvidersWith(imported, new Set(), env, [def('aws-s3')], evidence);
    expect(reports[0].status).toBe('WIRED');
  });

  it('a missing-file AWS provider is surfaced by getProductionBlockers', () => {
    const imported = new Set(['@aws-sdk/client-s3']);
    const env: EnvMap = {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
    };
    const reports = scanProvidersWith(imported, new Set(), env, [def('aws-s3')], {
      AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS: false,
    });
    expect(getProductionBlockers(reports).map((b) => b.id)).toEqual(['aws-s3']);
  });
});

describe('collectFileEvidence (I/O edge, real fs.existsSync)', () => {
  it('records FILE_EXISTS=false for a token path that does not exist', () => {
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: '/definitely/not/here/at/all' });
    expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(false);
  });

  it('records FILE_EXISTS=true for a path that does exist (this spec file)', () => {
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: __filename });
    expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(true);
  });

  it('emits no evidence key for an unset *_FILE var', () => {
    const ev = collectFileEvidence({ AWS_REGION: 'us-east-1' });
    expect(Object.keys(ev)).toHaveLength(0);
  });
});

describe('extractModuleSpecifiers (AST-based import discovery)', () => {
  it('captures a static default + named `from` import', () => {
    const specs = extractModuleSpecifiers("import OpenAI, { Foo } from 'openai';");
    expect(specs).toContain('openai');
  });

  it('captures a side-effect import (no bindings)', () => {
    const specs = extractModuleSpecifiers("import 'reflect-metadata';");
    expect(specs).toContain('reflect-metadata');
  });

  it('captures a CommonJS require() call', () => {
    const specs = extractModuleSpecifiers("const s = require('stripe');");
    expect(specs).toContain('stripe');
  });

  it('captures a dynamic import() call', () => {
    const specs = extractModuleSpecifiers(
      "async function f() { return await import('@aws-sdk/client-s3'); }",
    );
    expect(specs).toContain('@aws-sdk/client-s3');
  });

  it('captures an `export ... from` re-export', () => {
    const specs = extractModuleSpecifiers("export { Foo } from 'twilio';");
    expect(specs).toContain('twilio');
  });

  it('safely skips computed / non-literal dynamic specifiers', () => {
    const src = [
      'const name = makePkg();',
      'const a = require(name);',
      'const b = import(name);',
      "const c = require('a' + 'b');",
    ].join('\n');
    const specs = extractModuleSpecifiers(src);
    // Only statically-known string literals are collected; none here are.
    expect(specs).not.toContain('name');
    expect(specs.length).toBe(0);
  });

  it('collects every static specifier in one pass (mixed forms)', () => {
    const src = [
      "import 'side-effect-pkg';",
      "import x from 'static-pkg';",
      "const r = require('require-pkg');",
      "const d = () => import('dynamic-pkg');",
    ].join('\n');
    const specs = extractModuleSpecifiers(src);
    expect(specs).toEqual(
      expect.arrayContaining(['side-effect-pkg', 'static-pkg', 'require-pkg', 'dynamic-pkg']),
    );
  });

  it('does NOT count a declaration-level type-only import (H4.D R3 F003)', () => {
    // `import type { Stripe } from 'stripe'` is erased by the TS compiler and
    // emits no runtime require — it must not register as runtime provider usage.
    const specs = extractModuleSpecifiers("import type { Stripe } from 'stripe';");
    expect(specs).not.toContain('stripe');
    expect(specs).toEqual([]);
  });

  it('captures a namespace import (import * as)', () => {
    const specs = extractModuleSpecifiers("import * as path from 'node:path';");
    expect(specs).toContain('node:path');
  });

  it('does NOT treat a user-defined function named `import`-like as a dynamic import', () => {
    // `notRequire('x')` must be ignored — only the real `require` identifier and
    // the `import` keyword count.
    const specs = extractModuleSpecifiers("const v = notRequire('should-not-match');");
    expect(specs).not.toContain('should-not-match');
  });

  it('captures multiple requires across nested scopes', () => {
    const src = [
      'function outer() {',
      "  const a = require('pkg-a');",
      '  function inner() {',
      "    return require('pkg-b');",
      '  }',
      '  return inner;',
      '}',
    ].join('\n');
    const specs = extractModuleSpecifiers(src);
    expect(specs).toEqual(expect.arrayContaining(['pkg-a', 'pkg-b']));
  });

  it('returns an empty array for a file with no imports at all', () => {
    expect(extractModuleSpecifiers('export const answer = 42;\n')).toEqual([]);
  });
});

describe('AWS diagnostic is omitted when the provider is genuinely wired', () => {
  it('static-key WIRED report carries no diagnostic field', () => {
    const r = classifyProvider(def('aws-s3'), true, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
      AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
    expect(r.diagnostic).toBeUndefined();
  });

  it('a provider with no requiresAnyOf groups never gets a file diagnostic', () => {
    const r = wired('sentry', {
      SENTRY_DSN: 'https://abc123@o123.ingest.sentry.io/456',
      SENTRY_AUTH_TOKEN: 'sntrys_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('WIRED');
    expect(r.diagnostic).toBeUndefined();
  });
});

describe('Fly.io provider (file-path hint detection)', () => {
  it('live: token present and detected via path hint → WIRED', () => {
    const r = classifyProvider(
      def('fly'),
      isSdkImported(def('fly'), new Set(), new Set(['fly.toml'])),
      {
        FLY_API_TOKEN: 'fo1_9f3kPq2rstuVWXabcdEFGH',
      },
    );
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('FLY_API_TOKEN');
  });

  it('missing: token absent though detected → STUB', () => {
    const r = wired('fly', {});
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('FLY_API_TOKEN');
  });

  it('dormant: no path hint and no package → NOT_USED', () => {
    const r = classifyProvider(def('fly'), isSdkImported(def('fly'), new Set(), new Set()), {
      FLY_API_TOKEN: 'fo1_9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('NOT_USED');
  });
});

describe('Sentry provider', () => {
  it('live: dsn + auth token present → WIRED', () => {
    const r = wired('sentry', {
      SENTRY_DSN: 'https://abc123@o123.ingest.sentry.io/456',
      SENTRY_AUTH_TOKEN: 'sntrys_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: dsn is a fake sentinel → STUB', () => {
    const r = wired('sentry', {
      SENTRY_DSN: 'fake-dsn',
      SENTRY_AUTH_TOKEN: 'sntrys_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SENTRY_DSN');
  });

  it('missing: auth token absent → STUB', () => {
    const r = wired('sentry', { SENTRY_DSN: 'https://abc123@o123.ingest.sentry.io/456' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('SENTRY_AUTH_TOKEN');
  });
});

describe('Supabase provider', () => {
  it('live: url + service role key present → WIRED', () => {
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY:
        'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: service role key is TODO → STUB', () => {
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'TODO',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('missing: url absent → STUB', () => {
    const r = wired('supabase', {
      SUPABASE_SERVICE_ROLE_KEY:
        'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('SUPABASE_URL');
  });

  it('malformed service-role key (not a JWT) → STUB, key flagged as placeholder', () => {
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGci-not-a-real-jwt', // no dot-segments
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('OpenAI provider', () => {
  it('live: api key present → WIRED', () => {
    const r = wired('openai', { OPENAI_API_KEY: 'sk-proj-9f3kPq2rstuVWXabcdEFGH' });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: api key is insert_key_here → STUB', () => {
    const r = wired('openai', { OPENAI_API_KEY: 'insert_key_here' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('OPENAI_API_KEY');
  });

  it('missing: empty env → STUB', () => {
    const r = wired('openai', {});
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('OPENAI_API_KEY');
  });

  it('malformed key (wrong prefix / too short) → STUB, key flagged as placeholder', () => {
    const r = wired('openai', { OPENAI_API_KEY: 'pk-tooShort' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('OPENAI_API_KEY');
  });
});

describe('Cloudflare provider', () => {
  it('live: account id + api token present → WIRED', () => {
    const r = wired('cloudflare', {
      CLOUDFLARE_ACCOUNT_ID: '9f3kpq2rstuvwxabcdef0123456789ab',
      CLOUDFLARE_API_TOKEN: 'cf-9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: api token is yourkey → STUB', () => {
    const r = wired('cloudflare', {
      CLOUDFLARE_ACCOUNT_ID: '9f3kpq2rstuvwxabcdef0123456789ab',
      CLOUDFLARE_API_TOKEN: 'yourkey',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('missing: account id absent → STUB', () => {
    const r = wired('cloudflare', { CLOUDFLARE_API_TOKEN: 'cf-9f3kPq2rstuVWXabcdEFGH' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('CLOUDFLARE_ACCOUNT_ID');
  });
});

describe('filterProviders (--provider filter)', () => {
  it('returns only the requested provider', () => {
    const filtered = filterProviders(PROVIDERS, 'stripe');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('stripe');
  });

  it('returns an empty list for an unknown provider id', () => {
    expect(filterProviders(PROVIDERS, 'no-such-provider')).toEqual([]);
  });

  it('scanning a filtered single-provider set yields a single report', () => {
    const reports = scanProvidersWith(
      new Set(['stripe']),
      new Set(),
      {
        STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
        STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
      },
      filterProviders(PROVIDERS, 'stripe'),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe('WIRED');
  });
});

describe('getProductionBlockers summary', () => {
  it('returns only STUB providers (imported-but-unwired); excludes NOT_USED and WIRED', () => {
    const imported = new Set(['stripe', 'openai']); // supabase NOT imported → NOT_USED
    const env: EnvMap = {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234', // stripe WIRED
      // OPENAI_API_KEY missing → openai STUB
    };
    const reports = scanProvidersWith(imported, new Set(), env, [
      def('stripe'),
      def('openai'),
      def('supabase'),
    ]);
    const blockers = getProductionBlockers(reports);
    expect(blockers.map((b) => b.id)).toEqual(['openai']);
  });

  it('empty env with all SDKs imported → every provider is a blocker', () => {
    const allIds = PROVIDERS.map((p) => p.id);
    const reports = PROVIDERS.map((d) => classifyProvider(d, true, {}));
    const blockers = getProductionBlockers(reports);
    expect(blockers.map((b) => b.id).sort()).toEqual([...allIds].sort());
  });

  it('no blockers when nothing is imported (all NOT_USED)', () => {
    const reports = PROVIDERS.map((d) => classifyProvider(d, false, {}));
    expect(getProductionBlockers(reports)).toEqual([]);
  });
});

describe('negative: empty env across the full seed list', () => {
  it('imported-everywhere + empty env → all providers STUB', () => {
    const reports = PROVIDERS.map((d) => classifyProvider(d, true, {}));
    expect(reports.every((r) => r.status === 'STUB')).toBe(true);
  });

  it('nothing imported + empty env → all providers NOT_USED', () => {
    const reports = PROVIDERS.map((d) => classifyProvider(d, false, {}));
    expect(reports.every((r) => r.status === 'NOT_USED')).toBe(true);
  });
});

describe('full seed-list scan via scanProvidersWith (default providers arg)', () => {
  it('classifies all ten providers when every SDK is imported and fully wired', () => {
    const imported = new Set(PROVIDERS.flatMap((p) => p.packages));
    // Path hints for the package-less / hint-detected providers.
    const paths = new Set([
      'src/billing',
      'src/email',
      'src/sms',
      'src/cdn',
      'src/video',
      'fly.toml',
    ]);
    const env: EnvMap = {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY:
        'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH',
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
      OPENAI_API_KEY: 'sk-proj-9f3kPq2rstuVWXabcdEFGH',
      SENDGRID_API_KEY: 'SG.realKey9f3kPq2rstuVWX.longsuffix',
      TWILIO_ACCOUNT_SID: 'AC9f3kPq2rstuVWXyz0123456789abcd',
      TWILIO_AUTH_TOKEN: 'auth-9f3kPq2rstuVWX',
      TWILIO_PHONE_NUMBER: '+14155550100',
      CLOUDFLARE_ACCOUNT_ID: '9f3kpq2rstuvwxabcdef0123456789ab',
      CLOUDFLARE_API_TOKEN: 'cf-9f3kPq2rstuVWXabcdEFGH',
      MUX_TOKEN_ID: '0a1b2c3d-token-id',
      MUX_TOKEN_SECRET: 'mux-secret-9f3kPq2rstuVWX',
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
      FLY_API_TOKEN: 'fo1_9f3kPq2rstuVWXabcdEFGH',
      SENTRY_DSN: 'https://abc123@o123.ingest.sentry.io/456',
      SENTRY_AUTH_TOKEN: 'sntrys_9f3kPq2rstuVWX',
    };
    const reports = scanProvidersWith(imported, paths, env);
    expect(reports).toHaveLength(PROVIDERS.length);
    expect(reports.every((r) => r.status === 'WIRED')).toBe(true);
    // No production blockers when everything is wired.
    expect(getProductionBlockers(reports)).toEqual([]);
  });

  it('the seed list contains exactly the ten briefed providers', () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(
      [
        'aws-s3',
        'cloudflare',
        'fly',
        'mux',
        'openai',
        'sendgrid',
        'sentry',
        'stripe',
        'supabase',
        'twilio',
      ].sort(),
    );
  });

  it('each provider declares at least one required var', () => {
    for (const p of PROVIDERS) {
      expect(p.requires.length).toBeGreaterThan(0);
    }
  });
});

describe('I/O edges against a temp repo (collectImports / collectPathPresence / scanProvidersFromProcess)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'provider-wiring-edge-'));
    const srcBilling = join(root, 'src', 'billing');
    await mkdir(srcBilling, { recursive: true });
    // A source file that imports the OpenAI SDK and a scoped AWS SDK, plus a
    // CommonJS require, a dynamic import, and a side-effect import — all of which
    // the AST-based collector must discover (the old regex only saw `from`).
    await writeFile(
      join(srcBilling, 'pay.ts'),
      [
        "import OpenAI from 'openai';",
        "import { S3Client } from '@aws-sdk/client-s3';",
        "import 'reflect-metadata';", // side-effect import
        "const Stripe = require('stripe');", // CommonJS require
        "export const loadMux = () => import('@mux/mux-node');", // dynamic import
        "import { local } from './helper';",
        'export const x = 1;',
      ].join('\n'),
      'utf8',
    );
    // A declaration file that must be ignored by the import collector.
    await writeFile(
      join(srcBilling, 'types.d.ts'),
      "import type { Foo } from 'should-be-ignored';\n",
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collectImports records bare + scoped packages and skips relative + .d.ts', () => {
    const found = collectImports(root);
    expect(found.has('openai')).toBe(true);
    expect(found.has('@aws-sdk/client-s3')).toBe(true);
    expect(found.has('should-be-ignored')).toBe(false); // .d.ts skipped
    expect([...found].some((p) => p.startsWith('.'))).toBe(false); // relative skipped
  });

  it('collectImports (AST) also discovers require, dynamic import, and side-effect imports', () => {
    const found = collectImports(root);
    expect(found.has('reflect-metadata')).toBe(true); // side-effect import
    expect(found.has('stripe')).toBe(true); // require('stripe')
    expect(found.has('@mux/mux-node')).toBe(true); // dynamic import()
  });

  it('collectImports returns empty set when src/ does not exist', () => {
    const empty = collectImports(join(root, 'no-such-subtree'));
    expect(empty.size).toBe(0);
  });

  it('collectPathPresence resolves the src/billing hint directly', () => {
    const hints = collectPathPresence(root, [def('stripe')]);
    expect(hints.has('src/billing')).toBe(true);
  });

  it('collectPathPresence resolves a hint via substring fallback when no direct dir exists', async () => {
    // No 'src/cdn' directory exists, but a file whose path contains the literal
    // substring 'src/cdn' does (src/cdn-edge.ts), exercising the walk fallback.
    await writeFile(join(root, 'src', 'cdn-edge.ts'), 'export const edge = () => 1;\n', 'utf8');
    const hints = collectPathPresence(root, [def('cloudflare')]);
    expect(hints.has('src/cdn')).toBe(true);
  });

  it('collectPathPresence does NOT match a hint that has no corresponding path', () => {
    // src/sms has neither a directory nor any file path containing it.
    const hints = collectPathPresence(root, [def('twilio')]);
    expect(hints.has('src/sms')).toBe(false);
  });

  it('scanProvidersFromProcess wires OpenAI/AWS when the web-identity token file EXISTS', async () => {
    // The edge wrapper probes the token-file path on disk: point it at a real
    // file inside the temp repo so the IAM credential group is genuinely usable.
    const tokenPath = join(root, 'aws-web-identity-token');
    await writeFile(tokenPath, 'eyJ.fake.jwt\n', 'utf8');
    const env: EnvMap = {
      OPENAI_API_KEY: 'sk-proj-9f3kPq2rstuVWXabcdEFGH',
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenPath,
      // stripe detected via src/billing path hint but no keys → STUB
    };
    const reports = scanProvidersFromProcess(root, env);
    const byId = Object.fromEntries(reports.map((r) => [r.id, r.status]));
    expect(byId.openai).toBe('WIRED');
    expect(byId['aws-s3']).toBe('WIRED');
    expect(byId.stripe).toBe('STUB'); // imported via path hint, but keys absent
    expect(byId.sendgrid).toBe('NOT_USED'); // neither package nor path present
  });

  it('scanProvidersFromProcess STUBs AWS when the web-identity token file is MISSING', () => {
    // Same env, but the token path does not exist on disk. The edge wrapper's
    // fs.existsSync evidence must demote aws-s3 from WIRED to STUB with a
    // diagnostic, closing the "unusable token-file path" gap.
    const env: EnvMap = {
      OPENAI_API_KEY: 'sk-proj-9f3kPq2rstuVWXabcdEFGH',
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: join(root, 'definitely', 'not', 'here'),
    };
    const reports = scanProvidersFromProcess(root, env);
    const aws = reports.find((r) => r.id === 'aws-s3');
    expect(aws?.status).toBe('STUB');
    expect(aws?.diagnostic).toBe('AWS_WEB_IDENTITY_TOKEN_FILE points to non-existent path');
    // OpenAI (no file dependency) stays WIRED — the demotion is scoped to AWS.
    const byId = Object.fromEntries(reports.map((r) => [r.id, r.status]));
    expect(byId.openai).toBe('WIRED');
  });
});

// ---------------------------------------------------------------------------
// H4.D R2 regression coverage (findings F001 / F002 / F003)
// ---------------------------------------------------------------------------

describe('F001 — Supabase service-role JWT segment validation (offline)', () => {
  // A full, valid HS256 service-role token (header {"alg":"HS256"},
  // payload {"role":"service_role"}). This is the exact shape the live tests use.
  const validToken = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH';

  function enc(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  }

  it('accepts a valid full service-role token → WIRED', () => {
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: validToken,
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(isPlausibleSupabaseServiceRoleJwt(validToken)).toBe(true);
  });

  it('rejects `eyJbad.abc.def` — matches old regex but decodes to invalid JSON', () => {
    // Sanity-check it would have passed the OLD shape regex, proving the gap.
    expect(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test('eyJbad.abc.def')).toBe(true);
    expect(isPlausibleSupabaseServiceRoleJwt('eyJbad.abc.def')).toBe(false);
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJbad.abc.def',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('rejects a header that decodes to bytes that are not valid JSON', () => {
    // The header segment is valid base64url but its decoded bytes are not JSON,
    // so JSON.parse fails and the token is rejected (treated as STUB).
    const nonJsonHeader = Buffer.from('not json at all', 'utf8').toString('base64url');
    const token = `${nonJsonHeader}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('rejects valid-base64 but invalid-JSON payload', () => {
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const badPayload = Buffer.from('{not:valid json', 'utf8').toString('base64url');
    const token = `${header}.${badPayload}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('rejects valid-JSON header+payload but missing any role claim', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ sub: 'user-123', foo: 'bar' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  // --- H4.D R3 F001: role === "service_role" is a HARD GATE -----------------
  // The R2 revision accepted a token merely because it carried a non-empty
  // `iss` OR `ref` claim. That OR-on-iss/ref was too permissive: any well-formed
  // JWT (incl. a Supabase `anon` token, which also has `iss`/`ref`) validated
  // as a service-role key. The gate is now: the `role` claim MUST be exactly
  // "service_role"; `iss`/`ref` are corroborating evidence only.
  it('R3 F001: an iss-only token (no role) → REJECT', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ iss: 'https://abcdefgh.supabase.co/auth/v1' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('R3 F001: a ref-only token (no role) → REJECT', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ ref: 'abcdefghproj1234' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('R3 F001: an iss + ref token with NO role → REJECT', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ iss: 'https://abcdefgh.supabase.co/auth/v1', ref: 'abcdefghproj1234' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
    // End-to-end: such a token must bucket the var as a placeholder → STUB.
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: token,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('R3 F001: a token with role "anon" (not service_role) → REJECT', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ role: 'anon', iss: 'https://abcdefgh.supabase.co/auth/v1', ref: 'abcdefghproj1234' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('R3 F001: role "service_role" alone (no iss/ref) → ACCEPT', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(true);
  });

  it('R3 F001: a full Supabase service-role token (role + ref + iss) → ACCEPT', () => {
    const token = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role: 'service_role', ref: 'abcdefghproj1234', iss: 'https://abcdefgh.supabase.co/auth/v1' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(true);
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: token,
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('rejects a token with the wrong number of segments', () => {
    expect(isPlausibleSupabaseServiceRoleJwt('eyJ.only-two')).toBe(false);
    expect(isPlausibleSupabaseServiceRoleJwt('a.b.c.d')).toBe(false);
  });

  it('rejects a token with an empty signature segment', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ role: 'service_role' })}.`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('rejects a header whose typ is present but not "JWT"', () => {
    const token = `${enc({ alg: 'HS256', typ: 'NOTJWT' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('rejects a header missing a string alg claim', () => {
    const token = `${enc({ typ: 'JWT' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });
});

describe('F001 (R4) — reject alg=none and unknown JWT algs', () => {
  // H4.D R4 F001: the validator previously accepted ANY non-empty string `alg`,
  // so a token with `header.alg = "none"` (or a garbage alg) plus
  // `payload.role = "service_role"` classified WIRED. That lets an env-file
  // editor forge a "looks-real" service_role JWT with no signing key. The
  // validator now requires `alg` on an allowlist of plausible Supabase signing
  // algorithms (HS256/384/512, RS256/384/512, ES256/384) and rejects `none`
  // (any casing) and unknown values. The header is checked BEFORE the role gate.
  function enc(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  }

  it('alg=none + role=service_role → REJECTED (not WIRED)', () => {
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
    // End-to-end: the forged unsigned token must NOT classify WIRED.
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: token,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('alg=NONE (uppercase) + role=service_role → REJECTED (case-insensitive)', () => {
    const token = `${enc({ alg: 'NONE' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('alg=None (mixed case) + role=service_role → REJECTED', () => {
    const token = `${enc({ alg: 'None' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('alg=garbage + role=service_role → REJECTED (unknown alg)', () => {
    const token = `${enc({ alg: 'totally-not-an-alg-XYZ' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('alg=HS256 + role=service_role → WIRED (preserves existing pass)', () => {
    const token = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(true);
    const r = wired('supabase', {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: token,
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('alg=ES256 + role=service_role → WIRED (allowlist breadth check)', () => {
    const token = `${enc({ alg: 'ES256' })}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(true);
  });

  it('every allowlisted alg + role=service_role → WIRED', () => {
    for (const alg of ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384']) {
      const token = `${enc({ alg })}.${enc({ role: 'service_role' })}.sig`;
      expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(true);
    }
  });

  it('missing header (empty header segment) → REJECTED', () => {
    // An empty header segment base64url-decodes to '' which is not valid JSON.
    const token = `.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('malformed header (non-JSON bytes) → REJECTED', () => {
    const nonJsonHeader = Buffer.from('this is not json', 'utf8').toString('base64url');
    const token = `${nonJsonHeader}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('malformed header (oversized segment) → REJECTED', () => {
    // A header segment beyond the defensive size cap (8192 chars) is rejected
    // before any decode is attempted.
    const oversizedHeader = 'A'.repeat(9000);
    const token = `${oversizedHeader}.${enc({ role: 'service_role' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });

  it('alg=HS256 + role=anon → REJECTED (preserves R3 role gate)', () => {
    const token = `${enc({ alg: 'HS256' })}.${enc({ role: 'anon' })}.sig`;
    expect(isPlausibleSupabaseServiceRoleJwt(token)).toBe(false);
  });
});

describe('F002 — collectFileEvidence requires a regular readable file (not a directory)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'provider-wiring-f002-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('missing path → FILE_EXISTS=false', () => {
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, 'nope') });
    expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(false);
  });

  it('DIRECTORY at the credential path → FILE_EXISTS=false (fs.existsSync alone would say true)', async () => {
    const asDir = join(dir, 'token-as-dir');
    await mkdir(asDir, { recursive: true });
    // Prove the gap: plain existence is satisfied by the directory.
    expect(existsSync(asDir)).toBe(true);
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: asDir });
    expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(false);
  });

  it('regular readable file → FILE_EXISTS=true', async () => {
    const file = join(dir, 'real-token');
    await writeFile(file, 'token-bytes', 'utf8');
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: file });
    expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(true);
  });

  it('unreadable file → FILE_EXISTS=false', async () => {
    const file = join(dir, 'unreadable-token');
    await writeFile(file, 'secret', 'utf8');
    await chmod(file, 0o000);
    const ev = collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: file });
    // Root can read 0o000 files; only assert false when access is truly denied.
    if (accessDenied(file)) {
      expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(false);
    } else {
      expect(ev.AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS).toBe(true);
    }
    await chmod(file, 0o644); // restore so afterAll cleanup succeeds
  });

  it('end-to-end: a DIRECTORY at the token path demotes AWS to STUB with a diagnostic', async () => {
    const asDir = join(dir, 'aws-token-dir');
    await mkdir(asDir, { recursive: true });
    const env: EnvMap = {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: asDir,
    };
    const evidence = collectFileEvidence(env);
    const reports = scanProvidersWith(
      new Set(['@aws-sdk/client-s3']),
      new Set(),
      env,
      [def('aws-s3')],
      evidence,
    );
    expect(reports[0].status).toBe('STUB');
    expect(reports[0].diagnostic).toBe('AWS_WEB_IDENTITY_TOKEN_FILE points to non-existent path');
  });
});

describe('F002 (R3) — symlink-to-regular-file is accepted; bad symlink targets are rejected', () => {
  // The R2 revision used lstat-only and rejected ANY symlink (lstat reports the
  // link itself, not the target). That broke legitimate AWS_WEB_IDENTITY_TOKEN_FILE
  // deployments where Kubernetes service-account mounts present the token through
  // a symlink to a regular file. R3 resolves the symlink target via realpath and
  // accepts only when the resolved target is a readable regular file.
  //
  // Per the brief constraint: realpath resolution is fs-touching, so every case
  // builds in a throwaway os.tmpdir() directory cleaned up in afterEach.
  let dir: string;
  const FILE_KEY = 'AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS' as const;

  function evidenceFor(p: string): boolean | undefined {
    return collectFileEvidence({ AWS_WEB_IDENTITY_TOKEN_FILE: p })[FILE_KEY];
  }

  /** Make a FIFO via mkfifo; return its path, or undefined when mkfifo is unavailable. */
  function tryMkfifo(p: string): string | undefined {
    try {
      execFileSync('mkfifo', [p]);
      return p;
    } catch {
      return undefined;
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'provider-wiring-f002-symlink-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('symlink → regular readable file → ACCEPT', async () => {
    const target = join(dir, 'real-token');
    await writeFile(target, 'token-bytes', 'utf8');
    const linkPath = join(dir, 'token-symlink');
    await symlink(target, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true); // it really is a symlink
    expect(evidenceFor(linkPath)).toBe(true);
  });

  it('symlink → directory → REJECT', async () => {
    const targetDir = join(dir, 'a-dir');
    await mkdir(targetDir, { recursive: true });
    const linkPath = join(dir, 'dir-symlink');
    await symlink(targetDir, linkPath);
    expect(existsSync(linkPath)).toBe(true); // existence alone would say true
    expect(evidenceFor(linkPath)).toBe(false);
  });

  it('symlink → FIFO → REJECT', async () => {
    const fifo = tryMkfifo(join(dir, 'a-fifo'));
    if (fifo === undefined) {
      // mkfifo unavailable in this sandbox: assert the equivalent non-file case
      // (a directory target) so the test still carries a real assertion (R117).
      const targetDir = join(dir, 'fifo-fallback-dir');
      await mkdir(targetDir, { recursive: true });
      const linkPath = join(dir, 'fifo-fallback-symlink');
      await symlink(targetDir, linkPath);
      expect(evidenceFor(linkPath)).toBe(false);
      return;
    }
    const linkPath = join(dir, 'fifo-symlink');
    await symlink(fifo, linkPath);
    expect(evidenceFor(linkPath)).toBe(false);
  });

  it('dangling symlink (target does not exist) → REJECT', async () => {
    const linkPath = join(dir, 'dangling-symlink');
    await symlink(join(dir, 'no-such-target'), linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(linkPath)).toBe(false); // existsSync follows → false for dangling
    expect(evidenceFor(linkPath)).toBe(false);
  });

  it('hardlink (= a regular file) → ACCEPT', async () => {
    const target = join(dir, 'hardlink-target');
    await writeFile(target, 'token-bytes', 'utf8');
    const hardPath = join(dir, 'a-hardlink');
    await link(target, hardPath); // hard link, not symbolic
    expect(lstatSync(hardPath).isSymbolicLink()).toBe(false); // hardlink is a regular file
    expect(lstatSync(hardPath).isFile()).toBe(true);
    expect(evidenceFor(hardPath)).toBe(true);
  });

  it('plain regular file → ACCEPT (unchanged from R2)', async () => {
    const file = join(dir, 'plain-token');
    await writeFile(file, 'token-bytes', 'utf8');
    expect(evidenceFor(file)).toBe(true);
  });

  it('plain directory → REJECT (unchanged from R2)', async () => {
    const d = join(dir, 'plain-dir');
    await mkdir(d, { recursive: true });
    expect(evidenceFor(d)).toBe(false);
  });

  it('multi-hop symlink chain → regular file → ACCEPT (k8s ..data style)', async () => {
    // Mirrors Kubernetes projected-token mounts: link → link → real file.
    const target = join(dir, 'real-token');
    await writeFile(target, 'token-bytes', 'utf8');
    const mid = join(dir, 'mid-link');
    await symlink(target, mid);
    const top = join(dir, 'top-link');
    await symlink(mid, top);
    expect(evidenceFor(top)).toBe(true);
  });

  it('end-to-end: a symlink-to-token-file keeps AWS WIRED (no false STUB)', async () => {
    const target = join(dir, 'token');
    await writeFile(target, 'eyJ.fake.jwt', 'utf8');
    const linkPath = join(dir, 'token-link');
    await symlink(target, linkPath);
    const env: EnvMap = {
      AWS_REGION: 'us-east-1',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/eks-s3-access',
      AWS_WEB_IDENTITY_TOKEN_FILE: linkPath,
    };
    const evidence = collectFileEvidence(env);
    const reports = scanProvidersWith(
      new Set(['@aws-sdk/client-s3']),
      new Set(),
      env,
      [def('aws-s3')],
      evidence,
    );
    expect(reports[0].status).toBe('WIRED');
    expect(reports[0].diagnostic).toBeUndefined();
  });
});

describe('F003 — collectImports / extractModuleSpecifiers scan .tsx (and skip .d.ts)', () => {
  it('extractModuleSpecifiers parses a real .tsx fixture and finds the stripe import', () => {
    const fixturePath = join(__dirname, '__fixtures__', 'provider-wiring', 'uses-stripe.tsx');
    const text = readFileSync(fixturePath, 'utf8');
    const specs = extractModuleSpecifiers(text, fixturePath);
    expect(specs).toContain('stripe');
  });

  describe('against a temp repo containing a .tsx component', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'provider-wiring-f003-'));
      const comp = join(root, 'src', 'components');
      await mkdir(comp, { recursive: true });
      // A TSX React component importing the Stripe SDK + a scoped SDK.
      await writeFile(
        join(comp, 'Checkout.tsx'),
        [
          "import Stripe from 'stripe';",
          "import { S3Client } from '@aws-sdk/client-s3';",
          'export const C = (): JSX.Element => <button>{String(Stripe)}{String(S3Client)}</button>;',
        ].join('\n'),
        'utf8',
      );
      // An .mts module importing the OpenAI SDK.
      await writeFile(
        join(root, 'src', 'mod.mts'),
        "import OpenAI from 'openai';\nexport const o = OpenAI;\n",
        'utf8',
      );
      // A .d.ts declaration that must STILL be ignored.
      await writeFile(
        join(root, 'src', 'shapes.d.ts'),
        "import type { Z } from 'should-be-ignored-tsx';\n",
        'utf8',
      );
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('discovers a provider imported only from a .tsx component', () => {
      const found = collectImports(root);
      expect(found.has('stripe')).toBe(true);
      expect(found.has('@aws-sdk/client-s3')).toBe(true);
    });

    it('discovers a provider imported from a .mts module', () => {
      const found = collectImports(root);
      expect(found.has('openai')).toBe(true);
    });

    it('still skips .d.ts declaration files', () => {
      const found = collectImports(root);
      expect(found.has('should-be-ignored-tsx')).toBe(false);
    });

    it('end-to-end: a Stripe import from .tsx makes the provider non-NOT_USED', () => {
      const env: EnvMap = {
        STRIPE_SECRET_KEY: 'sk_live_9f3kPq2rstuVWXabcdEFGHijklmnop',
        STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH',
      };
      const reports = scanProvidersFromProcess(root, env);
      const stripe = reports.find((r) => r.id === 'stripe');
      expect(stripe?.sdk_imported).toBe(true);
      expect(stripe?.status).not.toBe('NOT_USED');
      expect(stripe?.status).toBe('WIRED');
    });
  });
});

describe('F003 (R3) — type-only imports/exports are not counted as runtime usage', () => {
  // `import type`/`export type` (and per-specifier `{ type X }`) are erased by
  // the TS compiler — they emit no runtime require/import. The R2 scanner
  // counted them as provider usage, producing false-positive "used" providers.
  // R3 skips them while still counting any mixed runtime binding.
  it("import type { X } from 'stripe' → not counted", () => {
    expect(extractModuleSpecifiers("import type { Stripe } from 'stripe';")).toEqual([]);
  });

  it("export type { X } from 'stripe' → not counted", () => {
    expect(extractModuleSpecifiers("export type { Stripe } from 'stripe';")).toEqual([]);
  });

  it('named-only per-specifier type import { type X } → not counted', () => {
    expect(extractModuleSpecifiers("import { type Stripe } from 'stripe';")).toEqual([]);
  });

  it('named-only per-specifier type export { type X } → not counted', () => {
    expect(extractModuleSpecifiers("export { type Stripe } from 'stripe';")).toEqual([]);
  });

  it('mixed import { type X, Y } → ONLY the runtime binding keeps the package', () => {
    // Y is a runtime binding, so the package stays counted. (The collector keys
    // on the package specifier, not the individual binding names.)
    const specs = extractModuleSpecifiers("import { type StripeType, Stripe } from 'stripe';");
    expect(specs).toContain('stripe');
  });

  it('mixed export { type X, Y } → the runtime binding keeps the package', () => {
    const specs = extractModuleSpecifiers("export { type StripeType, Stripe } from 'stripe';");
    expect(specs).toContain('stripe');
  });

  it('plain runtime import { X } → counted (control)', () => {
    expect(extractModuleSpecifiers("import { Stripe } from 'stripe';")).toContain('stripe');
  });

  it("side-effect import 'stripe' → counted (still runtime per R2)", () => {
    expect(extractModuleSpecifiers("import 'stripe';")).toContain('stripe');
  });

  it('default import of a type-erasable module is still a runtime binding → counted', () => {
    // `import Stripe from 'stripe'` (no `type`) introduces a runtime default
    // binding regardless of how the value is used downstream.
    expect(extractModuleSpecifiers("import Stripe from 'stripe';")).toContain('stripe');
  });

  it('namespace import * as is a runtime binding → counted', () => {
    expect(extractModuleSpecifiers("import * as S from 'stripe';")).toContain('stripe');
  });

  it("export * from 'stripe' (runtime star re-export) → counted", () => {
    expect(extractModuleSpecifiers("export * from 'stripe';")).toContain('stripe');
  });

  it('end-to-end: a provider imported ONLY via `import type` reports NOT_USED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-wiring-f003r3-'));
    try {
      // Deliberately NOT under any Stripe filePathHint dir (src/billing,
      // src/stripe, src/checkout) so the only possible signal is the import
      // itself — which is type-only and must therefore not register.
      const srcDir = join(root, 'src', 'typesonly');
      await mkdir(srcDir, { recursive: true });
      // Stripe referenced for TYPES ONLY — no runtime import.
      await writeFile(
        join(srcDir, 'types.ts'),
        "import type { Stripe } from 'stripe';\nexport type Pay = { s: Stripe };\n",
        'utf8',
      );
      const found = collectImports(root);
      expect(found.has('stripe')).toBe(false);
      const env: EnvMap = {
        STRIPE_SECRET_KEY: 'sk_live_9f3kPq2rstuVWXabcdEFGHijklmnop',
        STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH',
      };
      const reports = scanProvidersFromProcess(root, env);
      const stripe = reports.find((r) => r.id === 'stripe');
      // No runtime import and no path hint dir of its own → NOT_USED.
      expect(stripe?.sdk_imported).toBe(false);
      expect(stripe?.status).toBe('NOT_USED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// H4.D R5 regression coverage
//   - R5-F001 (Lens B): IRSA path requires BOTH AWS_ROLE_ARN AND
//     AWS_WEB_IDENTITY_TOKEN_FILE; new EKS Pod Identity branch requires BOTH
//     AWS_CONTAINER_CREDENTIALS_FULL_URI AND AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE.
//   - R5-F001 (Lens A): isPlausibleSupabaseServiceRoleJwt is fail-closed on
//     non-string / empty input.
//   - R5-F002 (Lens A): fileEvidenceOk gates *_FILE vars placed in `requires`,
//     not just those in requiresAnyOf groups.
// ---------------------------------------------------------------------------

describe('R5-F001 (Lens B) — AWS IRSA path requires BOTH role ARN and token file', () => {
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/eks-s3-access';
  const TOKEN_FILE = '/var/run/secrets/eks.amazonaws.com/serviceaccount/token';
  const FILE_EV = 'AWS_WEB_IDENTITY_TOKEN_FILE_EXISTS' as const;

  it('1. region + role ARN + token file (file exists) → WIRED', () => {
    const r = classifyProvider(
      def('aws-s3'),
      true,
      { AWS_REGION: 'us-east-1', AWS_ROLE_ARN: ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE },
      { [FILE_EV]: true },
    );
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining(['AWS_REGION', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE']),
    );
  });

  it('2. token file only, no role ARN → STUB naming the missing AWS_ROLE_ARN', () => {
    const r = wired('aws-s3', { AWS_REGION: 'us-east-1', AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_ROLE_ARN');
  });

  it('3. role ARN only, no token file → STUB naming the missing token file', () => {
    const r = wired('aws-s3', { AWS_REGION: 'us-east-1', AWS_ROLE_ARN: ROLE_ARN });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_WEB_IDENTITY_TOKEN_FILE');
  });

  it('4. role ARN + token file but file does not exist → STUB with non-existent-path diagnostic', () => {
    const r = classifyProvider(
      def('aws-s3'),
      true,
      { AWS_REGION: 'us-east-1', AWS_ROLE_ARN: ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE },
      { [FILE_EV]: false },
    );
    expect(r.status).toBe('STUB');
    expect(r.diagnostic).toBe('AWS_WEB_IDENTITY_TOKEN_FILE points to non-existent path');
  });
});

describe('R5-F001 (Lens B) — AWS EKS Pod Identity branch requires BOTH URI and token file', () => {
  const FULL_URI = 'http://169.254.170.23/v1/credentials';
  const AUTH_FILE = '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token';
  const FILE_EV = 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE_EXISTS' as const;

  it('5. region + full URI + auth token file (file exists) → WIRED', () => {
    const r = classifyProvider(
      def('aws-s3'),
      true,
      {
        AWS_REGION: 'us-east-1',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL_URI,
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: AUTH_FILE,
      },
      { [FILE_EV]: true },
    );
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining([
        'AWS_REGION',
        'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      ]),
    );
  });

  it('6. full URI only, no auth token file → STUB naming the missing token file', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL_URI,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE');
  });

  it('7. auth token file only, no full URI → STUB naming the missing URI', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: AUTH_FILE,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_CONTAINER_CREDENTIALS_FULL_URI');
  });

  it('8. both Pod Identity vars but auth token file does not exist → STUB with diagnostic', () => {
    const r = classifyProvider(
      def('aws-s3'),
      true,
      {
        AWS_REGION: 'us-east-1',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL_URI,
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: AUTH_FILE,
      },
      { [FILE_EV]: false },
    );
    expect(r.status).toBe('STUB');
    expect(r.diagnostic).toBe('AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE points to non-existent path');
  });
});

describe('R5-F001 (Lens B) — AWS credential modes: mixed and region-gated cases', () => {
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/eks-s3-access';
  const TOKEN_FILE = '/var/run/secrets/eks.amazonaws.com/serviceaccount/token';
  const FULL_URI = 'http://169.254.170.23/v1/credentials';
  const AUTH_FILE = '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token';

  it('9. static keys + complete IRSA pair → WIRED (any one alternative satisfies)', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
      AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
      AWS_ROLE_ARN: ROLE_ARN,
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
    });
    expect(r.status).toBe('WIRED');
  });

  it('10. static keys + complete Pod Identity pair → WIRED', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ',
      AWS_SECRET_ACCESS_KEY: 'secret9f3kPq2rstuVWXabcdEFGH',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL_URI,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: AUTH_FILE,
    });
    expect(r.status).toBe('WIRED');
  });

  it('11. partial static keys + complete IRSA pair → WIRED (IRSA branch satisfies)', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ', // no secret → static group incomplete
      AWS_ROLE_ARN: ROLE_ARN,
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
    });
    expect(r.status).toBe('WIRED');
  });

  it('12. AWS_REGION missing + complete IRSA pair → STUB (always-bucket fails)', () => {
    const r = wired('aws-s3', {
      AWS_ROLE_ARN: ROLE_ARN,
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_REGION');
  });

  it('13. AWS_REGION missing + complete Pod Identity pair → STUB (always-bucket fails)', () => {
    const r = wired('aws-s3', {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL_URI,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: AUTH_FILE,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_REGION');
  });
});

describe('R5-F001 (Lens A) — isPlausibleSupabaseServiceRoleJwt is fail-closed on non-string input', () => {
  const validToken = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH';

  it('14. null → false (no throw)', () => {
    expect(isPlausibleSupabaseServiceRoleJwt(null)).toBe(false);
  });

  it('15. undefined → false (no throw)', () => {
    expect(isPlausibleSupabaseServiceRoleJwt(undefined)).toBe(false);
  });

  it('16. number → false (no throw)', () => {
    expect(isPlausibleSupabaseServiceRoleJwt(12345)).toBe(false);
  });

  it('17. object → false (no throw)', () => {
    expect(isPlausibleSupabaseServiceRoleJwt({})).toBe(false);
  });

  it('19. valid service-role JWT string → true (happy-path smoke)', () => {
    expect(isPlausibleSupabaseServiceRoleJwt(validToken)).toBe(true);
  });
});

describe('R5-F002 (Lens A) — fileEvidenceOk gates *_FILE vars placed in `requires`', () => {
  // The seeded PROVIDERS list has no provider with a *_FILE var in `requires`
  // (the only *_FILE vars live in requiresAnyOf groups), so the gap is latent.
  // We declare a synthetic test-only provider (NOT added to PROVIDERS) with a
  // *_FILE var in `requires` and drive classifyProvider directly to prove the
  // always-bucket now consults the same on-disk evidence gate.
  const synthetic: ProviderDef = {
    id: 'synthetic-file',
    label: 'Synthetic (requires-bucket *_FILE)',
    packages: ['synthetic-file-sdk'],
    requires: ['X_TOKEN_FILE'],
    requiresAnyOf: [],
  };

  it('20. *_FILE var in requires + evidence FILE_EXISTS=false → STUB (gate now fires)', () => {
    const r = classifyProvider(
      synthetic,
      true,
      { X_TOKEN_FILE: '/missing' },
      { X_TOKEN_FILE_EXISTS: false },
    );
    expect(r.status).toBe('STUB');
  });

  it('21. same provider + evidence FILE_EXISTS=true → WIRED', () => {
    const r = classifyProvider(
      synthetic,
      true,
      { X_TOKEN_FILE: '/present' },
      { X_TOKEN_FILE_EXISTS: true },
    );
    expect(r.status).toBe('WIRED');
  });
});
