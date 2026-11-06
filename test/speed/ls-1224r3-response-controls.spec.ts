import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

interface Read {
  screen: string;
  path: string;
  check: (body: string) => string | null;
}
const now = new Date('2026-11-06T12:00:00Z');
const client = '5bee0000-0000-4000-8000-000000000001';
const coach = '5bee0000-0000-4000-8000-000000000000';

function catalogue(): Read[] {
  const file = join(__dirname, 'coach-busy-reads.speed.spec.ts');
  const captured: { reads?: (at: Date) => Read[] } = {};
  const noSuite = () => undefined;
  const compiled = ts.transpileModule(
    readFileSync(file, 'utf8') + '\nmodule.exports.reads = reads;',
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, {
    require, URL, URLSearchParams, module: { exports: captured }, exports: captured,
    process: { env: {} }, console: { log: noSuite },
    describe: Object.assign(noSuite, { skip: noSuite }),
  }, { filename: file });
  if (!captured.reads) throw new Error('Actual catalogue missing');
  return captured.reads(now);
}

const reads = catalogue();
const read = (path: string): Read => {
  const entry = reads.find((r) => r.path === path);
  if (!entry) throw new Error(`Missing ${path}`);
  return entry;
};

describe('LS-1224R3 independent response controls', () => {
  it('retains all 45 rows with the reviewed screen provenance', () => {
    expect(reads).toHaveLength(45);
    expect(Object.fromEntries(['Needs you', 'Client list', 'Inbox', 'Client file', 'Money', 'Calendar']
      .map((screen) => [screen, reads.filter((r) => r.screen === screen).length])))
      .toEqual({ 'Needs you': 17, 'Client list': 5, Inbox: 5, 'Client file': 8, Money: 7, Calendar: 3 });
  });

  it.each(reads.map((r) => [r.screen, r.path, r] as const))(
    '%s %s rejects non-JSON, errors, null, and missing payloads',
    (_screen, _path, entry) => {
      for (const body of ['<html>error</html>', 'undefined', 'null', '{}', '{"error":"unavailable"}', '[]']) {
        // Bare [] is the explicit empty fixture for blocks and pending drafts.
        if (body === '[]' && ['/users/blocks', '/ai/gateway/drafts?status=pending'].includes(entry.path)) {
          expect(entry.check(body)).toBeNull();
        } else {
          expect(entry.check(body)).not.toBeNull();
        }
      }
    },
  );

  it.each([
    ['/users/blocks', []],
    ['/ai/gateway/drafts?status=pending', []],
    ['/coach/clients?status=archived&take=50', []],
    ['/coach/command-center/at-risk', { items: [], total_at_risk: 0 }],
    ['/v1/coach/churned-clients?take=50', { items: [], total: 0 }],
    ['/coach/broadcasts?limit=1', { items: [] }],
    ['/community/moderation/flagged', { items: [] }],
    ['/v1/coach/money/attention', { items: [], count: 0 }],
  ] as const)('%s accepts its explicitly empty shape', (path, body) => {
    expect(read(path).check(JSON.stringify(body))).toBeNull();
    expect(read(path).check(JSON.stringify({ error: 'unavailable', items: [], count: 0, total: 0, total_at_risk: 0 }))).not.toBeNull();
  });

  it.each([
    [`/coach/clients/${client}/macros/current`, { client_id: client, calories_kcal: 2200, protein_g: 160, carbs_g: 230, fats_g: 70 }],
    [`/coach/clients/${client}/week`, { assignments: [{ id: 'seeded-workout', scheduled_for: now.toISOString(), completed_at: null }] }],
    ['/v1/coach/packages?include_archived=true', { packages: [{ name: 'Monthly coaching', coach_id: coach, amount_cents: 20000, subscriber_count: 45 }] }],
    ['/coach/team/members', [{ id: coach, role: 'head_coach', assigned_clients: 45 }]],
    ['/v1/coach/money/charges?status=paid&limit=1', { charges: [{ id: '5bee0001-0000-4000-8000-000000000001', client: { id: client }, package: { name: 'Monthly coaching' }, amount_cents: 20000, state: 'paid' }] }],
    ['/coach/connect/status', { charges_enabled: true, stripe_account_id: 'acct_speedtest0000' }],
    ['/coach/ai/budget', { period_start: '2026-11-01T00:00:00Z', used_displayed_cents: 0 }],
  ] as const)('%s accepts its seeded-value control', (path, body) => {
    expect(read(path).check(JSON.stringify(body))).toBeNull();
  });

  it.each([
    [`/coach/clients/${client}/macros/current`, { client_id: client, calories_kcal: 0, protein_g: 0, carbs_g: 0, fats_g: 0 }],
    [`/coach/clients/${client}/week`, { assignments: [{ id: 'shape-only' }] }],
    ['/v1/coach/packages?include_archived=true', { packages: [{ name: 'Monthly coaching', coach_id: coach, amount_cents: 0, subscriber_count: 45 }] }],
    ['/coach/team/members', [{ id: coach, role: 'sub_coach', assigned_clients: 45 }]],
    ['/v1/coach/money/charges?status=paid&limit=1', { charges: [{}] }],
    ['/coach/connect/status', { charges_enabled: false, stripe_account_id: 'acct_speedtest0000' }],
    ['/coach/ai/budget', { period_start: '2026-11-01T00:00:00Z', used_displayed_cents: 10 }],
  ] as const)('%s rejects a wrong seeded-value control', (path, body) => {
    expect(read(path).check(JSON.stringify(body))).not.toBeNull();
  });
});
