// provider-wiring-twilio-aws-fly-sentry-supabase-openai-cf.spec.ts
//
// Coverage (part 2 of 2) for the provider-wiring scanner. Covers the remaining
// seven providers (Twilio, AWS S3, Fly.io, Sentry, Supabase, OpenAI,
// Cloudflare), the either/or AWS credential logic (static keys vs IAM
// web-identity token), the `--provider` filter, the `getProductionBlockers`
// summary, and the filesystem I/O edges (collectImports / collectPathPresence /
// scanProvidersFromProcess) driven against a throwaway temp directory.

import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  type ProviderDef,
  type EnvMap,
  type EvidenceMap,
  type ProviderReport,
} from './provider-wiring';

function def(id: string): ProviderDef {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`provider def not found: ${id}`);
  return found;
}

function wired(id: string, env: EnvMap): ProviderReport {
  return classifyProvider(def(id), true, env);
}

function dormant(id: string, env: EnvMap): ProviderReport {
  return classifyProvider(def(id), false, env);
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
    const r = wired('twilio', { TWILIO_ACCOUNT_SID: live.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: live.TWILIO_AUTH_TOKEN });
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
    expect(r.env_vars_present).toEqual(expect.arrayContaining(['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']));
    expect(r.env_vars_missing).toEqual([]);
  });

  it('live via IAM role: region + web-identity token file, no static keys → WIRED', () => {
    const r = wired('aws-s3', {
      AWS_REGION: 'us-east-1',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks.amazonaws.com/serviceaccount/token',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(expect.arrayContaining(['AWS_REGION', 'AWS_WEB_IDENTITY_TOKEN_FILE']));
  });

  it('missing creds: region present but NO credential group satisfied → STUB', () => {
    const r = wired('aws-s3', { AWS_REGION: 'us-east-1' });
    expect(r.status).toBe('STUB');
    // The actionable (fewest-gaps) group surfaced is the single-var IAM group.
    expect(r.env_vars_missing).toContain('AWS_WEB_IDENTITY_TOKEN_FILE');
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
    const r = wired('aws-s3', { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA9F3KPQ2RSTUVWXYZ' });
    expect(r.status).toBe('STUB');
    // Best (fewest-gaps) group here is the static-key group missing the secret.
    expect(r.env_vars_missing).toContain('AWS_SECRET_ACCESS_KEY');
  });
});

describe('AWS web-identity token-file existence (evidence map, pure core)', () => {
  const iamEnv: EnvMap = {
    AWS_REGION: 'us-east-1',
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
    const specs = extractModuleSpecifiers("async function f() { return await import('@aws-sdk/client-s3'); }");
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

  it('captures type-only imports (import type X from) too', () => {
    const specs = extractModuleSpecifiers("import type { Stripe } from 'stripe';");
    expect(specs).toContain('stripe');
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
    const r = classifyProvider(def('fly'), isSdkImported(def('fly'), new Set(), new Set(['fly.toml'])), {
      FLY_API_TOKEN: 'fo1_9f3kPq2rstuVWXabcdEFGH',
    });
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
    const r = wired('sentry', { SENTRY_DSN: 'fake-dsn', SENTRY_AUTH_TOKEN: 'sntrys_9f3kPq2rstuVWX' });
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
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: service role key is TODO → STUB', () => {
    const r = wired('supabase', { SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'TODO' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('missing: url absent → STUB', () => {
    const r = wired('supabase', { SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH' });
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
    const r = wired('cloudflare', { CLOUDFLARE_ACCOUNT_ID: '9f3kpq2rstuvwxabcdef0123456789ab', CLOUDFLARE_API_TOKEN: 'yourkey' });
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
    const reports = scanProvidersWith(new Set(['stripe']), new Set(), {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    }, filterProviders(PROVIDERS, 'stripe'));
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
    const reports = scanProvidersWith(imported, new Set(), env, [def('stripe'), def('openai'), def('supabase')]);
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
    const imported = new Set(
      PROVIDERS.flatMap((p) => p.packages),
    );
    // Path hints for the package-less / hint-detected providers.
    const paths = new Set(['src/billing', 'src/email', 'src/sms', 'src/cdn', 'src/video', 'fly.toml']);
    const env: EnvMap = {
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH',
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
      ['aws-s3', 'cloudflare', 'fly', 'mux', 'openai', 'sendgrid', 'sentry', 'stripe', 'supabase', 'twilio'].sort(),
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
    await writeFile(join(srcBilling, 'types.d.ts'), "import type { Foo } from 'should-be-ignored';\n", 'utf8');
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
