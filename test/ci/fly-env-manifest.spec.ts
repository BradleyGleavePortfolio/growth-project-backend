/**
 * B-FLAGS-2 (T4): unit tests for the launch-flag desired-state manifest
 * (.github/fly-env-desired-state.json) and its loader / validator / planner
 * (scripts/fly-env/fly-env-manifest.js). The end-to-end workflow behaviour
 * (fake flyctl, real run: scripts) is in fly-env-sync-behavior.spec.ts.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join } from 'path';

import { DEFAULT_APPLE_SIGNIN_CLIENT_ID } from '../../src/account-deletion/apple-token-revocation.service';
import { ENV_RULES } from '../../src/common/env-validation';
import { IOS_BUNDLE_ID, shapeChecks } from '../../scripts/env-truth/fly-env-classifier';
import * as fem from '../../scripts/fly-env/fly-env-manifest';
import type { Fleet, FlyEnvManifest, MachineCheck } from '../../scripts/fly-env/fly-env-manifest';

const ROOT = join(__dirname, '..', '..');
const MANIFEST_FILE = join(ROOT, '.github/fly-env-desired-state.json');
const RULES_FILE = join(ROOT, 'src/common/env-validation.ts');
const manifestText = readFileSync(MANIFEST_FILE, 'utf8');
const rules = fem.extractEnvRules(readFileSync(RULES_FILE, 'utf8'));
const base = (): FlyEnvManifest => fem.parseManifestText(manifestText);
/**
 * Production today (every flag unset, no GitHub-sourced secret): the fixture
 * the matrices below start from, so a one-line flip PR never has to edit them.
 */
const baseline = (): FlyEnvManifest => {
  const m = base();
  return {
    ...m,
    flags: Object.fromEntries(Object.keys(m.flags).map((n) => [n, 'unset'])),
    secrets: Object.fromEntries(
      Object.entries(m.secrets).map(([n, v]) => [n, v === 'github-secret' ? 'unset' : v]),
    ),
  };
};
const VALUE = 'leakcanary-value-7d6c5b4a39213f2e';
const SB_SECRET = 'sb_secret_leakcanary-Ab12_Cd34';
const SB_PUBLISHABLE = 'sb_publishable_leakcanary-Ef56_Gh78';
const NOT_SB_SECRET = 'not-an-sb-secret-key';
const NOT_SB_PUBLISHABLE = 'not-an-sb-publishable-key';

/** Wave A / Wave B inventory this lane must manage (B-FLAGS-2 brief). */
const WAVE_FLAGS = [
  'FEATURE_AI_CONSENT_LEDGER_ENABLED',
  'FEATURE_COMMUNITY_SCHEMA',
  'FEATURE_COMMUNITY_API',
  'FEATURE_COMMUNITY_POSTS',
  'FEATURE_COMMUNITY_MESSAGES',
  'FEATURE_COMMUNITY_PUSH',
  'FEATURE_COMMUNITY_REALTIME',
  'FEATURE_COMMUNITY_VOICE_NOTES',
  'BOOKING_REMINDERS_ENABLED',
  'SIGNUP_ROLE_CHOICE_ENABLED',
  'FEATURE_WEARABLES_INGEST_POST',
  'FEATURE_MWB_TEMPLATES',
  'FEATURE_MWB_AUTOSAVE_UNDO',
  'FEATURE_NAMED_REGIMES',
  'FEATURE_DUNNING_V2',
  // Clinic engagement kill switches (backend #609, B-609-2).
  'COACH_WELCOME_SCHEDULER_ENABLED',
  'WORKOUT_REMINDERS_ENABLED',
];

function edit(
  m: FlyEnvManifest,
  changes: Partial<Record<'flags' | 'secrets', Record<string, string>>>,
): FlyEnvManifest {
  return {
    ...m,
    flags: { ...m.flags, ...(changes.flags ?? {}) },
    secrets: { ...m.secrets, ...(changes.secrets ?? {}) },
  };
}

describe('ENV_RULES extraction (runner side, no TypeScript)', () => {
  it('reads exactly the names and closed value sets of the imported ENV_RULES', () => {
    expect([...rules.keys()].sort()).toEqual([...new Set(ENV_RULES.map((r) => r.name))].sort());
    for (const r of ENV_RULES)
      expect([
        r.name,
        rules.get(r.name)?.values ?? null,
        rules.get(r.name)?.unsetIs ?? null,
      ]).toEqual([r.name, r.values ? [...r.values] : null, r.unsetIs ?? null]);
  });

  it('fails closed on a values line it cannot read', () => {
    const src =
      "export const ENV_RULES: EnvRule[] = [\n  {\n    name: 'X_FLAG',\n    values: TRUE_FALSE,\n  },\n];\n";
    expect(() => fem.extractEnvRules(src)).toThrow(/could not be read \(rule X_FLAG\)\. Fix:/);
    expect(() => fem.extractEnvRules('const nothing = 1;')).toThrow(/ENV_RULES not found.*Fix:/);
  });

  it('closed sets are exactly what the code distinguishes', () => {
    expect(rules.get('BOOKING_REMINDERS_ENABLED')?.values).toEqual(['on', 'off']);
    for (const n of WAVE_FLAGS.filter((x) => x !== 'BOOKING_REMINDERS_ENABLED'))
      expect([n, rules.get(n)?.values]).toEqual([n, ['true', 'false']]);
    // Only managed flags carry a closed set.
    const withValues = ENV_RULES.filter((r) => r.values)
      .map((r) => r.name)
      .sort();
    expect(withValues).toEqual(Object.keys(base().flags).sort());
  });
});

