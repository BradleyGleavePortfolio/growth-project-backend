import {
  CAPABILITY_MATERIALIZERS,
  CapabilityMaterializerRegistry,
} from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import type { CapabilityMaterializer } from '../src/ai/gateway/materialisers/capability-materialiser.interface';

// PR AI-3 (PRODUCT-1) — registry resolution.
// The registry is the seam between AiApprovalService and individual
// capability materialisers. If resolution is wrong, we either send via the
// wrong handler (data leak / wrong-tenant send) or skip materialisation
// entirely (the original PRODUCT-1 bug). Both branches deserve exhaustive
// unit coverage.

function makeMat(capability: string): CapabilityMaterializer {
  return {
    capability,
    canHandle: jest.fn((c: string) => c === capability),
    materialize: jest.fn(async () => ({ status: 'sent' as const })),
  };
}

describe('CapabilityMaterializerRegistry', () => {
  it('resolves the correct materialiser for a registered capability', () => {
    const a = makeMat('draft.coach_message');
    const b = makeMat('draft.workout_program');
    const reg = new CapabilityMaterializerRegistry([a, b]);
    expect(reg.resolve('draft.coach_message')).toBe(a);
    expect(reg.resolve('draft.workout_program')).toBe(b);
  });

  it('returns null for an unknown capability', () => {
    const reg = new CapabilityMaterializerRegistry([
      makeMat('draft.coach_message'),
    ]);
    expect(reg.resolve('chat.client_self')).toBeNull();
    expect(reg.resolve('totally-unknown')).toBeNull();
  });

  it('returns null for empty / falsy capability strings', () => {
    const reg = new CapabilityMaterializerRegistry([
      makeMat('draft.coach_message'),
    ]);
    expect(reg.resolve('')).toBeNull();
    // @ts-expect-error null is not a string at the type level but a defensive
    // runtime guard must still hold.
    expect(reg.resolve(null)).toBeNull();
  });

  it('accepts a single instance (not just an array) for ergonomic DI', () => {
    const single = makeMat('draft.coach_message');
    const reg = new CapabilityMaterializerRegistry(single);
    expect(reg.resolve('draft.coach_message')).toBe(single);
  });

  it('survives being constructed with no materialisers (legacy path)', () => {
    const reg = new CapabilityMaterializerRegistry();
    expect(reg.resolve('draft.coach_message')).toBeNull();
    expect(reg.list()).toEqual([]);
  });

  it('falls back to the FIRST registration when two materialisers claim the same capability', () => {
    const first = makeMat('draft.coach_message');
    const second = makeMat('draft.coach_message');
    const reg = new CapabilityMaterializerRegistry([first, second]);
    expect(reg.resolve('draft.coach_message')).toBe(first);
  });

  it('exports a stable injection token symbol', () => {
    // The symbol is used by AiGatewayModule to bind multi-providers. A
    // refactor that accidentally swaps the symbol identity would silently
    // break wiring — anchor it here so the regression is loud.
    expect(typeof CAPABILITY_MATERIALIZERS).toBe('symbol');
  });
});
