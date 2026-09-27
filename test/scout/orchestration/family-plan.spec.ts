import { buildFamilyRegistry } from '../../../src/scout/reconstruct/families';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import {
  planRun,
  RUN_FAMILY_ORDER,
} from '../../../src/scout/reconstruct/orchestration/family-plan';
import { buildSourceMapperRegistry } from '../../../src/scout/reconstruct/source-mapper-registry';

// S8-G pure planner: distinct staged (source_platform, entity_type) groups → contract §3.8-ordered
// canonical families plus explicit unmapped tokens with the exact S8-A reason. No I/O, no doubles.

const PLATFORM = 's8g-proof';
const spec = parseSourceMappingSpec(
  {
    specVersion: 1,
    sourcePlatform: PLATFORM,
    steps: { people: 'clients', blocks: 'programs', routines: 'workouts', log: 'client_history' },
    families: {
      clients: { displayName: { paths: [['name']], coerce: 'string' } },
      programs: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      workouts: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      client_history: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
    },
  },
  'family-plan.spec:fixture',
);
const mappers = buildSourceMapperRegistry([spec]);
const registry = buildFamilyRegistry({ sourceMappers: mappers });

const staged = (rows: [string, string, number][]) =>
  rows.map(([source_platform, entity_type, n]) => ({
    source_platform,
    entity_type,
    _count: { _all: n },
  }));

describe('RUN_FAMILY_ORDER (contract §3.8)', () => {
  it('is clients → programs → workouts → client_history, not the dto declaration order', () => {
    expect(RUN_FAMILY_ORDER).toEqual(['clients', 'programs', 'workouts', 'client_history']);
  });
});

describe('planRun', () => {
  it('orders planned families by §3.8 regardless of staged input order and resolves tokens', () => {
    const plan = planRun(
      staged([
        [PLATFORM, 'log', 1],
        [PLATFORM, 'routines', 2],
        [PLATFORM, 'people', 3],
        [PLATFORM, 'blocks', 1],
      ]),
      mappers,
      registry,
    );
    expect(plan.ordered).toEqual([
      { family: 'clients', sources: [{ source_platform: PLATFORM, token: 'people', staged: 3 }] },
      { family: 'programs', sources: [{ source_platform: PLATFORM, token: 'blocks', staged: 1 }] },
      {
        family: 'workouts',
        sources: [{ source_platform: PLATFORM, token: 'routines', staged: 2 }],
      },
      {
        family: 'client_history',
        sources: [{ source_platform: PLATFORM, token: 'log', staged: 1 }],
      },
    ]);
    expect(plan.unmapped).toEqual([]);
  });

  it('routes an unmapped step token (notes) to unmapped with the exact S8-A reason', () => {
    const plan = planRun(
      staged([
        [PLATFORM, 'notes', 2],
        [PLATFORM, 'people', 1],
      ]),
      mappers,
      registry,
    );
    expect(plan.ordered.map((f) => f.family)).toEqual(['clients']);
    expect(plan.unmapped).toEqual([
      { source_platform: PLATFORM, token: 'notes', staged: 2, reason: 'unresolved_family:notes' },
    ]);
  });

  it('routes an unregistered platform to unmapped with unsupported_platform:<platform>', () => {
    const plan = planRun(staged([['ghost', 'clients', 1]]), mappers, registry);
    expect(plan.ordered).toEqual([]);
    expect(plan.unmapped).toEqual([
      {
        source_platform: 'ghost',
        token: 'clients',
        staged: 1,
        reason: 'unsupported_platform:ghost',
      },
    ]);
  });

  it('a canonical family name staged as a token is NOT a family unless the spec maps it', () => {
    // The fixture spec maps `people`, not `clients`: the engine never guesses from the token text.
    const plan = planRun(staged([[PLATFORM, 'clients', 1]]), mappers, registry);
    expect(plan.ordered).toEqual([]);
    expect(plan.unmapped[0]).toMatchObject({
      token: 'clients',
      reason: 'unresolved_family:clients',
    });
  });

  it('routes a spec-resolved family the registry does not hold to unmapped (fail closed)', () => {
    const partial = new Map([...registry].filter(([family]) => family !== 'programs'));
    const plan = planRun(staged([[PLATFORM, 'blocks', 4]]), mappers, partial);
    expect(plan.ordered).toEqual([]);
    expect(plan.unmapped).toEqual([
      { source_platform: PLATFORM, token: 'blocks', staged: 4, reason: 'unresolved_family:blocks' },
    ]);
  });

  it('omits families with no staged rows and never invents a family', () => {
    const plan = planRun(staged([[PLATFORM, 'blocks', 4]]), mappers, registry);
    expect(plan.ordered).toEqual([
      { family: 'programs', sources: [{ source_platform: PLATFORM, token: 'blocks', staged: 4 }] },
    ]);
  });

  it('keeps one family entry per canonical family across several platforms, sources ordered', () => {
    const plan = planRun(
      staged([
        ['truecoach', 'workouts', 2],
        [PLATFORM, 'routines', 1],
      ]),
      new Map([...mappers, ...buildSourceMapperRegistry()]),
      registry,
    );
    const workouts = plan.ordered.find((f) => f.family === 'workouts');
    expect(plan.ordered).toHaveLength(1);
    expect(workouts?.sources).toEqual([
      { source_platform: PLATFORM, token: 'routines', staged: 1 },
      { source_platform: 'truecoach', token: 'workouts', staged: 2 },
    ]);
  });

  it('is pure: the same input yields an equal plan and the input is not mutated', () => {
    const input = staged([
      [PLATFORM, 'notes', 1],
      [PLATFORM, 'people', 1],
    ]);
    const copy = JSON.parse(JSON.stringify(input));
    expect(planRun(input, mappers, registry)).toEqual(planRun(input, mappers, registry));
    expect(input).toEqual(copy);
  });
});
