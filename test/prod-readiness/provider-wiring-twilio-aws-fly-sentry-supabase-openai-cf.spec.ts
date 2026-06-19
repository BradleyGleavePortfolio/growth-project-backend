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
  type ProviderDef,
  type EnvMap,
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
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGci9f3kPq2rstuVWXabcdEFGH',
    });
    expect(r.status).toBe('WIRED');
  });

  it('placeholder: service role key is TODO → STUB', () => {
    const r = wired('supabase', { SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'TODO' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('missing: url absent → STUB', () => {
    const r = wired('supabase', { SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGci9f3kPq2rstuVWXabcdEFGH' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('SUPABASE_URL');
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
    }, filterProviders(PROVIDERS, 'stripe'));
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe('WIRED');
  });
});

describe('getProductionBlockers summary', () => {
  it('returns only STUB providers (imported-but-unwired); excludes NOT_USED and WIRED', () => {
    const imported = new Set(['stripe', 'openai']); // supabase NOT imported → NOT_USED
    const env: EnvMap = {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX', // stripe WIRED
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
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGci9f3kPq2rstuVWXabcdEFGH',
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
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
    // A source file that imports the OpenAI SDK and a scoped AWS SDK.
    await writeFile(
      join(srcBilling, 'pay.ts'),
      [
        "import OpenAI from 'openai';",
        "import { S3Client } from '@aws-sdk/client-s3';",
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

  it('scanProvidersFromProcess wires OpenAI/AWS from the temp repo + injected env', () => {
    const env: EnvMap = {
      OPENAI_API_KEY: 'sk-proj-9f3kPq2rstuVWXabcdEFGH',
      AWS_REGION: 'us-east-1',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
      // stripe detected via src/billing path hint but no keys → STUB
    };
    const reports = scanProvidersFromProcess(root, env);
    const byId = Object.fromEntries(reports.map((r) => [r.id, r.status]));
    expect(byId.openai).toBe('WIRED');
    expect(byId['aws-s3']).toBe('WIRED');
    expect(byId.stripe).toBe('STUB'); // imported via path hint, but keys absent
    expect(byId.sendgrid).toBe('NOT_USED'); // neither package nor path present
  });
});
