/**
 * Unit tests for prod-readiness/registry-loader.ts.
 *
 * Covers the full validation matrix (valid entry, every invalid-field path,
 * duplicate detection, YAML/IO errors), the closed owner enum (F-A10), the
 * minimum-description rule (F-A11), the name-prefix owner heuristic and the
 * unowned-ratio ceiling (F-B17). The committed prod-switches.yml is also
 * loaded end-to-end so the real registry can never silently regress below the
 * ownership ceiling or stop parsing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import {
  MIN_DESCRIPTION_LENGTH,
  OWNERS,
  RegistryValidationError,
  defaultRegistryPath,
  inferOwner,
  loadRegistry,
  unownedRatio,
  type Owner,
  type SwitchEntry,
} from '../registry-loader';

const REPO_ROOT = process.cwd();

/** A minimal, valid switch object for YAML round-tripping. */
function validSwitch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'EXAMPLE_FLAG',
    tier: 'feature',
    prod_default: 'OFF',
    auto_flip_on_in_prod: false,
    owner: 'platform',
    description: 'A perfectly valid description that clears the minimum length.',
    ...overrides,
  };
}

/** Write a registry YAML to a throwaway temp file and return its path. */
function writeRegistry(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const file = path.join(dir, 'prod-switches.yml');
  fs.writeFileSync(file, yaml.dump(doc), 'utf8');
  return file;
}

describe('registry-loader / defaultRegistryPath', () => {
  it('joins repoRoot with prod-switches.yml', () => {
    expect(defaultRegistryPath('/srv/app')).toBe(path.join('/srv/app', 'prod-switches.yml'));
  });

  it('defaults to process.cwd()', () => {
    expect(defaultRegistryPath()).toBe(path.join(process.cwd(), 'prod-switches.yml'));
  });
});

describe('registry-loader / loadRegistry — happy path', () => {
  it('parses a single valid switch and indexes it by name', () => {
    const file = writeRegistry({ switches: [validSwitch()] });
    const r = loadRegistry(file);
    expect(r.switches).toHaveLength(1);
    expect(r.switches[0].name).toBe('EXAMPLE_FLAG');
    expect(r.byName.get('EXAMPLE_FLAG')).toBe(r.switches[0]);
    expect(r.registryPath).toBe(file);
  });

  it('parses every owner in the closed enum', () => {
    const switches = [...OWNERS].map((owner, i) =>
      validSwitch({ name: `FLAG_${i}`, owner }),
    );
    const file = writeRegistry({ switches });
    const r = loadRegistry(file);
    expect(r.switches).toHaveLength(OWNERS.size);
    for (const owner of OWNERS) {
      expect(r.switches.some((s) => s.owner === owner)).toBe(true);
    }
  });

  it('accepts all four tiers and all four prod_default enum values', () => {
    const switches = [
      validSwitch({ name: 'A', tier: 'hard', prod_default: 'MUST_SET' }),
      validSwitch({ name: 'B', tier: 'prod', prod_default: 'ON' }),
      validSwitch({ name: 'C', tier: 'feature', prod_default: 'OFF' }),
      validSwitch({ name: 'D', tier: 'optional', prod_default: 'STUB_ALLOWED' }),
    ];
    const file = writeRegistry({ switches });
    expect(loadRegistry(file).switches).toHaveLength(4);
  });
});

describe('registry-loader / loadRegistry — IO + parse errors', () => {
  it('throws when the registry file is missing', () => {
    expect(() => loadRegistry('/nonexistent/path/prod-switches.yml')).toThrow(RegistryValidationError);
  });

  it('throws on malformed YAML', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const file = path.join(dir, 'prod-switches.yml');
    fs.writeFileSync(file, 'switches: [::::\n  - bad', 'utf8');
    expect(() => loadRegistry(file)).toThrow(/YAML parse error/);
  });

  it('throws when the top-level shape is not { switches: [...] }', () => {
    const file = writeRegistry({ notSwitches: [] });
    expect(() => loadRegistry(file)).toThrow(/Top-level shape/);
  });

  it('throws when switches is not an array', () => {
    const file = writeRegistry({ switches: 'nope' });
    expect(() => loadRegistry(file)).toThrow(/Top-level shape/);
  });
});

