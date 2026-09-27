import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  interpretClient,
  interpretEntity,
  parseSourceMappingSpec,
  readField,
  resolveStep,
  type SourceMappingSpec,
} from '../../../src/scout/reconstruct/mapping-spec';
import {
  buildSourceMapperRegistry,
  loadSourceMappingSpecs,
  resolveStagedFamily,
  SOURCE_SPECS_DIR,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';

/**
 * S8-A — the data-only `SourceMappingSpec` grammar, its strict validation, the
 * generic interpreter's field semantics, and explicit `unresolved_family:<token>`
 * accounting for source steps no spec maps to a canonical family.
 */

const RULE = { paths: [['name']], coerce: 'string' };
const ENTITY_RULES = { clientSourceId: RULE, label: RULE };

function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: 1,
    sourcePlatform: 'spec_test',
    steps: { people: 'clients', sessions: 'client_history' },
    families: { clients: { displayName: RULE }, client_history: ENTITY_RULES },
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}): SourceMappingSpec {
  return parseSourceMappingSpec(validSpec(overrides), 'test');
}

describe('parseSourceMappingSpec — strict, fail-closed validation', () => {
  it('accepts a well-formed spec and freezes it', () => {
    const spec = parsed();
    expect(spec.sourcePlatform).toBe('spec_test');
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.steps)).toBe(true);
    expect(Object.isFrozen(spec.families)).toBe(true);
  });

  const rejects: [string, unknown, RegExp][] = [
    ['a non-object spec', [], /spec must be an object/],
    ['an unknown top-level key', validSpec({ extra: true }), /unknown key spec\.extra/],
    ['a missing top-level key', { specVersion: 1, sourcePlatform: 'x', steps: {} }, /families/],
    ['a wrong specVersion', validSpec({ specVersion: 2 }), /specVersion must be 1/],
    ['a non-canonical platform', validSpec({ sourcePlatform: 'TrueCoach' }), /canonical platform/],
    ['a blank platform', validSpec({ sourcePlatform: '' }), /canonical platform/],
    [
      'a non-canonical family (billing)',
      validSpec({ families: { billing: ENTITY_RULES } }),
      /families\.billing is not canonical/,
    ],
    [
      'a step targeting a non-canonical family',
      validSpec({ steps: { notes: 'notes' } }),
      /steps\.notes is not canonical/,
    ],
    [
      'a step targeting a family the spec does not map',
      validSpec({ steps: { routines: 'workouts' } }),
      /targets unmapped family workouts/,
    ],
    [
      'an unknown field (e.g. an email field)',
      validSpec({ families: { clients: { displayName: RULE, email: RULE } } }),
      /unknown key families\.clients\.email/,
    ],
    [
      'a missing field',
      validSpec({ families: { client_history: { label: RULE } } }),
      /missing key families\.client_history\.clientSourceId/,
    ],
    [
      'empty paths',
      validSpec({ families: { clients: { displayName: { paths: [], coerce: 'string' } } } }),
      /paths must be a non-empty array/,
    ],
    [
      'an empty path',
      validSpec({ families: { clients: { displayName: { paths: [[]], coerce: 'string' } } } }),
      /paths\[0\]/,
    ],
    [
      'a non-string key',
      validSpec({ families: { clients: { displayName: { paths: [[1]], coerce: 'string' } } } }),
      /paths\[0\]/,
    ],
    [
      'an unknown coercion',
      validSpec({ families: { clients: { displayName: { paths: [['n']], coerce: 'date' } } } }),
      /coerce must be one of/,
    ],
  ];
  for (const [label, raw, message] of rejects) {
    it(`rejects ${label}`, () => {
      expect(() => parseSourceMappingSpec(raw, 'test')).toThrow(message);
    });
  }
});

