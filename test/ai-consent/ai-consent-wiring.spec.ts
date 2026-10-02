/**
 * R2a — static wiring checks that run in build-and-test (no database).
 *
 * The behavioural RLS / append-only proof is the live suite
 * test/rls/ai-processing-consent-ledger-rls.spec.ts (rls-live-tests job). This
 * file pins the things that would silently weaken that proof or the
 * default-safe posture if edited later:
 *   - the migration ships a down.sql and has no owner / coach read branch and
 *     no non-service write policy;
 *   - the rls-live-tests CI job actually runs the live suite (Sol B-R2-1);
 *   - the flag is registered default OFF in prod-switches.yml and .env.example;
 *   - AppModule mounts AiConsentModule;
 *   - R2b: AI call sites never import the ledger directly; only the egress
 *     gate in src/ai-egress (and app.module) does.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../../src/app.module';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIG = 'prisma/migrations/20270203000000_ai_processing_consent_ledger';

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

describe('R2a wiring', () => {
  const migration = stripSqlComments(read(`${MIG}/migration.sql`));

  it('migration ships a down.sql that drops the table and the trigger function', () => {
    const down = stripSqlComments(read(`${MIG}/down.sql`));
    expect(down).toMatch(/DROP TABLE IF EXISTS "AiProcessingConsentEvent"/);
    expect(down).toMatch(/DROP FUNCTION IF EXISTS public\.ai_processing_consent_event_reject_update\(\)/);
  });

  it('enables and forces RLS, binds the append-only trigger and revokes anon', () => {
    expect(migration).toMatch(/ALTER TABLE "AiProcessingConsentEvent" ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE "AiProcessingConsentEvent" FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/BEFORE UPDATE ON "AiProcessingConsentEvent"/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE "AiProcessingConsentEvent" FROM anon/);
  });

  it('has no owner / coach read branch and no non-service write policy', () => {
    expect(migration).not.toMatch(/is_owner|is_current_coach_of|coach_id|TeamSubCoach/i);
    const policies = [...migration.matchAll(/CREATE POLICY "([^"]+)"[\s\S]*?;/g)].map((m) => m[0]);
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      if (/TO service_role/.test(p)) continue;
      if (/AS RESTRICTIVE FOR ALL TO anon USING \(false\) WITH CHECK \(false\)/.test(p)) continue;
      expect(p).toMatch(/FOR SELECT TO public/);
    }
  });

  it('the rls-live-tests CI job runs the live ledger suite', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('\n  rls-live-tests:'), ci.indexOf('\n  mwb-3-live-tests:'));
    expect(job).toContain(
      'npx jest --config jest.rls.config.js test/rls/ai-processing-consent-ledger-rls.spec.ts',
    );
  });

  it('the flag is registered default OFF and documented default false', () => {
    const switches = read('prod-switches.yml');
    const row = switches.slice(switches.indexOf('- name: FEATURE_AI_CONSENT_LEDGER_ENABLED'));
    expect(row).toMatch(/^- name: FEATURE_AI_CONSENT_LEDGER_ENABLED\n\s+tier: feature\n\s+prod_default: OFF\n\s+auto_flip_on_in_prod: false/);
    expect(read('.env.example')).toMatch(/^FEATURE_AI_CONSENT_LEDGER_ENABLED=false$/m);
  });

  it('AppModule mounts AiConsentModule', () => {
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? [];
    expect(imports).toContain(AiConsentModule);
  });

  it('only the AI egress gate (src/ai-egress) and app.module import the ledger', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && /from '[^']*\/ai-consent\//.test(fs.readFileSync(p, 'utf8'))) {
          hits.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    const outside = hits.filter((h) => !h.startsWith('src/ai-consent/'));
    // R2b — every AI call site reaches the ledger only through AiEgressService
    // (src/ai-egress); none imports it directly.
    expect(outside.sort()).toEqual([
      'src/ai-egress/ai-egress.module.ts',
      'src/ai-egress/ai-egress.service.ts',
      'src/app.module.ts',
    ]);
  });
});
