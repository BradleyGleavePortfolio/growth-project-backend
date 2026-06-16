/**
 * F2 regimes role-gating pin (R80 lesson).
 *
 * The repo-wide test/roles-enforced.spec.ts already PASSES any controller that
 * carries a class-level @Roles(...) (it `continue`s on class-level decoration,
 * so no LEGACY_GUARD_ALLOWLIST entry is required for the two new F2
 * controllers). This focused pin makes that guarantee EXPLICIT and local: it
 * asserts both new coach controllers carry class-level @Roles('coach') exactly,
 * so a future refactor that drops the decorator fails this spec immediately
 * rather than silently widening the surface.
 */

import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RegimesController } from '../regimes.controller';
import { RefundDecisionsController } from '../refund-decisions.controller';

describe('F2 regimes — class-level @Roles("coach") pin', () => {
  it('RegimesController is class-level @Roles("coach")', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, RegimesController);
    expect(roles).toEqual(['coach']);
  });

  it('RefundDecisionsController is class-level @Roles("coach")', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, RefundDecisionsController);
    expect(roles).toEqual(['coach']);
  });
});
