/**
 * S-ENVTRUTH — unit tests for the in-machine env-truth classifier
 * (scripts/env-truth/fly-env-classifier.js) against a fake env, including an
 * end-to-end run of the exact inline program the workflow ships through
 * `flyctl ssh console -C`, executed here in a child `node` with a fake env.
 * The central assertion everywhere: no fake value ever appears in any output.
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  NAMES_ENV,
  REPORT_MARKER,
  buildRemoteCommand,
  encodeNames,
  namesFromEnv,
  buildRemoteProgram,
  classifyEnv,
  duplicateGroups,
  extractRegisteredNames,
  lengthBucket,
  parseRemoteOutput,
  placeholderPattern,
  renderMarkdown,
  shapeChecks,
  suspiciousName,
} from '../../scripts/env-truth/fly-env-classifier';

const ROOT = path.join(__dirname, '..', '..');
const CLASSIFIER = path.join(ROOT, 'scripts/env-truth/fly-env-classifier.js');

// Distinctive fake values so a leak is unambiguous.
const SHARED = 'leakcanary-shared-7f3a9c1e5b2d4f60';
const UNIQUE = 'leakcanary-unique-0b1c2d3e4f5a6b7c8d9e';
const FAKE_ENV: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT_ID: SHARED,
  GOOGLE_OAUTH_CLIENT_SECRET: SHARED,
  OOM_OAUTH_CLIENT_ID: SHARED,
  STRIPE_WEBHOOK_SECRET: UNIQUE,
  METRICS_AUTH_TOKEN: '',
  DATA_EXPORT_TOKEN_SECRET: 'change-me-in-production-min32chars!',
  KMS_MASTER_KEY: '<kms-master-key>',
  SENTRY_DSN: 'https://abc@example.com/1',
  E: 'leakcanary-junk',
  E_MB: 'leakcanary-junk2',
};
const REGISTERED = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'METRICS_AUTH_TOKEN',
  'DATA_EXPORT_TOKEN_SECRET',
  'KMS_MASTER_KEY',
  'SENTRY_DSN',
  'NEVER_SET_ANYWHERE',
];

function expectNoValues(text: string): void {
  for (const v of Object.values(FAKE_ENV)) {
    if (v.length >= 6) expect(text).not.toContain(v);
  }
  expect(text).not.toMatch(/leakcanary/);
}

describe('placeholderPattern', () => {
  it.each([
    ['<value>', 'angle-brackets'],
    ['changeme', 'sentinel-word'],
    ['TODO', 'sentinel-word'],
    ['sk_test_XXXXXXXXXXXX', 'x-run'],
    ['aaaaaaa', 'repeated-char'],
    ['change-me-in-production-min32chars!', 'known-dev-default'],
    ['test-secret-123', 'placeholder-prefix'],
    ['https://api.example.com/x', 'example-domain'],
    ['redis://localhost:6379', 'localhost'],
    // Key-shaped literals are assembled at runtime so secret scanners do not
    // mistake these fixtures for real keys.
    [['sk', 'test', '51Habcdefghijk'].join('_'), 'test-mode-key'],
    ['"quoted-value-abc"', 'wrapped-in-quotes'],
    [' padded-value ', 'surrounding-whitespace'],
  ])('%j -> %s', (value, id) => {
    expect(placeholderPattern(value)).toBe(id);
  });

  it.each([
    ['sk', 'live', '51Hq8ZtJ3kLmNoPqRsTuVwXy'].join('_'),
    ['whsec', '9f8e7d6c5b4a3f2e1d0c9b8a'].join('_'),
    'postgresql://user:pw@db.supabase.co:6543/postgres?pgbouncer=true',
    'https://app.trygrowthproject.com/join',
    'dGVzdC1rZXktMzItYnl0ZXMtZm9yLXVuaXQtdGVzdGluZw==',
    'production',
    '3000',
  ])('real-shaped value %j is not a placeholder', (value) => {
    expect(placeholderPattern(value)).toBeNull();
  });

  it('returns null for empty input (empty is reported separately)', () => {
    expect(placeholderPattern('')).toBeNull();
  });
});

describe('lengthBucket / suspiciousName', () => {
  it('buckets lengths', () => {
    expect([0, 1, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 4096].map(lengthBucket)).toEqual([
      '0',
      '1-7',
      '1-7',
      '8-15',
      '8-15',
      '16-31',
      '16-31',
      '32-63',
      '32-63',
      '64-127',
      '64-127',
      '128+',
      '128+',
    ]);
  });

  it('flags truncated / malformed names like E and E_MB', () => {
    expect(suspiciousName('E')).toBe(true);
    expect(suspiciousName('E_MB')).toBe(false);
    expect(suspiciousName('lower_case')).toBe(true);
    expect(suspiciousName('DATABASE_URL')).toBe(false);
  });
});

describe('duplicateGroups', () => {
  it('groups keys sharing one value with opaque ids; ignores empty values', () => {
    const g = duplicateGroups({ A: 'same', B: 'same', C: 'other', D: '', E: '' }, [
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(Object.fromEntries(g)).toEqual({ A: 'D1', B: 'D1' });
  });

  it('uses a random salt per run (same env, two runs, no shared hash state leaks into ids)', () => {
    const env = { A: 'v', B: 'v' };
    const s1 = crypto.randomBytes(32);
    const s2 = crypto.randomBytes(32);
    expect(Object.fromEntries(duplicateGroups(env, ['A', 'B'], s1))).toEqual(
      Object.fromEntries(duplicateGroups(env, ['A', 'B'], s2)),
    );
  });
});

describe('classifyEnv against a fake env', () => {
  const report = classifyEnv(FAKE_ENV, REGISTERED, { now: '2026-10-01T00:00:00.000Z' });
  const row = (n: string) => report.rows.find((r) => r.name === n)!;

  it('reports present/missing, empty, placeholder, duplicate group, length bucket', () => {
    expect(row('NEVER_SET_ANYWHERE')).toMatchObject({
      registered: true,
      present: false,
      lengthBucket: '0',
    });
    expect(row('METRICS_AUTH_TOKEN')).toMatchObject({ present: true, empty: true });
    expect(row('KMS_MASTER_KEY').placeholder).toBe('angle-brackets');
    expect(row('DATA_EXPORT_TOKEN_SECRET').placeholder).toBe('known-dev-default');
    expect(row('SENTRY_DSN').placeholder).toBe('example-domain');
    const g = row('GOOGLE_OAUTH_CLIENT_ID').duplicateGroup;
    expect(g).toMatch(/^D\d+$/);
    expect(row('GOOGLE_OAUTH_CLIENT_SECRET').duplicateGroup).toBe(g);
    expect(row('OOM_OAUTH_CLIENT_ID')).toMatchObject({ registered: false, duplicateGroup: g });
    expect(row('STRIPE_WEBHOOK_SECRET')).toMatchObject({
      duplicateGroup: null,
      lengthBucket: '32-63',
    });
    expect(row('E')).toMatchObject({ registered: false, suspiciousName: true });
  });

  it('summarises', () => {
    expect(report.summary).toMatchObject({
      registered: 8,
      registeredMissing: 1,
      empty: 1,
      duplicateGroups: 1,
      duplicateKeys: 3,
      unregisteredPresent: 3,
    });
  });

  it('never carries a value in the report or the rendered markdown', () => {
    expectNoValues(JSON.stringify(report));
    const md = renderMarkdown(report, 'backend-spring-lake-3890');
    expectNoValues(md);
    expect(md).toContain('| GOOGLE_OAUTH_CLIENT_ID | yes |');
    expect(md).toContain('`NEVER_SET_ANYWHERE`');
  });
});

describe('value-shape checks (pass/fail only)', () => {
  const FP = Array.from({ length: 32 }, (_, i) =>
    (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0'),
  ).join(':');

  it.each([
    ['com.growthproject.app', 'pass'],
    ['com.growthproject.app, com.growthproject.app.service', 'pass'],
    ['com.growthproject.app.service,com.growthproject.app', 'fail'],
    ['com.thegrowthproject.app', 'fail'],
    ['Com.growthproject.app', 'fail'],
    ['', 'missing'],
  ])('APPLE_AUDIENCES %j -> %s', (value, result) => {
    const r = shapeChecks(value === '' ? {} : { APPLE_AUDIENCES: value });
    expect(r.find((c) => c.name === 'APPLE_AUDIENCES')?.result).toBe(result);
  });

  it.each([
    [FP, 'pass'],
    [`${FP},${FP.toLowerCase()}`, 'pass'],
    [FP.replace(/:/g, ''), 'fail'],
    [FP.slice(0, -3), 'fail'],
    [`${FP},not-a-fingerprint`, 'fail'],
    [' , ', 'fail'],
    ['', 'missing'],
  ])('ANDROID_CERT_SHA256_FINGERPRINTS %j -> %s', (value, result) => {
    const r = shapeChecks(value === '' ? {} : { ANDROID_CERT_SHA256_FINGERPRINTS: value });
    expect(r.find((c) => c.name === 'ANDROID_CERT_SHA256_FINGERPRINTS')?.result).toBe(result);
  });

  it('the report and markdown carry the result but never the value', () => {
    const env = {
      APPLE_AUDIENCES: 'com.leakcanary.audience-value',
      ANDROID_CERT_SHA256_FINGERPRINTS: 'leakcanary-fingerprint',
    };
    const report = classifyEnv(env, ['APPLE_AUDIENCES', 'ANDROID_CERT_SHA256_FINGERPRINTS']);
    expect(report.shapeChecks.map((c) => c.result)).toEqual(['fail', 'fail']);
    expect(report.summary.shapeChecksFailing).toBe(2);
    const text = JSON.stringify(report) + renderMarkdown(report, 'app');
    expect(text).not.toMatch(/leakcanary/);
    expect(text).toContain('first entry is exactly com.growthproject.app');
  });
});

describe('inline remote program (what fly-env-truth.yml ships over ssh)', () => {
  const source = fs.readFileSync(CLASSIFIER, 'utf8');

  it('runs in a child node with a fake env and prints only the value-free report line', () => {
    const program = buildRemoteProgram(source);
    const r = spawnSync(process.execPath, ['-e', program], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...FAKE_ENV, [NAMES_ENV]: encodeNames(REGISTERED) },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // The names carrier is not itself reported as a machine env var.
    expect(r.stdout).not.toContain(NAMES_ENV);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(REPORT_MARKER)).toBe(true);
    expectNoValues(r.stdout);
    const report = parseRemoteOutput(`Connecting to fdaa::1...\n${r.stdout}`);
    expect(report.rows.find((x) => x.name === 'GOOGLE_OAUTH_CLIENT_ID')?.duplicateGroup).toMatch(
      /^D/,
    );
    expect(report.rows.find((x) => x.name === 'NEVER_SET_ANYWHERE')?.present).toBe(false);
  });

  it('the ssh -C command carries the names in an env var and a constant program; runs verbatim under sh', () => {
    const cmd = buildRemoteCommand(source, REGISTERED);
    expect(cmd).toMatch(
      /^env ENV_TRUTH_NAMES_B64=[A-Za-z0-9+/=]+ node -e "eval\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\('utf8'\)\)"$/,
    );
    // Executing the exact command string through a shell, as the machine would.
    const r = spawnSync('/bin/sh', ['-c', cmd], {
      encoding: 'utf8',
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...FAKE_ENV },
    });
    expect(r.status).toBe(0);
    expectNoValues(r.stdout + r.stderr);
    const report = parseRemoteOutput(r.stdout);
    expect(report.rows.find((x) => x.name === 'NEVER_SET_ANYWHERE')?.registered).toBe(true);
  });

  it('namesFromEnv rejects a missing, non-base64 or non-name payload', () => {
    expect(() => namesFromEnv({})).toThrow(/missing or not base64/);
    expect(() => namesFromEnv({ [NAMES_ENV]: 'not base64!' })).toThrow(/missing or not base64/);
    expect(() => namesFromEnv({ [NAMES_ENV]: encodeNames(['ok_lower']) })).toThrow(/not a list/);
    expect(namesFromEnv({ [NAMES_ENV]: encodeNames(['A_B']) })).toEqual(['A_B']);
  });

  it('CLI: names / command / parse / render work on the runner without a TS toolchain', () => {
    const validation = path.join(ROOT, 'src/common/env-validation.ts');
    const names = spawnSync(process.execPath, [CLASSIFIER, 'names', validation], {
      encoding: 'utf8',
    });
    expect(names.status).toBe(0);
    expect(JSON.parse(names.stdout)).toEqual(
      extractRegisteredNames(fs.readFileSync(validation, 'utf8')),
    );
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'envtruth-'));
    const out = path.join(tmp, 'ssh.txt');
    const program = buildRemoteProgram(source);
    const run = spawnSync(process.execPath, ['-e', program], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        A_REGISTERED: UNIQUE,
        [NAMES_ENV]: encodeNames(['A_REGISTERED']),
      },
    });
    fs.writeFileSync(out, run.stdout);
    const parsed = path.join(tmp, 'r.json');
    expect(spawnSync(process.execPath, [CLASSIFIER, 'parse', out, parsed]).status).toBe(0);
    const md = spawnSync(process.execPath, [CLASSIFIER, 'render', parsed, 'app'], {
      encoding: 'utf8',
    });
    expect(md.status).toBe(0);
    expect(md.stdout).toContain('# Env truth: app');
    expectNoValues(fs.readFileSync(parsed, 'utf8') + md.stdout);
  });

  it('parseRemoteOutput fails loudly when the marker is missing', () => {
    expect(() => parseRemoteOutput('Error: ssh: handshake failed')).toThrow(/marker not found/);
  });
});

/**
 * Opus B-624-1 (fix round): a present, unregistered name that is not a valid
 * env var name can be a fragment of a secret value (an unquoted
 * `fly secrets set A=part1 part2=part3`). It must never reach the JSON report,
 * the job summary or the artifact; it is replaced by an opaque MALFORMED_<n> id.
 */
