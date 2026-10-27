/**
 * FX-JOIN unit: the resolver scope check reads through the purchase transaction when one is passed
 * (and exactly as before when none is), and the two resolvers whose delegates check and write on
 * their own connection wait for the drip dispatcher only when the attach is not committed yet.
 * The live proof is test/rls/join-delivery-rls.spec.ts.
 */
import type { Prisma } from '@prisma/client';
import { SubCoachOutOfScopeError } from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';
import { AutoMessageAssetResolver } from '../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { stub } from './utils/trial-fakes';

const tx = stub<Prisma.TransactionClient>({ tag: 'purchase-tx' });

/** committed: what the pooled connection sees; inTx: what the purchase transaction sees. */
function scopeOf(committed: boolean, inTx: boolean, gone = false) {
  const fake = {
    canAccessClient: jest.fn(async (_coach: string, _client: string, db?: unknown) => (db ? inTx : committed)),
    deliversForGoneCoach: jest.fn(async () => gone),
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
  };
  return { fake, scope: new ResolverSubCoachScope(stub<ConstructorParameters<typeof ResolverSubCoachScope>[0]>(fake)) };
}
type Case = [string, boolean, boolean, boolean, boolean];
const input = (withTx: boolean) => ({ coachId: 'k', clientId: 'c', assetId: 'a', ...(withTx ? { tx } : {}) });

describe('ResolverSubCoachScope with the purchase transaction', () => {
  it('without a transaction it reads exactly as before: two arguments, the pooled connection', async () => {
    const { fake, scope } = scopeOf(true, false);
    await expect(scope.resolve('k', 'c')).resolves.toEqual({ tenantCoachId: 'k', actingCoachId: 'k' });
    expect(fake.canAccessClient.mock.calls).toEqual([['k', 'c']]);
  });

  it('with a transaction the check reads there: an attach written in it is seen', async () => {
    const { fake, scope } = scopeOf(false, true);
    await expect(scope.resolve('k', 'c', tx)).resolves.toEqual({ tenantCoachId: 'k', actingCoachId: 'k' });
    expect(fake.canAccessClient.mock.calls).toEqual([['k', 'c', tx]]);
  });

  it('stays as strict: refused in the transaction is refused, gone-coach delivery reads there too', async () => {
    const { fake, scope } = scopeOf(true, false);
    await expect(scope.resolve('k', 'c', tx)).rejects.toBeInstanceOf(SubCoachOutOfScopeError);
    expect(fake.deliversForGoneCoach.mock.calls).toEqual([['k', 'c', tx]]);
    await expect(scopeOf(false, false, true).scope.resolve('k', 'c', tx)).resolves.toMatchObject({ actingCoachId: 'k' });
  });

  it.each<Case>([
    ['no transaction', false, true, false, false],
    ['already attached (committed allows)', true, true, true, false],
    ['attached in this transaction only', true, false, true, true],
    ['outside scope everywhere', true, false, false, false],
  ])('onlyInTx: %s', async (_name, withTx, committed, inTx, expected) => {
    const { scope } = scopeOf(committed, inTx);
    expect(await scope.onlyInTx('k', 'c', withTx ? tx : undefined)).toBe(expected);
  });
});

describe('resolvers whose delegates write on their own connection', () => {
  const messaging = stub<ConstructorParameters<typeof AutoMessageAssetResolver>[0]>({ sendAsCoach: jest.fn() });
  const prisma = stub<ConstructorParameters<typeof AutoMessageAssetResolver>[2]>({});
  const builder = stub<ConstructorParameters<typeof WorkoutAssetResolver>[0]>({ assignPlan: jest.fn() });
  const programs = (master: boolean) =>
    stub<ConstructorParameters<typeof WorkoutAssetResolver>[2]>({ isProgramMaster: jest.fn(async () => master) });

  it.each<Case>([
    ['attached in this transaction', true, false, true, true],
    ['already attached', true, true, true, false],
    ['no transaction (dispatcher)', false, false, true, false],
  ])('welcome message and single workout wait for the dispatcher only when %s', async (_n, withTx, committed, inTx, wait) => {
    const { scope } = scopeOf(committed, inTx);
    expect(await new AutoMessageAssetResolver(messaging, scope, prisma).deferInline(input(withTx))).toBe(wait);
    expect(await new WorkoutAssetResolver(builder, scope, programs(false)).deferInline(input(withTx))).toBe(wait);
  });

  it('a whole program still waits for the dispatcher, attached or not', async () => {
    const { fake, scope } = scopeOf(true, true);
    expect(await new WorkoutAssetResolver(builder, scope, programs(true)).deferInline(input(true))).toBe(true);
    expect(fake.canAccessClient).not.toHaveBeenCalled();
  });
});