describe('registry-loader / loadRegistry — per-field validation', () => {
  function expectFieldError(overrides: Record<string, unknown>, pattern: RegExp): void {
    const file = writeRegistry({ switches: [validSwitch(overrides)] });
    expect(() => loadRegistry(file)).toThrow(pattern);
  }

  it('rejects a non-object entry', () => {
    const file = writeRegistry({ switches: ['not-an-object'] });
    expect(() => loadRegistry(file)).toThrow(/must be an object/);
  });

  it('rejects a non-SCREAMING_SNAKE_CASE name', () => {
    expectFieldError({ name: 'lower_case' }, /SCREAMING_SNAKE_CASE/);
  });

  it('rejects an unknown tier', () => {
    expectFieldError({ tier: 'wishful' }, /tier must be one of/);
  });

  it('rejects an unknown prod_default', () => {
    expectFieldError({ prod_default: 'MAYBE' }, /prod_default must be one of/);
  });

  it('rejects a non-boolean auto_flip_on_in_prod', () => {
    expectFieldError({ auto_flip_on_in_prod: 'true' }, /auto_flip_on_in_prod must be boolean/);
  });

  it('rejects an owner outside the closed enum (F-A10)', () => {
    expectFieldError({ owner: 'marketing' }, /owner must be one of/);
  });

  it('rejects a blank description (F-A11)', () => {
    expectFieldError({ description: '       ' }, /at least 8 characters/);
  });

  it('rejects a too-short description below the minimum (F-A11)', () => {
    expectFieldError({ description: 'short' }, /at least 8 characters/);
  });

  it('accepts a description at exactly the minimum length', () => {
    const file = writeRegistry({ switches: [validSwitch({ description: 'x'.repeat(MIN_DESCRIPTION_LENGTH) })] });
    expect(loadRegistry(file).switches).toHaveLength(1);
  });

  it('aggregates multiple field errors for one entry', () => {
    const file = writeRegistry({ switches: [validSwitch({ tier: 'x', owner: 'y' })] });
    expect(() => loadRegistry(file)).toThrow(/tier must be one of.*owner must be one of/s);
  });
});

describe('registry-loader / loadRegistry — duplicate detection', () => {
  it('rejects two entries with the same name', () => {
    const file = writeRegistry({ switches: [validSwitch({ name: 'DUP' }), validSwitch({ name: 'DUP' })] });
    expect(() => loadRegistry(file)).toThrow(/duplicate name/);
  });

  it('allows distinct names that share a prefix', () => {
    const file = writeRegistry({
      switches: [validSwitch({ name: 'FOO_A' }), validSwitch({ name: 'FOO_B' })],
    });
    expect(loadRegistry(file).switches).toHaveLength(2);
  });
});