describe('malformed present names are redacted (Opus B-624-1)', () => {
  const MALFORMED = ['q9Zr+/kL2pX', 'leakcanary_lower_fragment', 'Zk 9/abc.def'];
  const env: Record<string, string> = {
    APP_URL: 'https://app.invalid',
    E: 'leakcanary-short-name-value',
    [MALFORMED[0]]: 'tail',
    [MALFORMED[1]]: 'leakcanary-fragment-value',
    [MALFORMED[2]]: 'x',
  };
  const expectNoMalformed = (text: string): void => {
    for (const n of MALFORMED) expect(text).not.toContain(n);
    // No piece of the probe name either (the alnum run after the first char).
    expect(text).not.toContain('Zr+/kL2pX');
    expect(text).not.toContain('kL2pX');
  };

  it('neither JSON.stringify(report) nor renderMarkdown(report) contains a malformed name', () => {
    const report = classifyEnv(env, ['APP_URL']);
    expectNoMalformed(JSON.stringify(report));
    const md = renderMarkdown(report, 'backend-spring-lake-3890');
    expectNoMalformed(md);
    // Well-formed names (registered or not, suspicious or not) stay visible.
    expect(report.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['APP_URL', 'E', 'MALFORMED_1', 'MALFORMED_2', 'MALFORMED_3']),
    );
    expect(md).toContain('`E`');
  });

  it('redacted rows carry an opaque id and the name length bucket, sorted last', () => {
    const report = classifyEnv(env, ['APP_URL']);
    const tail = report.rows.slice(-3);
    expect(tail.map((r) => r.name)).toEqual(['MALFORMED_1', 'MALFORMED_2', 'MALFORMED_3']);
    for (const r of tail) {
      expect(r).toMatchObject({ registered: false, present: true, nameRedacted: true });
      expect(r.nameLengthBucket).toMatch(/^(1-7|8-15|16-31|32-63|64-127|128\+)$/);
    }
    expect(report.rows.filter((r) => r.nameRedacted).length).toBe(3);
    expect(report.summary.malformedNamesRedacted).toBe(3);
    // A registered name is never redacted (registry names are validated well-formed).
    expect(report.rows.find((r) => r.name === 'APP_URL')?.nameRedacted).toBeUndefined();
  });

  it('the job summary says how to find and remove the redacted names', () => {
    const md = renderMarkdown(classifyEnv(env, ['APP_URL']), 'backend-spring-lake-3890');
    expect(md).toContain('| Malformed names (redacted) | 3 |');
    expect(md).toContain('## Malformed names (redacted)');
    expect(md).toContain('fly secrets list -a backend-spring-lake-3890');
    expect(md).toContain('fly secrets unset -a backend-spring-lake-3890 <name>');
    expect(md).toContain('| MALFORMED_1 |');
  });

  it('the exact inline program redacts them inside the machine (end to end through parse + render)', () => {
    const source = fs.readFileSync(CLASSIFIER, 'utf8');
    const r = spawnSync(process.execPath, ['-e', buildRemoteProgram(source)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env, [NAMES_ENV]: encodeNames(['APP_URL']) },
    });
    expect(r.status).toBe(0);
    expectNoMalformed(r.stdout + r.stderr);
    const report = parseRemoteOutput(r.stdout);
    expect(report.summary.malformedNamesRedacted).toBe(3);
    expectNoMalformed(renderMarkdown(report, 'backend-spring-lake-3890'));
  });
});

describe('CLI failure messages say what is wrong and how to fix it', () => {
  it('unknown command lists the valid commands', () => {
    const r = spawnSync(process.execPath, [CLASSIFIER, 'bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command\. Fix: use one of names .*command .*parse .*render/);
  });

  it('a missing report marker fails with the fix, not a bare stack', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'envtruth-cli-'));
    const out = path.join(tmp, 'ssh.txt');
    fs.writeFileSync(out, 'Error: ssh: handshake failed\n');
    const r = spawnSync(process.execPath, [CLASSIFIER, 'parse', out, path.join(tmp, 'r.json')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /^::error::fly-env-classifier parse: env-truth report marker not found/,
    );
    expect(r.stderr).toContain('Fix:');
  });

  it('extractRegisteredNames explains a renamed ENV_RULES declaration', () => {
    expect(() => extractRegisteredNames('export const RULES = [];')).toThrow(
      /ENV_RULES not found .*Fix:/,
    );
  });
});
