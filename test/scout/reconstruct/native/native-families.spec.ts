import type { Prisma } from '@prisma/client';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildFamilyRegistry,
  LEDGER_TARGET_KIND,
} from '../../../../src/scout/reconstruct/families';
import { parseSourceMappingSpec } from '../../../../src/scout/reconstruct/mapping-spec';
import { buildNativeFamilies } from '../../../../src/scout/reconstruct/native/native-families';
import {
  buildNativeRuleRegistry,
  loadNativeRuleSets,
  NATIVE_RULES_DIR,
} from '../../../../src/scout/reconstruct/native/native-rule-registry';
import { parseNativeRuleSet } from '../../../../src/scout/reconstruct/native/native-rules';
import { buildSourceMapperRegistry } from '../../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_FAMILY } from '../../../../src/scout/scout-reconstruct.dto';
import { FakeNativeTx } from './fake-native-tx';

const PLATFORM = 's8c-proof';

/** Synthetic S8-A spec: `routines` is the workouts step, `blocks` the programs step. */
const SPEC = parseSourceMappingSpec(
  {
    specVersion: 1,
    sourcePlatform: PLATFORM,
    steps: { people: 'clients', routines: 'workouts', blocks: 'programs', log: 'client_history' },
    families: {
      clients: { displayName: { paths: [['name']], coerce: 'string' } },
      workouts: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      programs: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      client_history: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
    },
  },
  'test',
);

const RULES = parseNativeRuleSet(
  {
    specVersion: 1,
    sourcePlatform: PLATFORM,
    families: {
      programs: {
        weeks: { kind: 'integer', paths: [['weeks']] },
        daysPerWeek: { kind: 'integer', paths: [['days']] },
      },
      workouts: {
        type: {
          kind: 'enum',
          paths: [['type']],
          map: { strength: 'strength' },
          default: 'strength',
        },
      },
    },
  },
  'test',
);

const mappers = buildSourceMapperRegistry([SPEC]);
const declared = buildNativeFamilies({
  sourceMappers: mappers,
  nativeRules: buildNativeRuleRegistry([RULES]),
});
const undeclared = buildNativeFamilies({
  sourceMappers: mappers,
  nativeRules: buildNativeRuleRegistry([]),
});

const row = (payload: Prisma.JsonValue, entity_type?: string, source_platform = PLATFORM) => ({
  source_id: 'w-1',
  source_platform,
  payload,
  ...(entity_type === undefined ? {} : { entity_type }),
});

describe('native families — dispatch through the accepted resolveStep guard', () => {
  it('refuses an unregistered platform with the accepted reason', () => {
    expect(declared.workouts.map(row({ title: 'x' }, undefined, 'nobody'))).toEqual({
      ok: false,
      reason: 'unsupported_platform:nobody',
    });
  });

  it('refuses a token that resolves to another family (A3) and an unmapped token', () => {
    expect(declared.programs.map(row({ title: 'x' }, 'routines'))).toEqual({
      ok: false,
      reason: 'unresolved_family:routines',
    });
    expect(declared.workouts.map(row({ title: 'x' }, 'blocks'))).toEqual({
      ok: false,
      reason: 'unresolved_family:blocks',
    });
    expect(declared.workouts.map(row({ title: 'x' }, 'notes'))).toEqual({
      ok: false,
      reason: 'unresolved_family:notes',
    });
  });

  it('accepts the step token or the canonical family name as the staged entity_type', () => {
    expect(declared.workouts.map(row({ title: 'Push' }, 'routines')).ok).toBe(true);
    expect(declared.workouts.map(row({ title: 'Push' }, 'workouts')).ok).toBe(true);
    expect(declared.workouts.map(row({ title: 'Push' })).ok).toBe(true);
    expect(declared.programs.map(row({ title: 'Base', weeks: 4, days: 3 }, 'blocks')).ok).toBe(
      true,
    );
  });

  it('fails closed when the source spec does not declare the family', () => {
    const noPrograms = parseSourceMappingSpec(
      {
        specVersion: 1,
        sourcePlatform: PLATFORM,
        steps: { routines: 'workouts' },
        families: {
          workouts: {
            clientSourceId: { paths: [['client_id']], coerce: 'string' },
            label: { paths: [['title']], coerce: 'string' },
          },
        },
      },
      'test',
    );
    const families = buildNativeFamilies({
      sourceMappers: buildSourceMapperRegistry([noPrograms]),
      nativeRules: buildNativeRuleRegistry([RULES]),
    });
    expect(families.programs.map(row({ title: 'Base' }))).toEqual({
      ok: false,
      reason: 'unresolved_family:programs',
    });
  });
});

