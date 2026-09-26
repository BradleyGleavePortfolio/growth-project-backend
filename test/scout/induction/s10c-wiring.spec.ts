import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ObservationModule } from '../../../src/scout/induction/observation.module';
import { ObservationService } from '../../../src/scout/induction/observation.service';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutModule } from '../../../src/scout/scout.module';
import { S10_PURE_SPEC_PATH } from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-C wiring (S10-DOC D-S10-7 row S10-C; D-S10-6 invariant 5 / R38 unit half; D-S10-8).
 * The routes are mounted by importing the S10-B module into ScoutModule and nothing else; the
 * settle / status path and the induction modules import no customer-facing side-effect module;
 * and no source name reaches `src/`.
 */

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The settle / status path S10-C touched (ScoutModule's pre-S10 NotificationsModule import is the
 *  S7-L `import.complete` push of ScoutService, outside this path, and is not re-audited here). */
const S10C_SETTLE_PATH = [
  'src/scout/reconciliation/facts.service.ts',
  'src/scout/lifecycle/lifecycle.service.ts',
  'src/scout/reconciliation/types.ts',
  'src/scout/reconciliation/reconcile.ts',
  'src/scout/reconciliation/coverage.ts',
  'src/scout/lifecycle/arbiter.ts',
];
const INDUCTION_DIR = join(SRC, 'scout', 'induction');
const SIDE_EFFECT_IMPORT = /from\s+'[^']*(notification|drip|email|mail|messag|sms|push)[^']*'/i;

/** The fixture slug lives in test/fixtures only; the mapping spec's own name is the truth. */
const FIXTURE_SLUG = String(JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8')).sourcePlatform);

describe('S10-C module registration', () => {
  it('ScoutModule imports ObservationModule (the routes are mounted), alongside its S9-C imports', () => {
    const imports: unknown[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ScoutModule) ?? [];
    expect(imports).toContain(ObservationModule);
    expect(imports.filter((m) => m === ObservationModule)).toHaveLength(1);
  });

  it('ObservationModule imports no module at all (self-contained; invariant 5)', () => {
    const imports: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, ObservationModule) ?? [];
    expect(imports).toEqual([]);
  });

  it('ObservationModule declares no PrismaService provider: it uses the @Global PrismaModule client (review B A1)', () => {
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ObservationModule) ?? [];
    expect(providers).not.toContain(PrismaService);
    expect(providers).toContain(ObservationService);
    const source = readFileSync(join(SRC, 'scout', 'induction', 'observation.module.ts'), 'utf8');
    expect(source).not.toMatch(/prisma\.service/);
  });
});

describe('S10-C D-S10-6 invariant 5 / R38 (unit half): no customer side-effect import', () => {
  const files = [...S10C_SETTLE_PATH.map((f) => join(ROOT, f)), ...walk(INDUCTION_DIR)];

  it.each(files.map((f) => [relative(ROOT, f)]))('%s', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trimStart().startsWith('import') && !line.includes('require(')) continue;
      expect(line).not.toMatch(SIDE_EFFECT_IMPORT);
    }
  });
});

describe('S10-C D-S10-8: no source-name literal in src/**/*.ts', () => {
  it(`the fixture slug appears in no src file`, () => {
    expect(FIXTURE_SLUG.length).toBeGreaterThan(0);
    const offenders = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(FIXTURE_SLUG));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