describe('registry-loader / inferOwner heuristic (F-B17)', () => {
  const cases: Array<[string, Owner]> = [
    ['FITBIT_CLIENT_ID', 'wearables'],
    ['WHOOP_WEBHOOK_SECRET', 'wearables'],
    ['BLOODWORK_STALE_AFTER_DAYS', 'wearables'],
    ['CONTRACT_PDF_BUCKET', 'contracts'],
    ['HELLOSIGN_API_KEY', 'contracts'],
    ['OPENAI_API_KEY', 'ai'],
    ['AI_GATEWAY_PROVIDER', 'ai'],
    ['COACH_AI_MAX_ACTUAL_CENTS', 'ai'],
    ['FEATURE_COMMUNITY_DM', 'community'],
    ['VOICE_NOTE_MAX_BYTES', 'community'],
    ['LEADERBOARD_ENABLED', 'community'],
    ['STRIPE_PRICE_PRO', 'billing'],
    ['CHECKOUT_RECEIPT_DISABLED', 'billing'],
    ['JWT_SECRET', 'auth'],
    ['GOOGLE_OAUTH_CLIENT_ID', 'auth'],
    ['ANDROID_PACKAGE_NAME', 'auth'],
    ['KMS_MASTER_KEY', 'auth'],
    ['ADMIN_SERVICE_TOKEN', 'auth'],
    ['LOG_LEVEL', 'observability'],
    ['METRICS_ENABLED', 'observability'],
    ['GIT_SHA', 'observability'],
    ['COACH_DAILY_CRON', 'coach'],
    ['NUDGE_DETECTION_CRON', 'coach'],
    ['BOOKING_REMINDER_1H_CRON', 'jobs'],
    ['WEEKLY_DIGEST_CRON', 'jobs'],
    ['PORT', 'platform'],
    ['NODE_ENV', 'platform'],
    ['REDIS_URL', 'platform'],
    ['PUBLIC_APP_BASE_URL', 'platform'],
    ['DATA_EXPORT_BUCKET', 'platform'],
  ];

  it.each(cases)('infers %s -> %s', (name, owner) => {
    expect(inferOwner(name)).toBe(owner);
  });

  it('falls back to unowned for an unrecognised name', () => {
    expect(inferOwner('TOTALLY_NOVEL_THING')).toBe('unowned');
    expect(inferOwner('USDA_API_KEY')).toBe('unowned');
  });

  it('only ever returns a value in the closed owner enum', () => {
    for (const [name] of cases) {
      expect(OWNERS.has(inferOwner(name))).toBe(true);
    }
    expect(OWNERS.has(inferOwner('UNKNOWN'))).toBe(true);
  });

  it('is COACH_AI_* routed to ai, not coach (order matters)', () => {
    // COACH_AI_ must be matched by the ai rule before the broader COACH_ rule.
    expect(inferOwner('COACH_AI_BUDGET_ROLLOVER_CRON')).toBe('ai');
    expect(inferOwner('COACH_BRIEF_ENABLED')).toBe('coach');
  });
});

describe('registry-loader / unownedRatio', () => {
  function sw(owner: Owner): SwitchEntry {
    return {
      name: 'X',
      tier: 'feature',
      prod_default: 'OFF',
      auto_flip_on_in_prod: false,
      owner,
      description: 'desc long enough',
    };
  }

  it('returns 0 for an empty list', () => {
    expect(unownedRatio([])).toBe(0);
  });

  it('returns 1 when all are unowned', () => {
    expect(unownedRatio([sw('unowned'), sw('unowned')])).toBe(1);
  });

  it('returns 0 when none are unowned', () => {
    expect(unownedRatio([sw('platform'), sw('auth')])).toBe(0);
  });

  it('computes a fractional ratio', () => {
    expect(unownedRatio([sw('unowned'), sw('platform'), sw('auth'), sw('unowned')])).toBeCloseTo(0.5);
  });
});

describe('registry-loader / committed prod-switches.yml (integration)', () => {
  it('loads without error', () => {
    const r = loadRegistry(defaultRegistryPath(REPO_ROOT));
    expect(r.switches.length).toBeGreaterThan(0);
  });

  it('every committed owner is a member of the closed enum (F-A10)', () => {
    const r = loadRegistry(defaultRegistryPath(REPO_ROOT));
    for (const s of r.switches) {
      expect(OWNERS.has(s.owner)).toBe(true);
    }
  });

  it('every committed description clears the minimum length (F-A11)', () => {
    const r = loadRegistry(defaultRegistryPath(REPO_ROOT));
    for (const s of r.switches) {
      expect(s.description.trim().length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
    }
  });

  it('unowned ratio is below the 60% ceiling (F-B17)', () => {
    const r = loadRegistry(defaultRegistryPath(REPO_ROOT));
    expect(unownedRatio(r.switches)).toBeLessThan(0.6);
  });

  it('has no duplicate switch names', () => {
    const r = loadRegistry(defaultRegistryPath(REPO_ROOT));
    expect(r.byName.size).toBe(r.switches.length);
  });
});
