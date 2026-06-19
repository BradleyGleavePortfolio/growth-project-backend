// provider-wiring-stripe-mux-sendgrid.spec.ts
//
// Coverage (part 1 of 2) for the provider-wiring scanner. This file drives the
// payments/media/email providers (Stripe, Mux, SendGrid) plus the pure
// placeholder-detection predicate that every provider relies on. Part 2
// (provider-wiring-twilio-aws-fly-sentry-supabase-openai-cf.spec.ts) covers the
// remaining seven providers and the I/O edge + summary helpers.
//
// Every case drives the scanner through an INJECTED env map and an INJECTED
// import/path set — no real process.env and no filesystem are read by the core
// assertions, satisfying the testability boundary of the module under test.

import {
  PROVIDERS,
  classifyProvider,
  isSdkImported,
  scanProvidersWith,
  looksLikePlaceholder,
  type ProviderDef,
  type EnvMap,
  type ProviderReport,
} from './provider-wiring';

/** Look up a provider definition by id; fail loudly if the seed list drifts. */
function def(id: string): ProviderDef {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`provider def not found: ${id}`);
  return found;
}

/** Classify a single provider as if its SDK is imported, with the given env. */
function wired(id: string, env: EnvMap): ProviderReport {
  return classifyProvider(def(id), true, env);
}

/** Classify a single provider as if its SDK is NOT imported. */
function dormant(id: string, env: EnvMap): ProviderReport {
  return classifyProvider(def(id), false, env);
}

describe('looksLikePlaceholder (pure predicate)', () => {
  it('flags empty and whitespace-only values', () => {
    expect(looksLikePlaceholder('')).toBe(true);
    expect(looksLikePlaceholder('   ')).toBe(true);
    expect(looksLikePlaceholder('\t\n')).toBe(true);
  });

  it('flags substring sentinels case-insensitively', () => {
    expect(looksLikePlaceholder('CHANGEME-now')).toBe(true);
    expect(looksLikePlaceholder('my-placeholder-key')).toBe(true);
    expect(looksLikePlaceholder('TODO')).toBe(true);
    expect(looksLikePlaceholder('xxx')).toBe(true);
    expect(looksLikePlaceholder('value-REDACTED')).toBe(true);
  });

  it('flags the sk_test_ prefix (Stripe test mode) but not mid-string', () => {
    expect(looksLikePlaceholder('sk_test_abc123')).toBe(true);
    // The fragment appears mid-value, not at the start — must NOT be flagged.
    expect(looksLikePlaceholder('real_sk_test_inside')).toBe(false);
  });

  it('accepts a realistic non-placeholder secret', () => {
    expect(looksLikePlaceholder('sk_live_51HxYz9abcDEF')).toBe(false);
    expect(looksLikePlaceholder('a-perfectly-normal-token-9f3')).toBe(false);
  });
});

describe('looksLikePlaceholder — extended sentinel coverage', () => {
  it('flags each documented substring sentinel', () => {
    const sentinels = [
      'change-me', 'your-key', 'your_key', 'yourkey', 'tbd', 'fixme',
      'fake', 'example', 'insert_key_here', 'sk_test_replace', 'whsec_replace',
    ];
    for (const s of sentinels) {
      expect(looksLikePlaceholder(`prefix-${s}-suffix`)).toBe(true);
    }
  });

  it('trims surrounding whitespace before evaluating', () => {
    // A value that is only whitespace is a placeholder...
    expect(looksLikePlaceholder('     ')).toBe(true);
    // ...and a real value padded with whitespace is NOT a placeholder.
    expect(looksLikePlaceholder('  sk_live_realKey9f3  ')).toBe(false);
  });

  it('treats the sk_test_ prefix as a placeholder even with trailing content', () => {
    expect(looksLikePlaceholder('sk_test_')).toBe(true);
    expect(looksLikePlaceholder('SK_TEST_UPPER')).toBe(true);
  });

  it('does not flag values that merely resemble but do not contain sentinels', () => {
    expect(looksLikePlaceholder('production-grade-secret-001')).toBe(false);
    expect(looksLikePlaceholder('whsec_realRotatedValue')).toBe(false);
  });
});

