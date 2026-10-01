/**
 * S-ENVTRUTH — code invariant: every env name runtime src/ reads is registered
 * in src/common/env-validation.ts (ENV_RULES), plus fixture coverage of every
 * read shape the scanner understands. Wired into the H4 deploy-readiness
 * board as the PR-gating ENV_REGISTRATION section (test/deploy-readiness.spec.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {
  DYNAMIC_ENV_SITES,
  TEMPLATE_PREFIXES,
  checkRegistration,
  checkRepoRegistration,
  registrationRedCount,
  scanEnvReadsInSource,
  type EnvReadScan,
} from './env-registration';
import { extractEnvRuleNames } from './env-discovery';
import { extractRegisteredNames } from '../../scripts/env-truth/fly-env-classifier';
import { ENV_RULES } from '../../src/common/env-validation';

const REPO_ROOT = path.join(__dirname, '..', '..');
const VALIDATION = path.join(REPO_ROOT, 'src/common/env-validation.ts');

const names = (src: string, rel = 'src/x.ts'): string[] =>
  [...scanEnvReadsInSource(src, rel).names].sort();

describe('env-registration scanner — read shapes', () => {
  it('direct process.env property / element / const / destructuring', () => {
    expect(
      names(`
        const K = 'CONST_KEYED';
        const a = process.env.PROP_READ;
        const b = process.env['ELEM_READ'];
        const c = process.env[K];
        const { DESTRUCT_A, DESTRUCT_B: x } = process.env;
      `),
    ).toEqual(['CONST_KEYED', 'DESTRUCT_A', 'DESTRUCT_B', 'ELEM_READ', 'PROP_READ']);
  });

  it('ConfigService get / getOrThrow with generic and default', () => {
    expect(
      names(`
        class S {
          constructor(private config: ConfigService, private readonly configService: ConfigService) {}
          a() { return this.config.get<string>('CFG_GET', 'x'); }
          b() { return this.configService.getOrThrow('CFG_THROW'); }
          c(m: Map<string, string>) { return m.get('NOT_ENV_MAP_KEY'); }
        }
      `),
    ).toEqual(['CFG_GET', 'CFG_THROW']);
  });

  it('ProcessEnv aliases (typed parameter, default parameter, local alias)', () => {
    expect(
      names(`
        export function f(env: NodeJS.ProcessEnv = process.env) { return env.ALIAS_PARAM; }
        export function g(e = process.env) { return e['ALIAS_DEFAULT']; }
        const local = process.env;
        const v = local.ALIAS_LOCAL;
      `),
    ).toEqual(['ALIAS_DEFAULT', 'ALIAS_LOCAL', 'ALIAS_PARAM']);
  });

  it('env-reading helpers: direct, method, arrow-property, transitive, config-backed, const-object args', () => {
    expect(
      names(`
        function readIntEnv(name: string, d: number) { const r = process.env[name]; return r ? Number(r) : d; }
        const LIMIT = readIntEnv('HELPER_FN', 5);
        const ENV = { clientId: 'OBJ_MEMBER_ID' } as const;
        class C {
          private getEnv: (k: string) => string | undefined;
          constructor(deps?: { getEnv?: (k: string) => string | undefined }) {
            this.getEnv = deps?.getEnv ?? ((k) => process.env[k]);
          }
          private requireEnv(key: string): string { const v = this.getEnv(key); if (!v) throw new Error(key); return v; }
          a() { return this.requireEnv(ENV.clientId); }
          b() { return this.requireEnv('TRANSITIVE'); }
          private flag(envKey: string) { return this.config.get<string>(envKey) === 'on'; }
          c() { return this.flag('CONFIG_HELPER'); }
        }
      `),
    ).toEqual(['CONFIG_HELPER', 'HELPER_FN', 'OBJ_MEMBER_ID', 'TRANSITIVE']);
  });

  it('template-built names expand over the wearables providers', () => {
    const got = names(`
      function read(p: string) { return process.env[\`\${p}_CLIENT_ID\`]; }
    `);
    expect(got).toEqual(TEMPLATE_PREFIXES.map((p) => `${p}_CLIENT_ID`).sort());
    expect(TEMPLATE_PREFIXES).toEqual([
      'FITBIT',
      'GARMIN',
      'OURA',
      'POLAR',
      'STRAVA',
      'WAHOO',
      'WHOOP',
      'WITHINGS',
    ]);
  });

  it('for-of over a const string array and a same-file property table', () => {
    expect(
      names(`
        const FLAGS = ['LOOP_A', 'LOOP_B'] as const;
        for (const key of FLAGS) { out[key] = process.env[key]; }
        const ROUTES = [{ pattern: '/x', envVar: 'TABLE_FLAG' }];
        export const dark = (r: { envVar: string }) => process.env[r.envVar] !== 'true';
      `),
    ).toEqual(['LOOP_A', 'LOOP_B', 'TABLE_FLAG']);
  });

  it('reports unresolvable reads as dynamic sites instead of silently dropping them', () => {
    const r = scanEnvReadsInSource(
      `export function f(o: { k: string }) { return process.env[o.k + '_X']; }`,
      'src/dyn.ts',
    );
    expect(r.dynamic).toEqual([{ file: 'src/dyn.ts', line: 1, expr: "o.k + '_X'" }]);
  });

  it('imported helpers resolve across files only when imported by name', () => {
    const helper = { name: 'envOn', paramIndex: 0 };
    expect([
      ...scanEnvReadsInSource(`import { envOn } from './h'; envOn('IMPORTED');`, 'src/a.ts', [
        helper,
      ]).names,
    ]).toEqual(['IMPORTED']);
    expect([...scanEnvReadsInSource(`envOn('NOT_IMPORTED');`, 'src/b.ts', [helper]).names]).toEqual(
      [],
    );
  });
});

describe('checkRegistration (pure)', () => {
  const scan: EnvReadScan = {
    reads: new Map([
      ['KNOWN', ['src/a.ts']],
      ['NEVER_REGISTERED', ['src/b.ts']],
    ]),
    dynamic: [{ file: 'src/c.ts', line: 3, expr: 'row.key' }],
  };

  it('flags an unregistered name, an unrecorded dynamic site, and stale / unregistered dynamic entries', () => {
    const r = checkRegistration(scan, ['KNOWN'], { 'src/gone.ts::x': ['DYN_UNREG'] });
    expect(r.unregistered).toEqual([{ name: 'NEVER_REGISTERED', files: ['src/b.ts'] }]);
    expect(r.unknownDynamic).toHaveLength(1);
    expect(r.staleDynamicSites).toEqual(['src/gone.ts::x']);
    expect(r.unregisteredDynamicNames).toEqual(['DYN_UNREG']);
    expect(registrationRedCount(r)).toBe(4);
  });

  it('is clean when everything is registered and every dynamic site is recorded', () => {
    const r = checkRegistration(scan, ['KNOWN', 'NEVER_REGISTERED', 'ROW'], {
      'src/c.ts::row.key': ['ROW'],
    });
    expect(registrationRedCount(r)).toBe(0);
  });
});

describe('repository invariant: every env name src/ reads is registered in ENV_RULES', () => {
  const report = checkRepoRegistration(REPO_ROOT);

  it('has zero unregistered env reads (add a rule to src/common/env-validation.ts)', () => {
    expect(report.unregistered.map((u) => `${u.name} <- ${u.files.join(', ')}`)).toEqual([]);
  });

  it('has zero unrecorded dynamic env reads (list them in DYNAMIC_ENV_SITES)', () => {
    expect(report.unknownDynamic).toEqual([]);
    expect(report.staleDynamicSites).toEqual([]);
    expect(report.unregisteredDynamicNames).toEqual([]);
  });

  it('scans a realistic surface (guards against a scanner that silently finds nothing)', () => {
    expect(report.readCount).toBeGreaterThan(250);
    for (const n of [
      'GARMIN_CLIENT_ID',
      'WAHOO_CLIENT_SECRET',
      'RATELIMIT_AUTHED_PER_MIN',
      'APP_URL',
    ]) {
      expect(report.registered.has(n)).toBe(true);
    }
  });

  it('the pilot-coach dynamic site lists exactly the FEATURE_GATED_ROUTES flags', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'src/common/feature-flag/feature-flag-not-found.middleware.ts'),
      'utf8',
    );
    const table = [...src.matchAll(/envVar:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]).sort();
    expect(
      [
        ...DYNAMIC_ENV_SITES['src/common/feature-flag/pilot-coach-allowlist.ts::route.envVar'],
      ].sort(),
    ).toEqual(table);
  });
});

// Rules that predate the S-ENVTRUTH inventory and carry no `default` field.
// Ratchet: every rule added from now on must record its real code default.
const LEGACY_RULES_WITHOUT_DEFAULT = new Set<string>([
  'ALLOW_SELF_SERVICE_BECOME_COACH',
  'ANDROID_SHA256_FINGERPRINT',
  'ANTHROPIC_API_KEY',
  'APPLE_AUDIENCES',
  'APPLE_TEAM_ID',
  'APP_STORE_URL',
  'AUTH_LOGIN_PER_HOUR',
  'AUTH_LOGIN_PER_MIN',
  'AUTH_PWD_RESET_PER_HOUR',
  'BILLING_ENFORCEMENT',
  'BLOODWORK_WRITE_PER_MIN',
  'BUILD_WEEK_AUTO_START_ON_SIGNUP',
  'BUILD_WEEK_ENABLED',
  'CHECKOUT_RECOVERY_SECRET',
  'COACH_ALERT_BATCH_LIMIT',
  'COACH_ALERT_RED_TRANSITION_ENABLED',
  'COACH_BRIEF_CRON',
  'COACH_BRIEF_ENABLED',
  'COACH_BRIEF_NOTIFICATIONS_ENABLED',
  'COACH_BRIEF_RETENTION_DAYS',
  'COACH_CMD_CENTER_PER_MIN',
  'COACH_CODE_GATE_ENABLED',
  'COACH_EFFECTIVENESS_CRON',
  'COACH_EFFECTIVENESS_ENABLED',
  'COACH_MESSAGES_PER_MIN',
  'COACH_ONBOARDING_AUTO_START',
  'CORS_ORIGINS',
  'CRON_COACH_AI_INSIGHT',
  'DATABASE_URL',
  'DIAGNOSTIC_AI_ENABLED',
  'DIAGNOSTIC_RATE_LIMIT_PER_HOUR',
  'DIRECT_URL',
  'EXERCISEDB_API_HOST',
  'EXERCISEDB_API_KEY',
  'FINANCE_API_BASE_URL',
  'FINANCE_FEDERATION_TIMEOUT_MS',
  'FINANCE_SERVICE_TOKEN',
  'FINANCE_SERVICE_TOKEN_NEXT',
  'GDPR_SCRUB_BATCH_LIMIT',
  'GDPR_SCRUB_DRY_RUN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_IDS',
  'GUEST_CHECKOUT_PII_SALT',
  'LOG_FORMAT',
  'LOG_LEVEL',
  'METRICS_ENABLED',
  'NOTIF_PREFS_PER_MIN',
  'PERPLEXITY_API_KEY',
  'PLAY_STORE_URL',
  'POSTHOG_KEY',
  'PROFILE_ENABLED',
  'PTM_RECOMPUTE_BATCH_LIMIT',
  'PTM_RISK_BOARD_PAGE_SIZE',
  'PTM_SCORING_CRON',
  'PTM_SCORING_ENABLED',
  'PTM_WEIGHTED_ACTIVATION_OUTCOMES',
  'PUBLIC_INVITE_BASE_URL',
  'PUBLIC_WEB_SIGNUP_URL',
  'RATELIMIT_ANON_PER_MIN',
  'RATELIMIT_AUTHED_PER_MIN',
  'RATELIMIT_ENABLED',
  'RECENT_AUTH_SECRET',
  'RECENT_AUTH_TTL_MS',
  'REDIS_URL',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'SENTRY_DSN',
  'SENTRY_TRACES_SAMPLE_RATE',
  'STOREFRONT_BASE_URL',
  'STRIPE_BILLING_PORTAL_RETURN_URL',
  'STRIPE_CHECKOUT_CANCEL_URL',
  'STRIPE_CHECKOUT_SUCCESS_URL',
  'STRIPE_CUSTOMER_PORTAL_LOGIN_URL',
  'STRIPE_PRICE_ID_FINANCE',
  'STRIPE_PRICE_ID_FITNESS',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_NEXT',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'SUPABASE_VOICE_BUCKET',
  'USDA_API_KEY',
  'VOICE_NOTE_MAX_DURATION_SEC',
  'VOICE_NOTE_MAX_SIZE_MB',
  'WEARABLE_PROCESSED_EVENT_RETENTION_DAYS',
]);

describe('ENV_RULES hygiene', () => {
  it('no duplicate names', () => {
    const seen = new Set<string>();
    const dups = ENV_RULES.map((r) => r.name).filter((n) =>
      seen.has(n) ? true : (seen.add(n), false),
    );
    expect(dups).toEqual([]);
  });

  it('every rule added after the legacy set records its real code default and a reason', () => {
    const missing = ENV_RULES.filter(
      (r) =>
        !LEGACY_RULES_WITHOUT_DEFAULT.has(r.name) && !(r.default && r.default.trim().length > 0),
    ).map((r) => r.name);
    expect(missing).toEqual([]);
    expect(ENV_RULES.filter((r) => r.reason.trim().length < 10).map((r) => r.name)).toEqual([]);
  });

  it('inventory rules add no validators and no hard/prod tiers (no boot behaviour change)', () => {
    const added = ENV_RULES.filter((r) => !LEGACY_RULES_WITHOUT_DEFAULT.has(r.name));
    expect(added.filter((r) => r.tier === 'hard' || r.tier === 'prod').map((r) => r.name)).toEqual(
      [],
    );
    expect(added.filter((r) => typeof r.validate === 'function').map((r) => r.name)).toEqual([]);
  });

  it('providers not used in v1 are optional and say so', () => {
    const notV1 = ENV_RULES.filter((r) =>
      /^(SENDGRID_|POSTMARK_|OPENAI_|MUSCLEWIKI_|YMOVE_|HELLOSIGN_|ZOOM_|CONTRACT_PDF_|(FITBIT|GARMIN|OURA|POLAR|STRAVA|WAHOO|WHOOP|WITHINGS)_)/.test(
        r.name,
      ),
    );
    expect(notV1.length).toBeGreaterThanOrEqual(45);
    for (const r of notV1) {
      expect([r.name, r.tier]).toEqual([r.name, 'optional']);
      expect(r.reason).toMatch(/Not used in v1/);
    }
  });

  it('launch classification (operator 2026-10-01): sign-in audience required, reminders a switch, calendar optional', () => {
    const byName = new Map(ENV_RULES.map((r) => [r.name, r]));
    expect(byName.get('GOOGLE_CLIENT_IDS')?.launch).toBe('required');
    expect(byName.get('BOOKING_REMINDERS_ENABLED')?.launch).toBe('switch');
    for (const n of [
      'GOOGLE_CALENDAR_ENABLED',
      'FEATURE_GOOGLE_CALENDAR_SYNC',
      'GOOGLE_MEET_ENABLED',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REDIRECT_URI',
      'GOOGLE_CALENDAR_WEBHOOK_TOKEN',
    ]) {
      const r = byName.get(n);
      expect([n, r?.tier, r?.launch]).toEqual([n, 'optional', 'optional-integration']);
      expect(r?.reason).toMatch(/not a launch dependency/);
    }
    // Every optional-integration rule is optional tier: it can never block boot.
    expect(
      ENV_RULES.filter((r) => r.launch === 'optional-integration' && r.tier !== 'optional').map(
        (r) => r.name,
      ),
    ).toEqual([]);
  });

  it('calendar flags are prod_default OFF in prod-switches.yml (must be unset or false)', () => {
    const yml = fs.readFileSync(path.join(REPO_ROOT, 'prod-switches.yml'), 'utf8');
    for (const n of [
      'GOOGLE_CALENDAR_ENABLED',
      'FEATURE_GOOGLE_CALENDAR_SYNC',
      'GOOGLE_MEET_ENABLED',
    ]) {
      expect(yml).toMatch(
        new RegExp(`- name: ${n}\\n    tier: optional\\n    prod_default: OFF\\n`),
      );
    }
  });

  it('the runner-side name extractor (no TS toolchain) matches the AST extraction', () => {
    const viaAst = extractEnvRuleNames(VALIDATION).sort();
    const viaRegex = extractRegisteredNames(fs.readFileSync(VALIDATION, 'utf8'));
    expect(viaRegex).toEqual(viaAst);
    expect(viaAst).toEqual(ENV_RULES.map((r) => r.name).sort());
  });

  it('the AST extractor still parses the file (sanity)', () => {
    const sf = ts.createSourceFile(
      VALIDATION,
      fs.readFileSync(VALIDATION, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    expect(sf.statements.length).toBeGreaterThan(5);
  });
});
