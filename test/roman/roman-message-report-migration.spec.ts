/**
 * ROMAN-HOLD-BE: the shape of migration 20270502011200_roman_message_report, its down.sql, the Prisma
 * model and the account-erasure entry, read as text (no DB). The live row rules are proved in
 * test/rls/roman-message-report-rls.spec.ts (rls-live-tests).
 */
import * as fs from 'fs';
import * as path from 'path';
import { ERASURE_MANIFEST } from '../../src/account-deletion/account-deletion.manifest';

const ROOT = path.join(__dirname, '..', '..');
const NAME = '20270502011200_roman_message_report';
const DIR = path.join(ROOT, 'prisma', 'migrations', NAME);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const sqlOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

describe('migration 20270502011200_roman_message_report', () => {
  const up = sqlOnly(read(path.join(DIR, 'migration.sql')));
  const down = sqlOnly(read(path.join(DIR, 'down.sql')));

  it('sorts after the newest migration on main it was written against', () => {
    const names = fs.readdirSync(path.join(ROOT, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    expect(names).toContain('20270502011100_plan_swaps_revisions');
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf('20270502011100_plan_swaps_revisions'));
  });

  it('adds one table naming the reporter and the held Roman message, no copy of the chat', () => {
    const create = /CREATE TABLE "RomanMessageReport" \(([\s\S]*?)\n\);/.exec(up);
    expect(create).not.toBeNull();
    const cols = [...create![1].matchAll(/^\s*"(\w+)"\s/gm)].map((m) => m[1]);
    expect(cols).toEqual(['id', 'reporter_id', 'roman_message_id', 'reason', 'details', 'created_at']);
    expect(up).not.toMatch(/"content"/);
  });

  it('goes with the message and with the account (ON DELETE CASCADE on both)', () => {
    expect(up).toMatch(
      /FOREIGN KEY \("reporter_id"\) REFERENCES "User"\("id"\) ON DELETE CASCADE/,
    );
    expect(up).toMatch(
      /FOREIGN KEY \("roman_message_id"\) REFERENCES "RomanMessage"\("id"\) ON DELETE CASCADE/,
    );
    expect(up).toMatch(
      /CREATE UNIQUE INDEX "RomanMessageReport_reporter_id_roman_message_id_key" ON "RomanMessageReport"\("reporter_id", "roman_message_id"\)/,
    );
    expect(up).toMatch(/CREATE INDEX "RomanMessageReport_roman_message_id_idx" ON "RomanMessageReport"\("roman_message_id"\)/);
  });

  it('keeps the reason on the DM report list and the details at 1000 characters in the database too', () => {
    expect(up).toMatch(/CHECK \("reason" IN \('spam', 'harassment', 'sexual', 'self_harm', 'other'\)\)/);
    expect(up).toMatch(/CHECK \("details" IS NULL OR char_length\("details"\) <= 1000\)/);
  });

  it("only TGP's team reads it: RLS enabled and forced, no anon access, one SELECT policy on app.is_owner()", () => {
    expect(up).toMatch(/ALTER TABLE "RomanMessageReport" ENABLE ROW LEVEL SECURITY;/);
    expect(up).toMatch(/ALTER TABLE "RomanMessageReport" FORCE ROW LEVEL SECURITY;/);
    expect(up).toMatch(/REVOKE ALL ON TABLE "RomanMessageReport" FROM anon;/);
    const policies = [...up.matchAll(/CREATE POLICY "(\w+)" ON "RomanMessageReport"\s+FOR (\w+) TO (\w+)\s+USING \(([^;]*)\);/g)];
    expect(policies.map((p) => [p[1], p[2], p[3], p[4].trim()])).toEqual([
      ['p_romanmessagereport_select_tgp_team', 'SELECT', 'public', 'app.is_owner()'],
    ]);
    expect((up.match(/CREATE POLICY/g) ?? []).length).toBe(1);
  });

  it('is additive: touches no other table, and down.sql drops only the new table', () => {
    const altered = [...up.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(['RomanMessageReport']));
    expect(up).not.toMatch(/\bDROP\b/);
    expect(down.trim().split(/;\s*/).filter(Boolean)).toEqual([
      'BEGIN',
      'DROP TABLE IF EXISTS "RomanMessageReport"',
      'COMMIT',
    ]);
  });
});

describe('Prisma model and erasure', () => {
  const schema = read(path.join(ROOT, 'prisma', 'schema.prisma'));

  it('declares RomanMessageReport with both relations cascading', () => {
    const model = /model RomanMessageReport \{([\s\S]*?)\n\}/.exec(schema);
    expect(model).not.toBeNull();
    expect(model![1]).toMatch(/reporter\s+User\s+@relation\("RomanMessageReportReporter", fields: \[reporter_id\], references: \[id\], onDelete: Cascade\)/);
    expect(model![1]).toMatch(/message\s+RomanMessage\s+@relation\(fields: \[roman_message_id\], references: \[id\], onDelete: Cascade\)/);
    expect(model![1]).toMatch(/@@unique\(\[reporter_id, roman_message_id\]\)/);
  });

  it('erases the reporter\u2019s reports with the account, before their Roman messages', () => {
    const idx = ERASURE_MANIFEST.findIndex((e) => e.model === 'RomanMessageReport');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(ERASURE_MANIFEST[idx]).toMatchObject({ model: 'RomanMessageReport', field: 'reporter_id', action: { op: 'delete' } });
    expect(idx).toBeLessThan(ERASURE_MANIFEST.findIndex((e) => e.model === 'RomanMessage'));
  });
});
