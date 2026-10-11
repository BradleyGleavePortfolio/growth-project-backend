import type { Prisma } from '@prisma/client';
import {
  interpretClient,
  interpretEntity,
  parseSourceMappingSpec,
} from '../../../src/scout/reconstruct/mapping-spec';
import { loadNativeRuleSets } from '../../../src/scout/reconstruct/native/native-rule-registry';
import {
  interpretProgram,
  interpretWorkout,
  parseNativeRuleSet,
} from '../../../src/scout/reconstruct/native/native-rules';
import {
  buildPayloadKeepPlan,
  keepDeclaredPayload,
} from '../../../src/scout/reconstruct/payload-keep';
import { loadSourceMappingSpecs } from '../../../src/scout/reconstruct/source-mapper-registry';

// PRIV-04: the kept payload holds only declared paths, and every declared rule
// reads the same value from it as from the full record. All values are synthetic.
const EXTRA = {
  email: 'other.client@example.com',
  phone: '+1 555 0100',
  notes: 'private note from the other platform',
  html: '<div>full page</div>',
  coach: { name: 'Another coach', email: 'coach@example.com' },
};
const LEAKS = ['other.client@example.com', '+1 555 0100', 'private note', '<div>', 'Another coach'];

const leaks = (kept: unknown): string[] => {
  const text = JSON.stringify(kept);
  return LEAKS.filter((leak) => text.includes(leak));
};

describe('keepDeclaredPayload (repository specs)', () => {
  const specs = loadSourceMappingSpecs();
  const plan = buildPayloadKeepPlan(specs, loadNativeRuleSets());

  it('keeps a client name and drops email, phone, notes, raw HTML and other coaches', () => {
    const payload = { name: 'Synthetic Client', ...EXTRA };
    expect(keepDeclaredPayload(plan, 'truecoach', payload)).toEqual({ name: 'Synthetic Client' });
  });

  it('every repository spec maps the kept payload exactly as the full one', () => {
    for (const spec of specs) {
      for (const [family, rules] of Object.entries(spec.families)) {
        const payload: Record<string, Prisma.JsonValue> = { ...EXTRA };
        let n = 0;
        for (const rule of Object.values(rules ?? {})) {
          for (const path of rule.paths) {
            let cursor = payload;
            for (const key of path.slice(0, -1)) {
              cursor = (cursor[key] ??= {}) as Record<string, Prisma.JsonValue>;
            }
            cursor[path[path.length - 1]] = `v${n++}`;
          }
        }
        const full = { source_id: 'id-1', source_platform: spec.sourcePlatform, payload };
        const kept = {
          ...full,
          payload: keepDeclaredPayload(plan, spec.sourcePlatform, payload) as Prisma.JsonValue,
        };
        expect(leaks(kept.payload)).toEqual([]);
        if (family === 'clients') {
          expect(interpretClient(spec, kept)).toEqual(interpretClient(spec, full));
        } else {
          expect(interpretEntity(spec, family, kept)).toEqual(interpretEntity(spec, family, full));
        }
      }
    }
  });
});

describe('keepDeclaredPayload (native rules)', () => {
  const spec = parseSourceMappingSpec(
    {
      specVersion: 1,
      sourcePlatform: 'keep-proof',
      steps: { w: 'workouts' },
      families: {
        workouts: {
          clientSourceId: { paths: [['owner']], coerce: 'string' },
          label: { paths: [['meta'], ['title']], coerce: 'string' },
        },
      },
    },
    'test',
  );
  const rules = parseNativeRuleSet(
    {
      specVersion: 1,
      sourcePlatform: 'keep-proof',
      families: {
        programs: { daysPerWeek: { kind: 'count', paths: [['days']] } },
        workouts: {
          type: { kind: 'enum', paths: [['kind']], map: { lift: 'strength' } },
          exercises: {
            paths: [['items']],
            item: {
              id: { kind: 'identifier', paths: [['id']] },
              exerciseRef: { kind: 'identifier', paths: [['exercise']] },
              order: { kind: 'integer', paths: [['position']] },
              sets: { kind: 'integer', paths: [['sets']] },
              reps: { kind: 'integer', paths: [['reps']] },
              notes: { kind: 'text', paths: [['notes']] },
            },
          },
        },
      },
    },
    'test',
  );
  const plan = buildPayloadKeepPlan([spec], [rules]);
  const seam = (payload: Prisma.JsonValue) => ({
    sourcePlatform: 'keep-proof',
    label: 'Push',
    clientSourceId: null,
    payload,
    sourceId: 'w-1',
  });

  it('keeps exercise fields and array lengths only, with identical native results', () => {
    const payload = {
      kind: 'lift',
      days: [{ day: 'mon', ...EXTRA }, { day: 'tue' }],
      items: [
        { id: 'e1', exercise: 'plank', position: 0, sets: 3, reps: 8, email: EXTRA.email },
        'not-an-item',
      ],
      ...EXTRA,
    };
    const kept = keepDeclaredPayload(plan, 'keep-proof', payload) as Prisma.JsonValue;
    expect(kept).toEqual({
      kind: 'lift',
      days: [null, null],
      items: [{ id: 'e1', exercise: 'plank', position: 0, sets: 3, reps: 8 }, null],
    });
    expect(interpretWorkout(rules.families.workouts, seam(kept))).toEqual(
      interpretWorkout(rules.families.workouts, seam(payload)),
    );
    expect(interpretProgram(rules.families.programs, seam(kept))).toEqual(
      interpretProgram(rules.families.programs, seam(payload)),
    );
  });

  it('an object at a declared path stays unusable without keeping its contents', () => {
    const payload = { meta: { secret: 'x', email: 'a@example.com' }, title: 'Push' };
    const kept = keepDeclaredPayload(plan, 'keep-proof', payload) as Prisma.JsonValue;
    expect(kept).toEqual({ meta: {}, title: 'Push' });
    const row = (p: Prisma.JsonValue) => ({
      source_id: 'w',
      source_platform: 'keep-proof',
      payload: p,
    });
    expect(interpretEntity(spec, 'workouts', row(kept))).toEqual(
      interpretEntity(spec, 'workouts', row(payload)),
    );
  });
});