describe('native families — workouts disposition', () => {
  it('without declared native rules every workout is the accepted evidence row (no native guess)', () => {
    // Bare accepted MappedEntity — identical to the legacy generic family result.
    expect(undeclared.workouts.map(row({ title: 'Push', client_id: 7 }))).toEqual({
      ok: true,
      mapped: { sourcePlatform: PLATFORM, clientSourceId: '7', label: 'Push' },
    });
    expect(undeclared.workouts.map(row({ title: 'Push' }))).toEqual({
      ok: true,
      mapped: { sourcePlatform: PLATFORM, clientSourceId: null, label: 'Push' },
    });
  });

  it('with declared rules: client-linked → evidence + unresolved marker; unlinked → native template', () => {
    expect(declared.workouts.map(row({ title: 'Push', client_id: 7 }))).toEqual({
      ok: true,
      mapped: {
        mode: 'evidence',
        entity: { sourcePlatform: PLATFORM, clientSourceId: '7', label: 'Push' },
        recordNoNativePrincipal: true,
      },
    });
    expect(declared.workouts.map(row({ title: 'Push' }))).toEqual({
      ok: true,
      mapped: {
        mode: 'native',
        template: {
          sourcePlatform: PLATFORM,
          name: 'Push',
          type: 'strength',
          durationEstimateMinutes: null,
          programSourceId: null,
          weekIndex: null,
          dayIndex: null,
          exercises: [],
          tags: ['defaulted:type'],
        },
      },
    });
  });

  it('programs never fall back to evidence: client-linked is an explicit unresolved skip', () => {
    expect(declared.programs.map(row({ title: 'Base', weeks: 4, days: 3, client_id: 7 }))).toEqual({
      ok: false,
      reason: 'unresolved:no_native_client_principal',
    });
    expect(undeclared.programs.map(row({ title: 'Base' }))).toEqual({
      ok: false,
      reason: 'unresolved:missing_required_field:weeks',
    });
  });

  it('persist returns typed outcomes and, in evidence mode, never touches provenance', async () => {
    const tx = new FakeNativeTx();
    const mapped = undeclared.workouts.map(row({ title: 'Push', client_id: 7 }));
    if (!mapped.ok) throw new Error('setup');
    const out = await undeclared.workouts.persist(tx.asTx(), 'coach-a', 'w-1', mapped.mapped);
    expect(out).toMatchObject({ ok: true, targetKind: LEDGER_TARGET_KIND.scout_entity });
    expect(tx.calls).toEqual(['scoutReconstructedEntity.upsert']);
    expect(tx.provenance.size).toBe(0);
  });
});