describe('parseSourceMappingSpec — one id space per canonical family (A3)', () => {
  const fanIn = { people: 'clients', sessions: 'client_history', logs: 'client_history' };

  it('rejects two steps mapping to one family without a declared shared id space', () => {
    expect(() => parseSourceMappingSpec(validSpec({ steps: fanIn }), 'test')).toThrow(
      /steps logs, sessions all map to client_history without a declared shared id space/,
    );
  });

  it('accepts the fan-in when the steps explicitly declare a shared id space', () => {
    const spec = parsed({
      steps: fanIn,
      sharedIdSpaces: { client_history: ['sessions', 'logs'] },
    });
    expect(spec.sharedIdSpaces).toEqual({ client_history: ['logs', 'sessions'] });
    expect(Object.isFrozen(spec.sharedIdSpaces)).toBe(true);
    expect(resolveStep(spec, 'sessions')).toEqual({ ok: true, family: 'client_history' });
    expect(resolveStep(spec, 'logs')).toEqual({ ok: true, family: 'client_history' });
  });

  it('rejects a declaration that omits a step of the fan-in', () => {
    expect(() =>
      parseSourceMappingSpec(
        validSpec({
          steps: { ...fanIn, extra: 'client_history' },
          sharedIdSpaces: { client_history: ['sessions', 'logs'] },
        }),
        'test',
      ),
    ).toThrow(/must list exactly the steps mapping to it \(extra, logs, sessions\)/);
  });

  it('rejects a declaration for a family with no multi-step fan-in', () => {
    expect(() =>
      parseSourceMappingSpec(validSpec({ sharedIdSpaces: { clients: ['people'] } }), 'test'),
    ).toThrow(/sharedIdSpaces\.clients declares no multi-step fan-in/);
  });

  it('rejects malformed declarations', () => {
    for (const sharedIdSpaces of [
      [],
      { billing: ['a', 'b'] },
      { client_history: 'sessions' },
      { client_history: ['sessions', 'sessions'] },
      { client_history: ['sessions', ''] },
    ]) {
      expect(() =>
        parseSourceMappingSpec(validSpec({ steps: fanIn, sharedIdSpaces }), 'test'),
      ).toThrow(/sharedIdSpaces/);
    }
  });

  // S10-D P: an invariant over WHATEVER ships (a new data-only source may declare a shared id
  // space without touching this spec), never "no shipped spec declares one". Every multi-step
  // fan-in is declared with exactly its steps; every 1:1 family carries no declaration.
  const sharedIdViolations = (spec: {
    sourcePlatform: string;
    steps: object;
    sharedIdSpaces?: object;
  }): string[] => {
    const fanIn: Record<string, string[]> = {};
    for (const [step, family] of Object.entries(spec.steps as Record<string, string>)) {
      (fanIn[family] ??= []).push(step);
    }
    const declared = (spec.sharedIdSpaces ?? {}) as Record<string, readonly string[] | undefined>;
    const out: string[] = [];
    for (const family of new Set([...Object.keys(fanIn), ...Object.keys(declared)])) {
      const steps = [...(fanIn[family] ?? [])].sort();
      const shared = declared[family];
      if (steps.length < 2 && shared !== undefined) {
        out.push(`${spec.sourcePlatform}:${family} 1:1`);
      }
      if (steps.length >= 2 && JSON.stringify([...(shared ?? [])].sort()) !== JSON.stringify(steps))
        out.push(`${spec.sourcePlatform}:${family} undeclared fan-in`);
    }
    return out;
  };

  it('every shipped spec declares exactly its multi-step fan-ins (and nothing for 1:1 families)', () => {
    const specs = loadSourceMappingSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(sharedIdViolations(spec)).toEqual([]);
    // Positive guard: the production TrueCoach spec stays 1:1 with no declaration.
    const truecoach = specs.find((spec) => spec.sourcePlatform === 'truecoach');
    if (truecoach === undefined) throw new Error('the truecoach spec is not shipped');
    const families = Object.values(truecoach.steps);
    expect(new Set(families).size).toBe(families.length);
    expect(truecoach.sharedIdSpaces).toBeUndefined();
  });

  it('the shipped-spec invariant still fails on a real defect', () => {
    const steps = { people: 'clients', sessions: 'workouts', routines: 'workouts' };
    expect(sharedIdViolations({ sourcePlatform: 'd', steps })).toEqual([
      'd:workouts undeclared fan-in',
    ]);
    expect(
      sharedIdViolations({
        sourcePlatform: 'd',
        steps,
        sharedIdSpaces: { workouts: ['sessions'], clients: ['people'] },
      }),
    ).toEqual(['d:clients 1:1', 'd:workouts undeclared fan-in']);
    expect(
      sharedIdViolations({
        sourcePlatform: 'd',
        steps,
        sharedIdSpaces: { workouts: ['routines', 'sessions'] },
      }),
    ).toEqual([]);
  });
});

