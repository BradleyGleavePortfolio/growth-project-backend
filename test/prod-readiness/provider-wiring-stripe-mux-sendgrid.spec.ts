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
  passesShapeCheck,
  KEY_SHAPE_VALIDATORS,
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
    expect(looksLikePlaceholder('sk_live_51HxYz9abcDEFghijklmnop0123456789')).toBe(false);
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.id).toBe('stripe');
    expect(r.label).toBe('Stripe');
    expect(r.required_vars).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    expect(Array.isArray(r.packages)).toBe(true);
  });

  it('partitions vars into present/missing/placeholder with no overlap', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789', // present
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']));
    expect(r.env_vars_missing).toEqual([]);
    expect(r.env_vars_placeholder).toEqual([]);
  });

  it('test: sk_test_ secret key → placeholder → STUB', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_test_51HxYz9abcDEF',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
  });

  it('missing: webhook secret absent while secret key present → STUB, missing populated', () => {
    const r = wired('stripe', { STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789' });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_present).toContain('STRIPE_SECRET_KEY');
    expect(r.env_vars_missing).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('malformed: placeholder webhook secret → STUB with placeholder list', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.status).toBe('NOT_USED');
    expect(r.sdk_imported).toBe(false);
  });
});

describe('passesShapeCheck + KEY_SHAPE_VALIDATORS (provider key shapes)', () => {
  it('vars with no registered validator always pass the shape gate', () => {
    expect(passesShapeCheck('SENDGRID_API_KEY', 'anything-nonempty')).toBe(true);
    expect(passesShapeCheck('TWILIO_AUTH_TOKEN', 'x')).toBe(true);
  });

  it('STRIPE_SECRET_KEY accepts a long sk_live_/sk_test_ secret', () => {
    expect(passesShapeCheck('STRIPE_SECRET_KEY', 'sk_live_51HxYz9abcDEFghijklmnop0123456789')).toBe(true);
    expect(passesShapeCheck('STRIPE_SECRET_KEY', 'sk_test_51HxYz9abcDEFghijklmnop0123456789')).toBe(true);
  });

  it('STRIPE_SECRET_KEY rejects truncated, publishable (pk_) and restricted (rk_) keys', () => {
    expect(passesShapeCheck('STRIPE_SECRET_KEY', 'sk_live_aaaaa')).toBe(false); // too short
    expect(passesShapeCheck('STRIPE_SECRET_KEY', 'pk_live_publishableABCDEFGHIJKLMNOP')).toBe(false); // wrong type
    expect(passesShapeCheck('STRIPE_SECRET_KEY', 'rk_live_restrictedABCDEFGHIJKLMNOP')).toBe(false); // wrong type
  });

  it('STRIPE_WEBHOOK_SECRET requires whsec_ + ≥20 body chars', () => {
    expect(passesShapeCheck('STRIPE_WEBHOOK_SECRET', 'whsec_9f3kPq2rstuVWXabcdEFGH1234')).toBe(true);
    expect(passesShapeCheck('STRIPE_WEBHOOK_SECRET', 'whsec_short')).toBe(false);
    expect(passesShapeCheck('STRIPE_WEBHOOK_SECRET', 'sk_live_51HxYz9abcDEFghijklmnop0123456789')).toBe(false);
  });

  it('SUPABASE_SERVICE_ROLE_KEY requires a three-segment JWT shape', () => {
    expect(passesShapeCheck('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig9f3')).toBe(true);
    expect(passesShapeCheck('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGci-not-a-jwt')).toBe(false); // no dots
    expect(passesShapeCheck('SUPABASE_SERVICE_ROLE_KEY', 'not-even-close')).toBe(false);
  });

  it('OPENAI_API_KEY requires sk- + ≥20 body chars', () => {
    expect(passesShapeCheck('OPENAI_API_KEY', 'sk-proj-9f3kPq2rstuVWXabcdEFGH')).toBe(true);
    expect(passesShapeCheck('OPENAI_API_KEY', 'sk-tiny')).toBe(false);
    expect(passesShapeCheck('OPENAI_API_KEY', 'pk-proj-9f3kPq2rstuVWXabcdEFGH')).toBe(false);
  });

  it('trims surrounding whitespace before validating shape', () => {
    expect(passesShapeCheck('OPENAI_API_KEY', '  sk-proj-9f3kPq2rstuVWXabcdEFGH  ')).toBe(true);
  });

  it('exposes a validator entry for each shaped provider key', () => {
    expect(Object.keys(KEY_SHAPE_VALIDATORS).sort()).toEqual(
      ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'].sort(),
    );
  });
});