describe('emergency kill per flag (B-637-2): defaults-on switches are killed by a set, never an unset', () => {
  const kills = fem.killSwitches(base(), rules);
  const DEFAULTS_ON = [
    'COACH_WELCOME_SCHEDULER_ENABLED',
    'FEATURE_COMMUNITY_SCHEMA',
    'SIGNUP_ROLE_CHOICE_ENABLED',
    'WORKOUT_REMINDERS_ENABLED',
  ];

  it('every managed flag declares unsetIs, and exactly the defaults-on switches are "on"', () => {
    for (const n of Object.keys(base().flags))
      expect([n, ['on', 'off'].includes(rules.get(n)?.unsetIs ?? '')]).toEqual([n, true]);
    expect(
      kills
        .filter((k) => k.unsetIs === 'on')
        .map((k) => k.name)
        .sort(),
    ).toEqual(DEFAULTS_ON);
  });

  it('unsetIs agrees with the registry default text of every managed flag', () => {
    const onText = /^(?:'?on'?\b|unset\s*(?:→|=|->)\s*on\b)/i;
    for (const r of ENV_RULES.filter((x) => x.values))
      expect([r.name, onText.test(r.default ?? '')]).toEqual([r.name, r.unsetIs === 'on']);
  });

  it('the real code readers: absent = on and the kill value = off for every defaults-on switch', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isCommunitySchemaEnabled } =
      require('../../src/community/community-schema.feature') as {
        isCommunitySchemaEnabled: () => boolean;
      };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { signupRoleChoiceEnabled } = require('../../src/auth/auth.service') as {
      signupRoleChoiceEnabled: () => boolean;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isCoachWelcomeSchedulerEnabled, isWorkoutRemindersEnabled } =
      require('../../src/engagement/engagement.flags') as {
        isCoachWelcomeSchedulerEnabled: () => boolean;
        isWorkoutRemindersEnabled: () => boolean;
      };
    const readers: Record<string, () => boolean> = {
      COACH_WELCOME_SCHEDULER_ENABLED: isCoachWelcomeSchedulerEnabled,
      FEATURE_COMMUNITY_SCHEMA: isCommunitySchemaEnabled,
      SIGNUP_ROLE_CHOICE_ENABLED: signupRoleChoiceEnabled,
      WORKOUT_REMINDERS_ENABLED: isWorkoutRemindersEnabled,
    };
    for (const name of DEFAULTS_ON) {
      const saved = process.env[name];
      try {
        delete process.env[name];
        expect([name, 'unset', readers[name]()]).toEqual([name, 'unset', true]);
        const k = kills.find((x) => x.name === name)!;
        process.env[name] = k.value;
        expect([name, k.value, readers[name]()]).toEqual([name, 'false', false]);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  });

  it('defaults-on kills are a set of the off value; defaults-off kills are an unset', () => {
    for (const k of kills) {
      if (k.unsetIs === 'on') {
        expect(k).toMatchObject({ action: 'set', value: 'false' });
        expect(k.command).toBe(`fly secrets set -a ${fem.APP} ${k.name}=false`);
        expect(k.manifest).toBe(`"${k.name}": "false"`);
      } else {
        expect(k).toMatchObject({ action: 'unset', value: 'unset' });
        expect(k.command).toBe(`fly secrets unset -a ${fem.APP} ${k.name}`);
      }
    }
  });

  it('validation rejects a managed flag without unsetIs, and a defaults-on flag with no off value', () => {
    const src = (line: string) =>
      `export const ENV_RULES: EnvRule[] = [\n  {\n    name: 'FEATURE_DUNNING_V2',\n    values: ['true', 'false'],\n${line}  },\n];\n`;
    const only = (): FlyEnvManifest => ({
      ...baseline(),
      flags: { FEATURE_DUNNING_V2: 'unset' },
      secrets: {},
      gates: { FEATURE_DUNNING_V2: 'the gate' },
      excluded: {},
    });
    const noUnsetIs = fem.validateManifest(only(), fem.extractEnvRules(src('')));
    expect(noUnsetIs.join('\n')).toMatch(
      /flags\.FEATURE_DUNNING_V2 has no unsetIs in ENV_RULES.*Fix:/,
    );
    const onNoOff = fem.validateManifest(
      only(),
      fem.extractEnvRules(
        src('')
          .replace("['true', 'false']", "['true']")
          .replace('  },', "    unsetIs: 'on',\n  },"),
      ),
    );
    expect(onNoOff.join('\n')).toMatch(
      /defaults on \(unsetIs 'on'\) but its closed set has no off value.*Fix:/,
    );
    expect(() => fem.extractEnvRules(src("    unsetIs: 'maybe',\n"))).toThrow(
      /unsetIs line could not be read \(rule FEATURE_DUNNING_V2\)\. Fix:/,
    );
  });

  it('the kill-switches CLI, the plan and the runbook give the same per-flag kill', () => {
    const r = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/fly-env/fly-env-manifest.js'),
        'kill-switches',
        MANIFEST_FILE,
        RULES_FILE,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    const table = r.stdout.trim().split('\n');
    expect(table).toHaveLength(Object.keys(base().flags).length + 1);
    const runbook = readFileSync(join(ROOT, 'docs/runbooks/launch-flags.md'), 'utf8');
    for (const line of table) expect([line, runbook.includes(line)]).toEqual([line, true]);
    for (const name of DEFAULTS_ON) {
      expect(runbook).not.toContain(`fly secrets unset -a ${fem.APP} ${name}`);
      expect(runbook).toContain(
        `fly secrets set -a ${fem.APP} ${name}=false (never unset: that turns it on)`,
      );
    }
    // No universal "unset is the kill switch" instruction is left.
    expect(runbook).not.toMatch(/emergency[^\n]*`fly secrets unset[^`]*<NAME>`/i);
    const plan = fem.renderPlan(
      fem.planChanges(baseline(), new Map(), { results: {} }, {}),
      'd'.repeat(64),
      { results: {} },
      kills,
    );
    expect(plan.join('\n')).toContain(
      'defaults-on switches are killed by SETTING their off value, never by unsetting: FEATURE_COMMUNITY_SCHEMA=false SIGNUP_ROLE_CHOICE_ENABLED=false COACH_WELCOME_SCHEDULER_ENABLED=false WORKOUT_REMINDERS_ENABLED=false.',
    );
  });
});

describe('the checked-in manifest', () => {
  it('parses, validates against ENV_RULES and passes every precondition', () => {
    expect(fem.validateManifest(base(), rules)).toEqual([]);
    const loaded = fem.loadManifest(MANIFEST_FILE, RULES_FILE);
    expect(loaded.errors).toEqual([]);
    expect(loaded.digest).toBe(createHash('sha256').update(manifestText).digest('hex'));
  });

  it('manages every Wave A / Wave B flag, GOOGLE_CLIENT_IDS and the MWB lock secret', () => {
    const m = base();
    for (const n of WAVE_FLAGS) expect([n, n in m.flags]).toEqual([n, true]);
    expect(m.secrets.GOOGLE_CLIENT_IDS).toBeDefined();
    expect(m.secrets.MWB_AUTOSAVE_LOCK_TOKEN_SECRET).toBeDefined();
  });

  it('copies both Supabase API keys from GitHub (key switch, owner 2026-10-10)', () => {
    const m = base();
    for (const n of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'])
      expect([n, m.secrets[n], n in m.excluded]).toEqual([n, 'github-secret', false]);
  });

  it('every FEATURE_COMMUNITY_* name in ENV_RULES is managed or excluded with a reason', () => {
    const m = base();
    for (const r of ENV_RULES.filter((x) => x.name.startsWith('FEATURE_COMMUNITY_')))
      expect([r.name, r.name in m.flags || r.name in m.excluded]).toEqual([r.name, true]);
  });

  it('one path: no other workflow mentions a managed flag name', () => {
    const managed = Object.keys(base().flags);
    const dir = join(ROOT, '.github/workflows');
    for (const f of readdirSync(dir).filter(
      (x) => /\.ya?ml$/.test(x) && x !== 'fly-env-sync.yml',
    )) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const n of managed)
        expect([f, n, new RegExp(`\\b${n}\\b`).test(text)]).toEqual([f, n, false]);
    }
  });

  it('the workflow passes exactly the manifest secrets to the plan and stage steps, each from the same-named GitHub secret', () => {
    interface Step {
      name?: string;
      env?: Record<string, string>;
    }
    const wf = parseYaml(
      readFileSync(join(ROOT, '.github/workflows/fly-env-sync.yml'), 'utf8'),
    ) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const s = Object.values(wf.jobs)[0].steps;
    const names = Object.keys(base().secrets).sort();
    for (const re of [/^Plan /, /^Stage the planned changes/]) {
      const env = s.find((x) => re.test(x.name ?? ''))?.env ?? {};
      const keys = Object.keys(env).filter((k) => k !== 'FLY_API_TOKEN' && k !== 'APP');
      expect(keys.sort()).toEqual(names);
      for (const k of keys) expect(env[k]).toBe(`\${{ secrets.${k} }}`);
    }
    for (const n of ['APPLE_SIGNIN_PRIVATE_KEY', 'APPLE_SIGNIN_KEY_ID', 'DATABASE_URL'])
      expect(names).not.toContain(n);
  });
});

describe('manifest parsing is strict', () => {
  it.each<[string, (t: string) => string, RegExp]>([
    [
      'a duplicated key',
      (t) =>
        t.replace(
          /^( {4}"FEATURE_DUNNING_V2": "[^"]*",?)$/m,
          '    "FEATURE_DUNNING_V2": "true",\n$1',
        ),
      /appears twice in "flags".*Fix: keep exactly one line/,
    ],
    [
      'two entries on one line',
      (t) =>
        t.replace(
          /^( {4}"FEATURE_COMMUNITY_API": "[^"]*",)\n {4}("FEATURE_COMMUNITY_POSTS")/m,
          '$1 $2',
        ),
      /is not one "NAME": "value" entry on its own line inside "flags"\. Fix:/,
    ],
    ['invalid JSON', (t) => t.replace('"app":', 'app:'), /not valid JSON.*Fix:/],
    [
      'a missing top-level section',
      (t) =>
        t.replace(/ {2}"excluded": \{[\s\S]*?\n {2}\}\n/, '').replace(/\n {2}\},\n\}/, '\n  }\n}'),
      /exactly these top-level keys.*Fix:/,
    ],
    [
      'a non-string value',
      (t) => t.replace(/"FEATURE_DUNNING_V2": "[^"]*"/, '"FEATURE_DUNNING_V2": true'),
      /is not one "NAME": "value" entry/,
    ],
  ])('rejects %s with a Fix', (_label, mutate, re) => {
    expect(mutate(manifestText)).not.toBe(manifestText);
    expect(() => fem.parseManifestText(mutate(manifestText))).toThrow(re);
  });
});

describe('validation errors are specific and carry a Fix', () => {
  const errs = (m: FlyEnvManifest) => fem.validateManifest(m, rules);
  it.each<[string, (m: FlyEnvManifest) => FlyEnvManifest, RegExp]>([
    [
      'an unregistered flag',
      (m) => ({
        ...m,
        flags: { ...m.flags, FEATURE_NOT_REAL: 'true' },
        gates: { ...m.gates, FEATURE_NOT_REAL: 'x' },
      }),
      /flags\.FEATURE_NOT_REAL is not registered .* Fix:/,
    ],
    [
      'a value outside the closed set',
      (m) => edit(m, { flags: { FEATURE_DUNNING_V2: 'yes' } }),
      /flags\.FEATURE_DUNNING_V2 is "yes".*Fix: use one of "true", "false" or "unset"\./,
    ],
    [
      'a flag without a closed set',
      (m) => ({
        ...m,
        flags: { ...m.flags, LEADERBOARD_ENABLED: 'true' },
        gates: { ...m.gates, LEADERBOARD_ENABLED: 'x' },
      }),
      /flags\.LEADERBOARD_ENABLED has no closed value set .* Fix:/,
    ],
    [
      'an unknown secret state',
      (m) => edit(m, { secrets: { METRICS_AUTH_TOKEN: 'yes' } }),
      /secrets\.METRICS_AUTH_TOKEN is "yes"\. Fix:/,
    ],
    [
      'a flag listed as a secret',
      (m) => ({ ...m, secrets: { ...m.secrets, FEATURE_DUNNING_V2: 'unset' } }),
      /FEATURE_DUNNING_V2 appears in both flags and secrets\. Fix:/,
    ],
    [
      'a managed name also excluded',
      (m) => ({ ...m, excluded: { ...m.excluded, FEATURE_DUNNING_V2: 'x' } }),
      /FEATURE_DUNNING_V2 is both managed \(flags\) and excluded\. Fix:/,
    ],
    [
      'a missing gate',
      (m) => {
        const g = { ...m.gates };
        delete g.FEATURE_DUNNING_V2;
        return { ...m, gates: g };
      },
      /gates\.FEATURE_DUNNING_V2 is missing\. Fix:/,
    ],
    [
      'a gate without an entry',
      (m) => ({ ...m, gates: { ...m.gates, FEATURE_NOT_REAL: 'x' } }),
      /gates\.FEATURE_NOT_REAL has no flags or secrets entry\. Fix:/,
    ],
    [
      'a closed-set flag neither managed nor excluded',
      (m) => {
        const f = { ...m.flags };
        delete f.FEATURE_NAMED_REGIMES;
        const g = { ...m.gates };
        delete g.FEATURE_NAMED_REGIMES;
        return { ...m, flags: f, gates: g };
      },
      /FEATURE_NAMED_REGIMES has a closed value set in ENV_RULES but the manifest neither manages nor excludes it\. Fix:/,
    ],
    [
      'the wrong app',
      (m) => ({ ...m, app: 'other' }),
      /app must be "backend-spring-lake-3890".*Fix:/,
    ],
  ])('%s', (_label, mutate, re) => {
    const e = errs(mutate(baseline()));
    expect(e.some((x) => re.test(x))).toBe(true);
    for (const x of e) expect(x).toMatch(/Fix: /);
  });

  it.each<[string, Record<string, string>, Record<string, string>, string | null]>([
    [
      'autosave without the lock secret',
      { FEATURE_MWB_AUTOSAVE_UNDO: 'true' },
      {},
      'mwb-autosave-needs-lock-secret',
    ],
    [
      'autosave with the lock secret from GitHub',
      { FEATURE_MWB_AUTOSAVE_UNDO: 'true' },
      { MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'github-secret' },
      null,
    ],
    [
      'autosave with the lock secret already present',
      { FEATURE_MWB_AUTOSAVE_UNDO: 'true' },
      { MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'present' },
      null,
    ],
    [
      'voice notes without the API',
      { FEATURE_COMMUNITY_VOICE_NOTES: 'true' },
      {},
      'community-subflag-needs-api',
    ],
    [
      'the community core set',
      {
        FEATURE_COMMUNITY_SCHEMA: 'true',
        FEATURE_COMMUNITY_API: 'true',
        FEATURE_COMMUNITY_POSTS: 'true',
        FEATURE_COMMUNITY_MESSAGES: 'true',
        FEATURE_COMMUNITY_PUSH: 'true',
        FEATURE_COMMUNITY_REALTIME: 'true',
        FEATURE_COMMUNITY_VOICE_NOTES: 'true',
      },
      {},
      null,
    ],
    [
      'the API with the schema forced off',
      { FEATURE_COMMUNITY_API: 'true', FEATURE_COMMUNITY_SCHEMA: 'false' },
      {},
      'community-api-needs-schema',
    ],
    [
      'voice entitlement without voice notes',
      { FEATURE_COMMUNITY_API: 'true', FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT: 'true' },
      {},
      'voice-entitlement-needs-voice',
    ],
    [
      'every Wave A / B launch value',
      {
        FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true',
        BOOKING_REMINDERS_ENABLED: 'on',
        SIGNUP_ROLE_CHOICE_ENABLED: 'true',
        COACH_WELCOME_SCHEDULER_ENABLED: 'true',
        WORKOUT_REMINDERS_ENABLED: 'true',
        FEATURE_DUNNING_V2: 'true',
        FEATURE_WEARABLES_INGEST_POST: 'true',
        FEATURE_MWB_TEMPLATES: 'true',
        FEATURE_NAMED_REGIMES: 'true',
      },
      { GOOGLE_CLIENT_IDS: 'github-secret' },
      null,
    ],
  ])('precondition: %s', (_label, flags, secrets, id) => {
    const e = errs(edit(baseline(), { flags, secrets }));
    if (id === null) expect(e).toEqual([]);
    else {
      expect(e).toHaveLength(1);
      expect(e[0]).toMatch(new RegExp(`^precondition ${id}: .*Fix: `));
    }
  });
});

describe('source checks (GitHub secrets) return words, never values', () => {
  const m = edit(baseline(), {
    secrets: {
      GOOGLE_CLIENT_IDS: 'github-secret',
      MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'github-secret',
      METRICS_AUTH_TOKEN: 'github-secret',
    },
  });
  it.each<[Record<string, string>, Record<string, string>]>([
    [
      {
        GOOGLE_CLIENT_IDS: 'a.apps.googleusercontent.com,b.apps.googleusercontent.com',
        MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'ab'.repeat(32),
        METRICS_AUTH_TOKEN: VALUE,
      },
      { GOOGLE_CLIENT_IDS: 'ok', MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'ok', METRICS_AUTH_TOKEN: 'ok' },
    ],
    [
      {
        GOOGLE_CLIENT_IDS: 'a,,b',
        MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'short',
        METRICS_AUTH_TOKEN: '   ',
      },
      {
        GOOGLE_CLIENT_IDS: 'empty-client-id-entry',
        MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'not-64-plus-hex-characters',
        METRICS_AUTH_TOKEN: 'empty',
      },
    ],
    [
      {},
      {
        GOOGLE_CLIENT_IDS: 'empty',
        MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'empty',
        METRICS_AUTH_TOKEN: 'empty',
      },
    ],
  ])('%j', (env, want) => {
    const got = fem.sourceChecks(m, env);
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).not.toContain('leakcanary');
  });

  it.each<[string, string, string, string, string]>([
    ['the new keys', SB_SECRET, SB_PUBLISHABLE, 'ok', 'ok'],
    ['swapped keys', SB_PUBLISHABLE, SB_SECRET, NOT_SB_SECRET, NOT_SB_PUBLISHABLE],
    ['legacy JWTs', 'eyJhbGciOiJIUzI1NiJ9.leakcanary', 'eyJ', NOT_SB_SECRET, NOT_SB_PUBLISHABLE],
    ['stray whitespace', `${SB_SECRET}\n`, ` ${SB_PUBLISHABLE}`, NOT_SB_SECRET, NOT_SB_PUBLISHABLE],
  ])('Supabase keys: %s', (_label, service, anon, wantService, wantAnon) => {
    const s = edit(baseline(), {
      secrets: { SUPABASE_SERVICE_ROLE_KEY: 'github-secret', SUPABASE_ANON_KEY: 'github-secret' },
    });
    const env = { SUPABASE_SERVICE_ROLE_KEY: service, SUPABASE_ANON_KEY: anon };
    const got = fem.sourceChecks(s, env);
    expect(got).toEqual({ SUPABASE_SERVICE_ROLE_KEY: wantService, SUPABASE_ANON_KEY: wantAnon });
    expect(JSON.stringify(got)).not.toContain('leakcanary');
  });
});

describe('in-machine check', () => {
  const m = edit(baseline(), {
    flags: { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true', BOOKING_REMINDERS_ENABLED: 'on' },
    secrets: { GOOGLE_CLIENT_IDS: 'github-secret' },
  });
  const env = { GOOGLE_CLIENT_IDS: VALUE };
  const input = fem.buildCompareInput(m, env, fem.sourceChecks(m, env));
  const cmd = fem.buildCompareCommand(input);
  const runIn = (machineEnv: Record<string, string>, command = cmd) =>
    spawnSync('sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '', ...machineEnv },
      encoding: 'utf8',
    });

  it('the command is base64 only: no value and no plain hash input', () => {
    expect(cmd).toMatch(
      /^env FLY_ENV_COMPARE_B64=[A-Za-z0-9+/=]+ node -e "eval\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\('utf8'\)\)"$/,
    );
    const decoded = Buffer.from(/FLY_ENV_COMPARE_B64=(\S+)/.exec(cmd)![1], 'base64').toString(
      'utf8',
    );
    expect(decoded).not.toContain(VALUE);
    expect(decoded).not.toContain('"true"');
    expect(Object.keys(input.expect).sort()).toEqual([
      'BOOKING_REMINDERS_ENABLED',
      'FEATURE_AI_CONSENT_LEDGER_ENABLED',
      'GOOGLE_CLIENT_IDS',
    ]);
    expect(input.presence).toContain('FEATURE_DUNNING_V2');
    expect(input.presence).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
    expect(input.salt).toMatch(/^[0-9a-f]{64}$/);
    // A fresh salt per run: two inputs never share hashes.
    expect(
      fem.buildCompareInput(m, env, fem.sourceChecks(m, env)).expect.GOOGLE_CLIENT_IDS,
    ).not.toBe(input.expect.GOOGLE_CLIENT_IDS);
  });

  it('the real program answers match / differs / absent / present and prints nothing else', () => {
    const r = runIn({
      FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true',
      BOOKING_REMINDERS_ENABLED: 'true',
      FEATURE_DUNNING_V2: VALUE,
      GOOGLE_OAUTH_CLIENT_SECRET: VALUE,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    expect(r.stdout).not.toContain(VALUE);
    const results = fem.parseCompareOutput(r.stdout, fem.compareNames(input));
    expect(results.FEATURE_AI_CONSENT_LEDGER_ENABLED).toBe('match');
    expect(results.BOOKING_REMINDERS_ENABLED).toBe('differs');
    expect(results.GOOGLE_CLIENT_IDS).toBe('absent');
    expect(results.FEATURE_DUNNING_V2).toBe('present');
    expect(results.GOOGLE_OAUTH_CLIENT_SECRET).toBe('present');
    expect(results.FEATURE_COMMUNITY_API).toBe('absent');
    expect(runIn({ GOOGLE_CLIENT_IDS: VALUE }).stdout).toContain('"GOOGLE_CLIENT_IDS":"match"');
  });

  it('bad input is reported as bad_input (never a guess)', () => {
    const r = runIn({}, cmd.replace(/FLY_ENV_COMPARE_B64=\S+/, 'FLY_ENV_COMPARE_B64=bm90LWpzb24='));
    expect(r.stdout).toContain('"error":"bad_input"');
    expect(() => fem.parseCompareOutput(r.stdout, fem.compareNames(input))).toThrow(/bad input/);
  });

  it.each<[string, string]>([
    ['no marker line', 'Connecting...\n'],
    ['a non-JSON marker line', 'FLY_ENV_COMPARE_JSON:{nope\n'],
    ['another schema', 'FLY_ENV_COMPARE_JSON:{"schema":"v0","results":{}}\n'],
    ['a missing name', 'FLY_ENV_COMPARE_JSON:{"schema":"fly-env-compare/v1","results":{}}\n'],
    [
      'an unknown word',
      `FLY_ENV_COMPARE_JSON:{"schema":"fly-env-compare/v1","results":{"FEATURE_DUNNING_V2":"${VALUE}"}}\n`,
    ],
  ])('parseCompareOutput rejects %s', (_label, text) => {
    expect(() => fem.parseCompareOutput(text, ['FEATURE_DUNNING_V2'])).toThrow();
  });
});

describe('planChanges / verifyState matrix', () => {
  const ok = (names: Record<string, string>): MachineCheck => ({ results: names });
  const fly = (entries: Record<string, string>) => new Map(Object.entries(entries));
  const m = edit(baseline(), { flags: { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true' } });
  const row = (p: ReturnType<typeof fem.planChanges>, n: string) =>
    p.rows.find((r) => r.name === n)!;
  const OAUTH = {
    GOOGLE_OAUTH_CLIENT_ID: 'Deployed',
    GOOGLE_OAUTH_CLIENT_SECRET: 'Deployed',
    GOOGLE_OAUTH_REDIRECT_URI: 'Deployed',
  };
  const OAUTH_M = {
    GOOGLE_OAUTH_CLIENT_ID: 'present',
    GOOGLE_OAUTH_CLIENT_SECRET: 'present',
    GOOGLE_OAUTH_REDIRECT_URI: 'present',
  };

  it.each<[string, Record<string, string>, MachineCheck, string]>([
    ['absent', {}, ok({}), 'set'],
    [
      'Deployed + match',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' },
      ok({ FEATURE_AI_CONSENT_LEDGER_ENABLED: 'match' }),
      'keep',
    ],
    [
      'Deployed + differs',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' },
      ok({ FEATURE_AI_CONSENT_LEDGER_ENABLED: 'differs' }),
      'set',
    ],
    [
      'Deployed + machine absent',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' },
      ok({ FEATURE_AI_CONSENT_LEDGER_ENABLED: 'absent' }),
      'set',
    ],
    [
      'Deployed + check unavailable',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' },
      { unavailable: true, errorClass: 'auth' },
      'set',
    ],
    [
      'Staged',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Staged' },
      ok({ FEATURE_AI_CONSENT_LEDGER_ENABLED: 'absent' }),
      'set',
    ],
    [
      'Unknown',
      { FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Unknown' },
      ok({ FEATURE_AI_CONSENT_LEDGER_ENABLED: 'match' }),
      'set',
    ],
  ])('declared value, Fly %s -> %s', (_label, state, machine, action) => {
    const p = fem.planChanges(m, fly({ ...OAUTH, ...state }), machine, {});
    expect(p.errors).toEqual([]);
    expect(row(p, 'FEATURE_AI_CONSENT_LEDGER_ENABLED').action).toBe(action);
    expect(p.setFlags.length).toBe(action === 'set' ? 1 : 0);
  });

  it.each<[string, Record<string, string>, Record<string, string>, string, boolean]>([
    ['absent everywhere', {}, {}, 'keep', false],
    [
      'listed Deployed',
      { FEATURE_DUNNING_V2: 'Deployed' },
      { FEATURE_DUNNING_V2: 'present' },
      'unset',
      false,
    ],
    [
      'listed Staged',
      { FEATURE_DUNNING_V2: 'Staged' },
      { FEATURE_DUNNING_V2: 'absent' },
      'unset',
      false,
    ],
    ['unset staged, machine still has it', {}, { FEATURE_DUNNING_V2: 'present' }, 'keep', true],
  ])('declared unset, %s -> %s', (_label, state, machine, action, pending) => {
    const p = fem.planChanges(
      baseline(),
      fly({ ...OAUTH, ...state }),
      ok({ ...OAUTH_M, ...machine }),
      {},
    );
    expect(row(p, 'FEATURE_DUNNING_V2').action).toBe(action);
    expect(p.pending.includes('FEATURE_DUNNING_V2')).toBe(pending);
    expect(p.unset).toEqual(action === 'unset' ? ['FEATURE_DUNNING_V2'] : []);
  });

  it('declared present: absent on Fly is an error; listed but not live is pending', () => {
    const p1 = fem.planChanges(
      baseline(),
      fly({ GOOGLE_OAUTH_CLIENT_ID: 'Deployed', GOOGLE_OAUTH_CLIENT_SECRET: 'Deployed' }),
      ok(OAUTH_M),
      {},
    );
    expect(p1.errors).toEqual([
      expect.stringMatching(/^GOOGLE_OAUTH_REDIRECT_URI is declared "present".*Fix:/),
    ]);
    const p2 = fem.planChanges(
      baseline(),
      fly({ ...OAUTH, GOOGLE_OAUTH_CLIENT_ID: 'Staged' }),
      ok(OAUTH_M),
      {},
    );
    expect(p2.errors).toEqual([]);
    expect(p2.pending).toEqual(['GOOGLE_OAUTH_CLIENT_ID']);
    expect(p2.setSecrets).toEqual([]);
  });

  it('github-secret sources: empty / shape errors carry a Fix and never a value', () => {
    const s = edit(baseline(), {
      secrets: { GOOGLE_CLIENT_IDS: 'github-secret', METRICS_AUTH_TOKEN: 'github-secret' },
    });
    const p = fem.planChanges(s, fly(OAUTH), ok(OAUTH_M), {
      GOOGLE_CLIENT_IDS: 'empty-client-id-entry',
      METRICS_AUTH_TOKEN: 'empty',
    });
    expect(p.errors).toHaveLength(2);
    for (const e of p.errors) expect(e).toMatch(/Fix: /);
    expect(p.setSecrets).toEqual([]);
  });

  it('other staged names are listed for deploy_staged; malformed names are counted, not shown', () => {
    const p = fem.planChanges(
      baseline(),
      fly({
        ...OAUTH,
        RECENT_AUTH_SECRET: 'Staged',
        'abc def': 'Staged',
        DATABASE_URL: 'Deployed',
      }),
      ok(OAUTH_M),
      {},
    );
    expect(p.otherStaged).toEqual(['RECENT_AUTH_SECRET']);
    expect(p.otherStagedMalformed).toBe(1);
    expect(fem.renderPlan(p, 'd'.repeat(64), ok(OAUTH_M)).join('\n')).not.toContain('abc def');
  });

  it('the plan prints declared states and words, never a value or digest', () => {
    const s = edit(m, { secrets: { GOOGLE_CLIENT_IDS: 'github-secret' } });
    const p = fem.planChanges(s, fly(OAUTH), ok(OAUTH_M), { GOOGLE_CLIENT_IDS: 'ok' });
    const text = fem.renderPlan(p, 'd'.repeat(64), ok(OAUTH_M)).join('\n');
    expect(text).toContain(
      'GOOGLE_CLIENT_IDS | secret | github-secret | absent | not checked | set | not on Fly',
    );
    expect(text).toContain(
      'FEATURE_AI_CONSENT_LEDGER_ENABLED | flag | true | absent | not checked | set | not on Fly',
    );
  });

  it('verifyState is exact: missing, extra, not-deployed and machine mismatches', () => {
    const v1 = fem.verifyState(m, fly({ ...OAUTH, FEATURE_DUNNING_V2: 'Staged' }), 'staged', null);
    expect(v1.errors.join('\n')).toMatch(
      /declared with a value but Fly does not list them: FEATURE_AI_CONSENT_LEDGER_ENABLED\. Fix:/,
    );
    expect(v1.errors.join('\n')).toMatch(
      /declared "unset" but Fly still lists them: FEATURE_DUNNING_V2\. Fix:/,
    );
    const v2 = fem.verifyState(
      m,
      fly({ ...OAUTH, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Staged' }),
      'staged',
      null,
    );
    expect(v2.errors).toEqual([]);
    expect(v2.pending).toEqual(['FEATURE_AI_CONSENT_LEDGER_ENABLED']);
    // Deployed phase (B-637-1): proven only by every started machine.
    const allAbsent = Object.fromEntries(
      [...Object.keys(m.flags), ...Object.keys(m.secrets)].map((n) => [n, 'absent']),
    );
    const good = ok({ ...allAbsent, ...OAUTH_M, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'match' });
    const DEPLOYED = fly({ ...OAUTH, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' });
    const fleet = (checks: Record<string, MachineCheck>, machines = Object.keys(checks)) => ({
      list: { machines: machines.map((id) => ({ id, state: 'started' })), malformed: 0 },
      checks,
    });
    const v3 = fem.verifyState(
      m,
      DEPLOYED,
      'deployed',
      fleet({
        e2865013b42d78: ok({
          ...allAbsent,
          ...OAUTH_M,
          FEATURE_AI_CONSENT_LEDGER_ENABLED: 'differs',
          FEATURE_DUNNING_V2: 'present',
        }),
      }),
      { final: true },
    );
    expect(v3.errors.join('\n')).toMatch(
      /machine e2865013b42d78 does not match the manifest for: FEATURE_AI_CONSENT_LEDGER_ENABLED \(differs\) FEATURE_DUNNING_V2 \(present\)\. Fix:/,
    );
    const v4 = fem.verifyState(m, DEPLOYED, 'deployed', fleet({ e2865013b42d78: good }), {
      final: true,
    });
    expect(v4).toMatchObject({ errors: [], warnings: [], retry: [] });
    expect(v4.proven).toEqual({ started: ['e2865013b42d78'], idle: [] });
  });

  it('deployed phase fails closed: every unproven case is a retry, and an error with a Fix on the last attempt', () => {
    const allAbsent = Object.fromEntries(
      [...Object.keys(m.flags), ...Object.keys(m.secrets)].map((n) => [n, 'absent']),
    );
    const good = ok({ ...allAbsent, ...OAUTH_M, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'match' });
    const DEPLOYED = fly({ ...OAUTH, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Deployed' });
    const cases: Array<[string, Map<string, string>, Fleet | null, RegExp]> = [
      ['no fleet data at all', DEPLOYED, null, /fleet could not be enumerated/],
      [
        'machines list unavailable',
        DEPLOYED,
        { list: { unavailable: true, errorClass: 'network' }, checks: {} },
        /error class network\), so the fleet could not be enumerated/,
      ],
      [
        'a started machine without a check',
        DEPLOYED,
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'started' }], malformed: 0 },
          checks: {},
        },
        /machine e2865013b42d78: the in-machine check did not run \(error class not_run\)/,
      ],
      [
        'a started machine whose check was unavailable',
        DEPLOYED,
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'started' }], malformed: 0 },
          checks: { e2865013b42d78: { unavailable: true, errorClass: 'auth' } },
        },
        /the in-machine check did not run \(error class auth\)/,
      ],
      [
        'a result missing for a managed name',
        DEPLOYED,
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'started' }], malformed: 0 },
          checks: {
            e2865013b42d78: ok({ ...OAUTH_M, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'match' }),
          },
        },
        /FEATURE_DUNNING_V2 \(not checked\)/,
      ],
      [
        'still Staged on Fly',
        fly({ ...OAUTH, FEATURE_AI_CONSENT_LEDGER_ENABLED: 'Staged' }),
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'started' }], malformed: 0 },
          checks: { e2865013b42d78: good },
        },
        /not report these names as Deployed yet: FEATURE_AI_CONSENT_LEDGER_ENABLED/,
      ],
      [
        'no started machine',
        DEPLOYED,
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'stopped' }], malformed: 0 },
          checks: {},
        },
        /no machine is started/,
      ],
      [
        'an unrecognised state word is never echoed',
        DEPLOYED,
        {
          list: {
            machines: [
              { id: 'e2865013b42d78', state: 'started' },
              { id: '148e272a5d7d89', state: 'Kq7-leak value' },
            ],
            malformed: 0,
          },
          checks: { e2865013b42d78: good },
        },
        /machine 148e272a5d7d89 is unrecognized, not started/,
      ],
      [
        'a malformed machine id',
        DEPLOYED,
        {
          list: { machines: [{ id: 'e2865013b42d78', state: 'started' }], malformed: 2 },
          checks: { e2865013b42d78: good },
        },
        /returned 2 entries without a valid machine id/,
      ],
    ];
    for (const [label, state, fl, re] of cases) {
      const retry = fem.verifyState(m, state, 'deployed', fl, { final: false });
      expect([label, retry.errors, retry.retry.join('; ')]).toEqual([
        label,
        [],
        expect.stringMatching(re),
      ]);
      const last = fem.verifyState(m, state, 'deployed', fl, { final: true });
      expect([label, last.retry]).toEqual([label, []]);
      expect([label, last.errors.join('\n')]).toEqual([
        label,
        expect.stringMatching(/^The running state is not proven after the last check: .*\. Fix: /),
      ]);
      expect(last.errors.join('\n')).toMatch(re);
      expect(last.errors.join('\n')).not.toContain('Kq7');
    }
  });

  it('parseMachineList keeps valid ids and counts the rest without showing them', () => {
    expect(
      fem.parseMachineList(
        'e2865013b42d78\tstarted\n../etc\tstarted\n\tstopped\n148e272a5d7d89\tSTOPPED\n',
      ),
    ).toEqual({
      machines: [
        { id: 'e2865013b42d78', state: 'started' },
        { id: '148e272a5d7d89', state: 'stopped' },
      ],
      malformed: 2,
    });
  });

  it('an absent listing with no in-machine check is unproven, never "absent, as declared" (B-637-1)', () => {
    const p = fem.planChanges(
      baseline(),
      fly(OAUTH),
      { unavailable: true, errorClass: 'auth' },
      {},
    );
    expect(row(p, 'FEATURE_DUNNING_V2')).toMatchObject({ action: 'keep', machine: 'unavailable' });
    expect(row(p, 'FEATURE_DUNNING_V2').reason).toMatch(/unproven/);
    expect(p.unproven).toContain('FEATURE_DUNNING_V2');
    expect(p.unproven).toContain('GOOGLE_OAUTH_CLIENT_ID');
    const text = fem
      .renderPlan(p, 'd'.repeat(64), { unavailable: true, errorClass: 'auth' })
      .join('\n');
    expect(text).toContain('the running machines are unproven for:');
    expect(text).not.toContain('Fly already matches the manifest');
  });
});

describe('Sign in with Apple on production (B-APPLE-123)', () => {
  it('declares the iOS bundle id as the Apple audience, the value the env-truth shape check and token revocation expect', () => {
    const declared = base().flags.APPLE_AUDIENCES;
    expect(declared).toBe('com.growthproject.app');
    expect(declared).toBe(IOS_BUNDLE_ID);
    expect(declared).toBe(DEFAULT_APPLE_SIGNIN_CLIENT_ID);
    expect(
      shapeChecks({ APPLE_AUDIENCES: declared }).find((c) => c.name === 'APPLE_AUDIENCES')?.result,
    ).toBe('pass');
    expect(rules.get('APPLE_AUDIENCES')?.values).toEqual(['com.growthproject.app']);
  });

  it('keeps APPLE_NONCE_REQUIRED unset: the app sends no raw_nonce, so "true" would fail every Apple sign-in', () => {
    expect(base().flags.APPLE_NONCE_REQUIRED).toBe('unset');
    expect(rules.get('APPLE_NONCE_REQUIRED')?.unsetIs).toBe('off');
  });
});