describe('readField — first non-nullish path, then typed coercion', () => {
  it('walks nested own keys and treats a non-object level as absent', () => {
    const rule = { paths: [['a', 'b']], coerce: 'string' } as const;
    expect(readField({ a: { b: ' x ' } }, rule)).toBe('x');
    expect(readField({ a: 'b' }, rule)).toBeNull();
    expect(readField({ a: [{ b: 'x' }] }, rule)).toBeNull();
    expect(readField(null, rule)).toBeNull();
  });

  it('does not fall through past a present-but-unusable value (?? semantics)', () => {
    const rule = { paths: [['first'], ['second']], coerce: 'string' } as const;
    expect(readField({ first: '', second: 'S' }, rule)).toBeNull();
    expect(readField({ first: 5, second: 'S' }, rule)).toBeNull();
    expect(readField({ first: null, second: 'S' }, rule)).toBe('S');
    expect(readField({ second: 'S' }, rule)).toBe('S');
  });

  it('stringifies finite numbers only under string_or_finite_number', () => {
    const strict = { paths: [['v']], coerce: 'string' } as const;
    const loose = { paths: [['v']], coerce: 'string_or_finite_number' } as const;
    expect(readField({ v: 7 }, strict)).toBeNull();
    expect(readField({ v: 7 }, loose)).toBe('7');
    expect(readField({ v: Number.POSITIVE_INFINITY }, loose)).toBeNull();
    expect(readField({ v: true }, loose)).toBeNull();
  });

  it('never reads an inherited prototype property', () => {
    const rule = { paths: [['constructor']], coerce: 'string' } as const;
    expect(readField({}, rule)).toBeNull();
  });
});

describe('interpreter — identity guard and unresolved families', () => {
  const spec = parsed();

  it('keys the person on the once-trimmed source_id (unchanged persisted identity)', () => {
    expect(
      interpretClient(spec, {
        source_id: '  p-1 ',
        source_platform: 'spec_test',
        payload: { name: 'N' },
      }),
    ).toEqual({
      ok: true,
      client: { sourcePersonId: 'p-1', sourcePlatform: 'spec_test', displayName: 'N' },
    });
  });

  it('fails a foreign platform and a blank id with the legacy reasons', () => {
    expect(
      interpretClient(spec, { source_id: 'p', source_platform: 'other', payload: {} }),
    ).toEqual({ ok: false, reason: 'unsupported_platform:other' });
    expect(
      interpretEntity(spec, RECONSTRUCT_FAMILY.client_history, {
        source_id: ' ',
        source_platform: 'spec_test',
        payload: {},
      }),
    ).toEqual({ ok: false, reason: 'missing_source_id' });
  });

  it('reports a canonical family the spec does not map as unresolved_family', () => {
    const row = { source_id: 'w-1', source_platform: 'spec_test', payload: {} };
    expect(interpretEntity(spec, RECONSTRUCT_FAMILY.workouts, row)).toEqual({
      ok: false,
      reason: 'unresolved_family:workouts',
    });
    const noClients = parsed({ steps: {}, families: { workouts: ENTITY_RULES } });
    expect(interpretClient(noClients, row)).toEqual({
      ok: false,
      reason: 'unresolved_family:clients',
    });
  });

  it('resolves mapped steps and reports unmapped steps as unresolved_family:<token>', () => {
    expect(resolveStep(spec, 'people')).toEqual({ ok: true, family: 'clients' });
    expect(resolveStep(spec, 'sessions')).toEqual({ ok: true, family: 'client_history' });
    expect(resolveStep(spec, 'notes')).toEqual({ ok: false, reason: 'unresolved_family:notes' });
    expect(resolveStep(spec, 'toString')).toEqual({
      ok: false,
      reason: 'unresolved_family:toString',
    });
  });
});