describe('Stripe key-shape classification (malformed/wrong-type keys never WIRE)', () => {
  const goodWebhook = 'whsec_9f3kPq2rstuVWXabcdEFGH1234';

  it('truncated secret key (sk_live_aaaaa) → STUB, secret flagged as placeholder', () => {
    const r = wired('stripe', { STRIPE_SECRET_KEY: 'sk_live_aaaaa', STRIPE_WEBHOOK_SECRET: goodWebhook });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
    expect(r.env_vars_present).not.toContain('STRIPE_SECRET_KEY');
  });

  it('publishable key (pk_live_) in the secret slot → STUB', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'pk_live_publishableABCDEFGHIJKLMNOP',
      STRIPE_WEBHOOK_SECRET: goodWebhook,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
  });

  it('restricted key (rk_live_) in the secret slot → STUB', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'rk_live_restrictedABCDEFGHIJKLMNOP',
      STRIPE_WEBHOOK_SECRET: goodWebhook,
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
  });

  it('malformed webhook secret (too short) → STUB even with a valid secret key', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_short',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('well-formed secret + webhook → WIRED (shape gate lets real keys through)', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: goodWebhook,
    });
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toEqual(
      expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
    );
  });
});

describe('KEY_SHAPE_VALIDATORS predicates exercised directly', () => {
  it('STRIPE_SECRET_KEY validator accepts boundary length (exactly 24 body chars)', () => {
    const body24 = 'A'.repeat(24);
    expect(KEY_SHAPE_VALIDATORS.STRIPE_SECRET_KEY(`sk_live_${body24}`)).toBe(true);
    expect(KEY_SHAPE_VALIDATORS.STRIPE_SECRET_KEY(`sk_live_${'A'.repeat(23)}`)).toBe(false);
  });

  it('STRIPE_SECRET_KEY validator rejects non-alphanumeric body characters', () => {
    expect(KEY_SHAPE_VALIDATORS.STRIPE_SECRET_KEY('sk_live_has spaces and more chars here')).toBe(false);
    expect(KEY_SHAPE_VALIDATORS.STRIPE_SECRET_KEY('sk_live_has-dashes-and-more-chars-here')).toBe(false);
  });

  it('STRIPE_WEBHOOK_SECRET validator enforces the whsec_ prefix exactly', () => {
    expect(KEY_SHAPE_VALIDATORS.STRIPE_WEBHOOK_SECRET(`whsec_${'B'.repeat(20)}`)).toBe(true);
    expect(KEY_SHAPE_VALIDATORS.STRIPE_WEBHOOK_SECRET(`wsec_${'B'.repeat(20)}`)).toBe(false);
    expect(KEY_SHAPE_VALIDATORS.STRIPE_WEBHOOK_SECRET(`whsec_${'B'.repeat(19)}`)).toBe(false);
  });

  it('SUPABASE_SERVICE_ROLE_KEY validator decodes JWT segments offline (F001)', () => {
    // A genuinely valid HS256 service-role token: header {"alg":"HS256"},
    // payload {"role":"service_role"}, non-empty signature.
    const valid =
      'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.9f3kPq2rstuVWXabcdEFGH';
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY(valid)).toBe(true);
    // F001: matches the old segment regex but decodes to invalid JSON → reject.
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY('eyJbad.abc.def')).toBe(false);
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY('eyJa.bbb.ccc')).toBe(false); // not valid base64url JSON
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY('eyJa.bbb')).toBe(false); // two segments
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY(`${valid}.ddd`)).toBe(false); // four segments
    expect(KEY_SHAPE_VALIDATORS.SUPABASE_SERVICE_ROLE_KEY('xyz.bbb.ccc')).toBe(false); // wrong header prefix
  });

  it('OPENAI_API_KEY validator accepts underscores/dashes and rejects short bodies', () => {
    expect(KEY_SHAPE_VALIDATORS.OPENAI_API_KEY(`sk-${'c'.repeat(20)}`)).toBe(true);
    expect(KEY_SHAPE_VALIDATORS.OPENAI_API_KEY('sk-proj_under-dash-9f3kPq2rst')).toBe(true);
    expect(KEY_SHAPE_VALIDATORS.OPENAI_API_KEY(`sk-${'c'.repeat(19)}`)).toBe(false);
  });
});

describe('shape gate interaction with placeholder gate', () => {
  it('a placeholder value short-circuits before the shape check (still STUB)', () => {
    // 'sk_test_' prefix is a placeholder AND a valid secret shape; placeholder
    // wins, keeping the var out of the present bucket.
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: `sk_test_${'Z'.repeat(30)}`,
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
  });

  it('a malformed-but-non-placeholder value is bucketed as placeholder by the shape gate', () => {
    const r = wired('stripe', {
      STRIPE_SECRET_KEY: 'sk_live_aaaaa', // not a sentinel, just malformed
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
    });
    expect(r.env_vars_placeholder).toContain('STRIPE_SECRET_KEY');
    expect(r.env_vars_missing).not.toContain('STRIPE_SECRET_KEY');
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
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
    const env: EnvMap = { STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789' };
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
      STRIPE_SECRET_KEY: 'sk_live_51HxYz9abcDEFghijklmnop0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_9f3kPq2rstuVWXabcdEFGH1234',
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
