/**
 * Unit tests for prod-readiness/provider-wiring.ts.
 *
 * Two surfaces: the exported looksLikePlaceholder predicate (F-A08/F-A09) —
 * the single source of truth the spec also imports — and scanProviders, driven
 * against synthetic src/ trees so import detection, env classification, and the
 * WIRED/STUB/NOT_USED state machine are pinned down. Special attention to the
 * AWS either/or credential groups (F-B13) and the Perplexity import/dir
 * tightening (F-B14).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { looksLikePlaceholder, scanProviders, type ProviderReport } from '../provider-wiring';

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function reportFor(reports: ProviderReport[], id: string): ProviderReport {
  const r = reports.find((p) => p.id === id);
  if (!r) throw new Error(`provider ${id} not found`);
  return r;
}

describe('provider-wiring / looksLikePlaceholder', () => {
  it('treats an empty or whitespace string as a placeholder', () => {
    expect(looksLikePlaceholder('')).toBe(true);
    expect(looksLikePlaceholder('   ')).toBe(true);
  });

  it.each([
    'changeme', 'CHANGE-ME', 'your-key', 'YOUR_KEY', 'placeholder',
    'TODO', 'tbd', 'xxx', 'fixme', 'fake', 'example', 'insert_key_here',
    'sk_test_replace', 'whsec_replace', 'redacted',
  ])('flags the sentinel substring %s (case-insensitive)', (value) => {
    expect(looksLikePlaceholder(value)).toBe(true);
    expect(looksLikePlaceholder(`prefix-${value}-suffix`)).toBe(true);
  });

  it('flags a Stripe TEST-mode key by prefix (F-A08)', () => {
    expect(looksLikePlaceholder('sk_test_abc123')).toBe(true);
  });

  it('does NOT flag a Stripe live key', () => {
    expect(looksLikePlaceholder('sk_live_realsecret')).toBe(false);
  });

  it('does NOT flag a normal, realistic secret value', () => {
    expect(looksLikePlaceholder('R3alV4lue-9f2a8c')).toBe(false);
  });

  it('anchors the sk_test_ prefix at the start only', () => {
    // A value that merely contains the fragment mid-string is not a prefix hit;
    // (it would only flag if a substring sentinel also matched, which it does not).
    expect(looksLikePlaceholder('XYZsk_test_notprefix')).toBe(false);
  });
});

describe('provider-wiring / scanProviders — used detection', () => {
  it('marks a provider NOT_USED when its SDK is never imported', () => {
    const root = makeRepo({ 'src/app.ts': 'export const x = 1;\n' });
    expect(reportFor(scanProviders(root, {}), 'openai').status).toBe('NOT_USED');
  });

  it('detects a provider via a bare package import', () => {
    const root = makeRepo({ 'src/ai.ts': "import OpenAI from 'openai';\n" });
    const r = reportFor(scanProviders(root, {}), 'openai');
    expect(r.sdk_imported).toBe(true);
    // No OPENAI_API_KEY → STUB.
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('OPENAI_API_KEY');
  });

  it('normalizes a scoped subpath import to the scoped package id', () => {
    const root = makeRepo({ 'src/db.ts': "import { createClient } from '@supabase/supabase-js';\n" });
    expect(reportFor(scanProviders(root, {}), 'supabase').sdk_imported).toBe(true);
  });

  it('detects a provider via a file-path hint directory', () => {
    const root = makeRepo({ 'src/billing/stripe.ts': 'export const s = 1;\n' });
    expect(reportFor(scanProviders(root, {}), 'stripe').sdk_imported).toBe(true);
  });

  it('does not count a relative import as a package import', () => {
    const root = makeRepo({ 'src/x.ts': "import { y } from './local-openai';\n" });
    expect(reportFor(scanProviders(root, {}), 'openai').sdk_imported).toBe(false);
  });
});

describe('provider-wiring / scanProviders — env classification', () => {
  it('reports WIRED when the SDK is imported and all required vars are real', () => {
    const root = makeRepo({ 'src/ai.ts': "import OpenAI from 'openai';\n" });
    const r = reportFor(scanProviders(root, { OPENAI_API_KEY: 'sk_live_real' }), 'openai');
    expect(r.status).toBe('WIRED');
    expect(r.env_vars_present).toContain('OPENAI_API_KEY');
  });

  it('reports STUB with the var listed as placeholder when the value is a sentinel', () => {
    const root = makeRepo({ 'src/ai.ts': "import OpenAI from 'openai';\n" });
    const r = reportFor(scanProviders(root, { OPENAI_API_KEY: 'changeme' }), 'openai');
    expect(r.status).toBe('STUB');
    expect(r.env_vars_placeholder).toContain('OPENAI_API_KEY');
  });

  it('lists each unset required var under env_vars_missing', () => {
    const root = makeRepo({ 'src/billing/x.ts': '' });
    const r = reportFor(scanProviders(root, {}), 'stripe');
    expect(r.env_vars_missing).toEqual(expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']));
  });
});

describe('provider-wiring / AWS S3 either-or credentials (F-B13)', () => {
  // AWS provider is detected via the @aws-sdk/client-s3 import.
  const awsImport = "import { S3Client } from '@aws-sdk/client-s3';\n";

  it('is STUB with only region set, surfacing the smaller web-identity group', () => {
    const root = makeRepo({ 'src/s3.ts': awsImport });
    const r = reportFor(scanProviders(root, { AWS_REGION: 'us-east-1' }), 'aws-s3');
    expect(r.status).toBe('STUB');
    // The best (fewest-gap) group is the single web-identity var.
    expect(r.env_vars_missing).toContain('AWS_WEB_IDENTITY_TOKEN_FILE');
    expect(r.env_vars_missing).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('is WIRED with region + static access keys', () => {
    const root = makeRepo({ 'src/s3.ts': awsImport });
    const r = reportFor(scanProviders(root, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAREAL',
      AWS_SECRET_ACCESS_KEY: 'secretreal',
    }), 'aws-s3');
    expect(r.status).toBe('WIRED');
  });

  it('is WIRED with region + a web-identity token file (IAM path)', () => {
    const root = makeRepo({ 'src/s3.ts': awsImport });
    const r = reportFor(scanProviders(root, {
      AWS_REGION: 'us-east-1',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
    }), 'aws-s3');
    expect(r.status).toBe('WIRED');
  });

  it('is STUB when region is missing even if static keys are present', () => {
    const root = makeRepo({ 'src/s3.ts': awsImport });
    const r = reportFor(scanProviders(root, {
      AWS_ACCESS_KEY_ID: 'AKIAREAL',
      AWS_SECRET_ACCESS_KEY: 'secretreal',
    }), 'aws-s3');
    expect(r.status).toBe('STUB');
    expect(r.env_vars_missing).toContain('AWS_REGION');
  });
});

describe('provider-wiring / Perplexity tightening (F-B14)', () => {
  it('is NOT_USED when neither the package import nor src/perplexity exists', () => {
    const root = makeRepo({ 'src/notes.ts': '// mentions perplexity in a comment only\n' });
    expect(reportFor(scanProviders(root, {}), 'perplexity').status).toBe('NOT_USED');
  });

  it('is detected when the src/perplexity directory exists', () => {
    const root = makeRepo({ 'src/perplexity/client.ts': 'export const c = 1;\n' });
    expect(reportFor(scanProviders(root, {}), 'perplexity').sdk_imported).toBe(true);
  });

  it('is detected via the real package import', () => {
    const root = makeRepo({ 'src/ai.ts': "import { Perplexity } from '@perplexity-ai/perplexity_ai';\n" });
    expect(reportFor(scanProviders(root, {}), 'perplexity').sdk_imported).toBe(true);
  });
});

describe('provider-wiring / scanProviders — shape + stability', () => {
  it('returns a report for every configured provider', () => {
    const reports = scanProviders(makeRepo({ 'src/x.ts': '' }), {});
    const ids = reports.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['supabase', 'stripe', 'openai', 'aws-s3', 'perplexity', 'redis']));
  });

  it('is deterministic across repeated scans', () => {
    const root = makeRepo({ 'src/ai.ts': "import OpenAI from 'openai';\n" });
    expect(scanProviders(root, {})).toEqual(scanProviders(root, {}));
  });
});
