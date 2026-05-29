import {
  ASSIGNABLE_ASSET_RESOLVERS,
  AssignableAssetResolverRegistry,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { UnknownAssignableAssetTypeError } from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';
import type {
  AssignableAssetResolver,
  AssignableAssetType,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.interface';

// PR-7 — registry resolution coverage. Mirrors the
// CapabilityMaterializerRegistry spec to keep parity between the two
// dispatch surfaces.

function makeResolver(
  assetType: AssignableAssetType,
  extraHandles: string[] = [],
): AssignableAssetResolver {
  return {
    assetType,
    canHandle: jest.fn(
      (c: string) => c === assetType || extraHandles.includes(c),
    ),
    materialise: jest.fn(async () => ({ materialisedRef: `ref:${assetType}` })),
  };
}

describe('AssignableAssetResolverRegistry', () => {
  it('resolves the registered resolver for a known asset_type', () => {
    const workout = makeResolver('workout_plan', ['workout_program']);
    const meal = makeResolver('meal_plan');
    const reg = new AssignableAssetResolverRegistry([workout, meal]);
    expect(reg.resolve('workout_plan')).toBe(workout);
    expect(reg.resolve('workout_program')).toBe(workout);
    expect(reg.resolve('meal_plan')).toBe(meal);
  });

  it('throws UnknownAssignableAssetTypeError for an unregistered type', () => {
    const reg = new AssignableAssetResolverRegistry([
      makeResolver('meal_plan'),
    ]);
    expect(() => reg.resolve('not_a_real_type')).toThrow(
      UnknownAssignableAssetTypeError,
    );
    try {
      reg.resolve('not_a_real_type');
    } catch (err) {
      const e = err as UnknownAssignableAssetTypeError;
      expect(e.code).toBe('ASSIGNABLE_ASSET_RESOLVER_UNKNOWN_TYPE');
      expect(e.assetType).toBe('not_a_real_type');
    }
  });

  it('throws on empty / falsy asset_type input', () => {
    const reg = new AssignableAssetResolverRegistry([
      makeResolver('meal_plan'),
    ]);
    expect(() => reg.resolve('')).toThrow(UnknownAssignableAssetTypeError);
    // @ts-expect-error null is not a string at the type level but the runtime
    // path must still throw rather than return undefined.
    expect(() => reg.resolve(null)).toThrow(UnknownAssignableAssetTypeError);
  });

  it('accepts a single instance (ergonomic DI) and resolves through it', () => {
    const single = makeResolver('auto_message');
    const reg = new AssignableAssetResolverRegistry(single);
    expect(reg.resolve('auto_message')).toBe(single);
  });

  it('survives construction with no resolvers (legacy DI path)', () => {
    const reg = new AssignableAssetResolverRegistry();
    expect(reg.list()).toEqual([]);
    expect(() => reg.resolve('meal_plan')).toThrow(
      UnknownAssignableAssetTypeError,
    );
  });

  it('falls back to the FIRST registration on duplicate asset_types', () => {
    const first = makeResolver('meal_plan');
    const second = makeResolver('meal_plan');
    const reg = new AssignableAssetResolverRegistry([first, second]);
    expect(reg.resolve('meal_plan')).toBe(first);
  });

  it('materialise() delegates to the resolver matched by canHandle', async () => {
    const workout = makeResolver('workout_plan', ['workout_program']);
    const reg = new AssignableAssetResolverRegistry([workout]);
    const result = await reg.materialise('workout_program', {
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'plan1',
    });
    expect(result.materialisedRef).toBe('ref:workout_plan');
    expect(workout.materialise).toHaveBeenCalledTimes(1);
    expect(workout.materialise).toHaveBeenCalledWith({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'plan1',
    });
  });

  it('exports a stable injection token symbol', () => {
    // The symbol is used by AssignableAssetResolversModule to bind multi-
    // providers. A refactor that swaps its identity would silently break
    // wiring — anchor it here.
    expect(typeof ASSIGNABLE_ASSET_RESOLVERS).toBe('symbol');
  });
});