describe('repository specs — the live sources', () => {
  const registry = buildSourceMapperRegistry();

  it('TrueCoach `notes` and the undeclared canonical `programs` family are unresolved', () => {
    expect(resolveStagedFamily(registry, 'truecoach', 'notes')).toEqual({
      ok: false,
      reason: 'unresolved_family:notes',
    });
    for (const family of Object.values(RECONSTRUCT_FAMILY)) {
      if (family === RECONSTRUCT_FAMILY.programs) {
        // Canonical, but the accepted truecoach.json declares no `programs` rules: fail closed.
        expect(resolveStagedFamily(registry, 'truecoach', family)).toEqual({
          ok: false,
          reason: 'unresolved_family:programs',
        });
        continue;
      }
      expect(resolveStagedFamily(registry, 'truecoach', family)).toEqual({ ok: true, family });
    }
  });

  it('conformance_alpha maps its own step tokens and leaves `coaches` unresolved', () => {
    expect(resolveStagedFamily(registry, 'conformance_alpha', 'members')).toEqual({
      ok: true,
      family: 'clients',
    });
    expect(resolveStagedFamily(registry, 'conformance_alpha', 'routines')).toEqual({
      ok: true,
      family: 'workouts',
    });
    expect(resolveStagedFamily(registry, 'conformance_alpha', 'activity-log')).toEqual({
      ok: true,
      family: 'client_history',
    });
    expect(resolveStagedFamily(registry, 'conformance_alpha', 'coaches')).toEqual({
      ok: false,
      reason: 'unresolved_family:coaches',
    });
  });

  it('an unregistered platform stays unsupported_platform:<token>', () => {
    expect(resolveStagedFamily(registry, 'trainerize', 'clients')).toEqual({
      ok: false,
      reason: 'unsupported_platform:trainerize',
    });
  });

  it('every shipped spec parses and is keyed by its own sourcePlatform', () => {
    const files = readdirSync(SOURCE_SPECS_DIR).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const name of files) {
      const spec = parseSourceMappingSpec(
        JSON.parse(readFileSync(join(SOURCE_SPECS_DIR, name), 'utf8')) as unknown,
        name,
      );
      expect(registry.get(spec.sourcePlatform)?.spec).toEqual(spec);
    }
  });

  it('field meaning is data: no reconstruct TypeScript names a source field key', () => {
    const keys = new Set<string>();
    for (const spec of loadSourceMappingSpecs()) {
      for (const rules of Object.values(spec.families)) {
        for (const rule of Object.values(rules ?? {})) {
          for (const path of rule.paths) for (const key of path) keys.add(key);
        }
      }
    }
    const dir = join(__dirname, '../../../src/scout/reconstruct');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const key of keys) {
        expect(source.includes(`'${key}'`) || source.includes(`"${key}"`)).toBe(false);
      }
    }
  });
});

describe('loadSourceMappingSpecs — fail closed on the spec directory', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 's8a-specs-'));

  it('throws on an empty directory instead of registering nothing', () => {
    expect(() => loadSourceMappingSpecs(dir())).toThrow(/no source mapping specs/);
  });

  it('throws on a missing directory', () => {
    expect(() => loadSourceMappingSpecs(join(dir(), 'absent'))).toThrow();
  });

  it('throws on two specs claiming one sourcePlatform', () => {
    const d = dir();
    writeFileSync(join(d, 'a.json'), JSON.stringify(validSpec()));
    writeFileSync(join(d, 'b.json'), JSON.stringify(validSpec()));
    expect(() => loadSourceMappingSpecs(d)).toThrow(/duplicate source mapping spec/);
  });

  it('throws on a malformed spec, naming the file', () => {
    const d = dir();
    writeFileSync(join(d, 'bad.json'), JSON.stringify(validSpec({ specVersion: 9 })));
    expect(() => loadSourceMappingSpecs(d)).toThrow(/bad\.json/);
  });

  it('loads in byte-sorted filename order and ignores non-JSON files', () => {
    const d = dir();
    writeFileSync(join(d, 'z.json'), JSON.stringify(validSpec({ sourcePlatform: 'zeta' })));
    writeFileSync(join(d, 'a.json'), JSON.stringify(validSpec({ sourcePlatform: 'alpha' })));
    writeFileSync(join(d, 'README.md'), 'not a spec');
    expect(loadSourceMappingSpecs(d).map((spec) => spec.sourcePlatform)).toEqual(['alpha', 'zeta']);
  });
});