describe('ProviderReport shape invariants', () => {
  it('always echoes the provider id, label, packages and required_vars', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
    });
    expect(r.id).toBe('stripe');
    expect(r.label).toBe('Stripe');
    expect(r.required_vars).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    expect(Array.isArray(r.packages)).toBe(true);
  });

  it('partitions vars into present/missing/placeholder with no overlap', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF', // present
      STRIPE_WEBHOOK_SECRET: 'todo',              // placeholder
    });
    const all = [...r.env_vars_present, ...r.env_vars_missing, ...r.env_vars_placeholder];
    // No var appears in more than one bucket.
    expect(new Set(all).size).toBe(all.length);
    expect(r.env_vars_present).toContain('STRIPE_SECRET_KEY');
    expect(r.env_vars_placeholder).toContain('STRIPE_WEBHOOK_SECRET');
    expect(r.env_vars_missing).toEqual([]);
  });

  it('reports sdk_imported faithfully for the imported and dormant cases', () => {
    expect(wired('mux', {}).sdk_imported).toBe(true);
    expect(dormant('mux', {}).sdk_imported).toBe(false);
  });
});

describe('Stripe provider', () => {
  it('live: both required vars present + non-placeholder → WIRED', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']));
    expect(r.env_vars_missing).toEqual([]);
    expect(r.env_vars_placeholder).toEqual([]);
  });

  it('test: sk_test_ secret key → placeholder → STUB', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_test_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
  });

  it('missing: webhook secret absent while secret key present → STUB, missing populated', () => {
    const r = wired('stripe', { STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_present).toContain('STRIPE_SECRET_KEY');
    expect(r.env_vars_missing).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('malformed: placeholder webhook secret → STUB with placeholder list', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_replace',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('empty env → both vars missing → STUB (SDK imported but unwired)', () => {
    const r = wired('stripe', {});
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toEqual(expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']));
  });

  it('dormant: SDK not imported → NOT_USED regardless of env', () => {
    const r = dormant('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('NOT_USED');
    expect(r.sdk_imported).toBe(false);
  });
});

describe('Mux provider', () => {
  it('live: both token id + secret present → WIRED', () => {
    const r = wired('mux', {
      MUX_TOKEN_ID: '0a1b2c3d-token-id',
      MUX_TOKEN_SECRET: 'mux-secret-9f3kPq2rstuVWX',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(expect.arrayContaining(['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET']));
  });

  it('test/placeholder: token secret is an example value → STUB', () => {
    const r = wired('mux', {
      MUX_TOKEN_ID: '0a1b2c3d-token-id',
      MUX_TOKEN_SECRET: 'example-secret',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('MUX_TOKEN_SECRET');
  });

  it('missing: token id absent → STUB, missing populated', () => {
    const r = wired('mux', { MUX_TOKEN_SECRET: 'mux-secret-9f3kPq2rstuVWX' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('MUX_TOKEN_ID');
  });

  it('empty-string value counts as missing (not placeholder)', () => {
    const r = wired('mux', { MUX_TOKEN_ID: '', MUX_TOKEN_SECRET: 'mux-secret-9f3kPq2rstuVWX' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('MUX_TOKEN_ID');
    expect(r.env_vars_placeholder).not.toContain('MUX_TOKEN_ID');
  });
});

describe('SendGrid provider', () => {
  it('live: api key present + non-placeholder → WIRED', () => {
    const r = wired('sendgrid', { SENDGRID_API_KEY: 'SG.realKey9f3kPq2rstuVWX.longsuffix' });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('SENDGRID_API_KEY');
  });

  it('placeholder: api key is a fake sentinel → STUB', () => {
    const r = wired('sendgrid', { SENDGRID_API_KEY: 'your-key-here' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('SENDGRID_API_KEY');
  });

  it('missing: empty env → STUB with SENDGRID_API_KEY missing', () => {
    const r = wired('sendgrid', {});
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('SENDGRID_API_KEY');
  });

  it('dormant: SDK not imported with a valid key → NOT_USED', () => {
    const r = dormant('sendgrid', { SENDGRID_API_KEY: 'SG.realKey9f3kPq2rstuVWX.longsuffix' });
    expect(r.status).toBe('NOT_USED');
  });
});

describe('isSdkImported (pure detection helper) for part-1 providers', () => {
  it('detects Stripe via package import', () => {
    expect(isSdkImported(def('stripe'), new Set(['stripe']), new Set())).toBe(true);
  });

  it('detects Stripe via file-path hint when package absent', () => {
    expect(isSdkImported(def('stripe'), new Set(), new Set(['src/billing']))).toBe(true);
  });

  it('detects Mux via the @mux/mux-node package', () => {
    expect(isSdkImported(def('mux'), new Set(['@mux/mux-node']), new Set())).toBe(true);
  });

  it('detects SendGrid via the @sendgrid/mail package', () => {
    expect(isSdkImported(def('sendgrid'), new Set(['@sendgrid/mail']), new Set())).toBe(true);
  });

  it('returns false when neither package nor path hint matches', () => {
    expect(isSdkImported(def('stripe'), new Set(['openai']), new Set(['src/unrelated']))).toBe(false);
  });
});

describe('classifyProvider env-map injection guarantees', () => {
  it('reads ONLY the injected map — unrelated keys never leak into a report', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
      // Decoy keys for OTHER providers must be ignored by a Stripe classify.
      OPENAI_API_KEY: 'sk-proj-decoy',
      MUX_TOKEN_ID: 'decoy',
    });
    expect(r.env_vars_present).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    expect(r.env_vars_present).not.toContain('OPENAI_API_KEY');
    expect(r.env_vars_present).not.toContain('MUX_TOKEN_ID');
  });

  it('is a pure function — repeated calls with the same input return equal reports', () => {
    const env: EnvMap = { SENDGRID_API_KEY: 'SG.realKey9f3kPq2rstuVWX.longsuffix' };
    const a = wired('sendgrid', env);
    const b = wired('sendgrid', env);
    expect(a).toEqual(b);
  });

  it('does not mutate the injected env map', () => {
    const env: EnvMap = { STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF' };
    const before = JSON.stringify(env);
    wired('stripe', env);
    expect(JSON.stringify(env)).toBe(before);
  });
});

describe('scanProvidersWith over a part-1 subset', () => {
  const subset = [def('stripe'), def('mux'), def('sendgrid')];

  it('classifies a mixed import/env set into WIRED + STUB + NOT_USED', () => {
    const imported = new Set(['stripe', '@mux/mux-node']); // sendgrid NOT imported
    const env: EnvMap = {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWX',
      MUX_TOKEN_ID: '0a1b2c3d-token-id',
      // MUX_TOKEN_SECRET missing → Mux STUB
      SENDGRID_API_KEY: 'SG.realKey9f3kPq2rstuVWX.longsuffix',
    };
    const reports = scanProvidersWith(imported, new Set(), env, subset);
    const byId = Object.fromEntries(reports.map((r) => [r.id, r.status]));
    expect(byId.stripe).toBe('WIRED');
    expect(byId.mux).toBe('STUB');
    expect(byId.sendgrid).toBe('NOT_USED');
  });

  it('returns one report per provider in input order', () => {
    const reports = scanProvidersWith(new Set(), new Set(), {}, subset);
    expect(reports.map((r) => r.id)).toEqual(['stripe', 'mux', 'sendgrid']);
  });
});