describe('family registry (owned wiring)', () => {
  it('registers clients, workouts, client_history and programs; legacy families keep the legacy result shape', async () => {
    const registry = buildFamilyRegistry({
      sourceMappers: mappers,
      nativeRules: buildNativeRuleRegistry([RULES]),
    });
    expect([...registry.keys()]).toEqual(['clients', 'workouts', 'client_history', 'programs']);
    expect(Object.values(RECONSTRUCT_FAMILY)).toEqual([
      'clients',
      'workouts',
      'client_history',
      'programs',
    ]);
    // Legacy families keep the repository mapper registry (the injection seam
    // covers the native families only), so map an accepted-source row.
    const history = registry.get('client_history')!;
    const mapped = history.map({
      source_id: 'h-1',
      source_platform: 'truecoach',
      payload: { title: 'Ran 5k', client_id: 7 },
    });
    if (!mapped.ok) throw new Error('setup');
    const tx = new FakeNativeTx();
    await expect(history.persist(tx.asTx(), 'coach-a', 'h-1', mapped.mapped)).resolves.toEqual(
      expect.any(String),
    );
  });

  // S10-D P: invariants over WHATEVER ships (a new data-only source adds a rule set without
  // touching this spec), never "the directory is absent". A shipped rule set must be a declared,
  // consistent artifact of a shipped mapping spec; the positive guard stays: the production
  // TrueCoach source ships no guessed native rules (its exercise payload shape is not established).
  const PRODUCTION_WITHOUT_NATIVE_RULES = ['truecoach'] as const;
  const guessedProduction = (registry: ReadonlyMap<string, unknown>) =>
    PRODUCTION_WITHOUT_NATIVE_RULES.filter((platform) => registry.has(platform));
  /** Every shipped rule set pairs with exactly one shipped spec and names only its families. */
  const nativeRuleViolations = (
    sets: readonly { sourcePlatform: string; families: object }[],
    specs: ReadonlyMap<string, { spec: { families: object } }>,
  ): string[] => {
    const out: string[] = [];
    for (const set of sets) {
      const mapper = specs.get(set.sourcePlatform);
      if (mapper === undefined) {
        out.push(`${set.sourcePlatform}: no shipped mapping spec`);
        continue;
      }
      for (const family of Object.keys(set.families)) {
        if (!Object.prototype.hasOwnProperty.call(mapper.spec.families, family))
          out.push(`${set.sourcePlatform}: ${family} is not a family of its spec`);
      }
    }
    return out;
  };

  it('every shipped native rule set is declared data for a shipped spec (none guessed)', () => {
    const sets = loadNativeRuleSets(NATIVE_RULES_DIR);
    const registry = buildNativeRuleRegistry();
    // Loader and default registry agree on exactly the shipped files, one per platform.
    expect([...registry.keys()].sort()).toEqual(sets.map((s) => s.sourcePlatform).sort());
    if (sets.length > 0) {
      const files = readdirSync(NATIVE_RULES_DIR).filter((name) => name.endsWith('.json'));
      expect(files.sort()).toEqual(sets.map((s) => `${s.sourcePlatform}.json`).sort());
    }
    expect(nativeRuleViolations(sets, buildSourceMapperRegistry())).toEqual([]);
    // Positive guard: no production source ships guessed native rules.
    expect(guessedProduction(registry)).toEqual([]);
  });

  it('the invariant still fails on a real defect (a rule set with no spec, or a foreign family)', () => {
    const specs = buildSourceMapperRegistry([
      parseSourceMappingSpec(
        {
          specVersion: 1,
          sourcePlatform: 'p-defect',
          steps: { people: 'clients' },
          families: { clients: { displayName: { paths: [['name']], coerce: 'string' } } },
        },
        'p-defect',
      ),
    ]);
    const orphan = { sourcePlatform: 'p-orphan', families: { programs: {} } };
    const foreign = { sourcePlatform: 'p-defect', families: { workouts: {} } };
    expect(nativeRuleViolations([orphan, foreign], specs)).toEqual([
      'p-orphan: no shipped mapping spec',
      'p-defect: workouts is not a family of its spec',
    ]);
    // A production source that ever shipped rules would trip the positive guard above.
    const guessed = buildNativeRuleRegistry([
      parseNativeRuleSet({ specVersion: 1, sourcePlatform: 'truecoach', families: {} }, 'guess'),
    ]);
    expect(guessedProduction(guessed)).toEqual(['truecoach']);
  });

  it('absent directory → empty; present-but-empty directory fails closed', () => {
    expect(loadNativeRuleSets(join(mkdtempSync(join(tmpdir(), 's8c-absent-')), 'absent'))).toEqual(
      [],
    );
    expect(() => loadNativeRuleSets(mkdtempSync(join(tmpdir(), 's8c-empty-')))).toThrow(
      /no \*\.json/,
    );
  });
});

describe('module boundary — native writers reach no side-effecting service', () => {
  const NATIVE_DIR = join(__dirname, '../../../../src/scout/reconstruct/native');
  const FORBIDDEN = [
    'workout-builder',
    'notifications',
    'drip',
    'email',
    'billing',
    'stripe',
    'assignment',
    'analytics',
    'supabase',
    '@nestjs/common',
  ];

  it('imports only Prisma types, the S8-A seam and sibling native modules', () => {
    for (const file of readdirSync(NATIVE_DIR).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(NATIVE_DIR, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        for (const word of FORBIDDEN) expect(`${file}: ${spec}`).not.toMatch(new RegExp(word, 'i'));
        expect(
          spec === '@prisma/client' ||
            spec === 'fs' ||
            spec === 'path' ||
            spec.startsWith('./') ||
            spec === '../mapping-spec' ||
            spec === '../source-mapper-registry' ||
            spec === '../../scout-reconstruct.dto',
        ).toBe(true);
      }
    }
  });
});
