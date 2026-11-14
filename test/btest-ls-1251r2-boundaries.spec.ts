/** LS-1251R2 independent, review-only boundary evidence. Never merge this branch. */
import { randomUUID } from 'crypto';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { ls1197Database } from './ls-1197-live-fixture';

jest.setTimeout(600_000);

describe('LS-1251R2 independent DM boundaries', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  const ids = { K: randomUUID(), L: randomUUID(), X: randomUUID(), C: randomUUID(), U: randomUUID(), P: randomUUID() };
  let workspaceId: string;
  let packageId: string;
  const kept = async (clientId: string): Promise<boolean> => {
    const rows = await db.prisma.$queryRaw<Array<{ kept: boolean }>>`
      SELECT app.community_dm_former_client(${workspaceId}::uuid, ${ids.K}, ${clientId}) AS kept`;
    return rows[0].kept;
  };

  beforeAll(async () => {
    db = await ls1197Database();
    for (const key of ['K', 'L', 'X', 'C', 'U', 'P'] as const) {
      const role = ['K', 'L', 'C'].includes(key) ? 'coach' : 'student';
      await db.prisma.user.create({ data: {
        id: ids[key], supabase_id: randomUUID(), email: `review-${ids[key]}`,
        name: 'Review person', role, coach_id: ['X', 'P'].includes(key) ? ids.L : null,
      } });
    }
    const workspace = await db.prisma.communityWorkspace.create({ data: {
      coach_id: ids.K, name: 'Review workspace', slug: `review-${randomUUID()}`,
    } });
    workspaceId = workspace.id;
    const ordinary = await db.prisma.communityCohort.create({ data: {
      workspace_id: workspaceId, name: 'Review members', visibility: 'members',
    } });
    const paid = await db.prisma.communityCohort.create({ data: {
      workspace_id: workspaceId, name: 'Review package', visibility: 'package',
    } });
    for (const key of ['X', 'C', 'U', 'P'] as const) {
      await db.prisma.communityMembership.create({ data: {
        workspace_id: workspaceId, cohort_id: key === 'P' ? paid.id : ordinary.id, user_id: ids[key],
      } });
      await db.prisma.communityMessage.create({ data: {
        workspace_id: workspaceId, scope: 'dm', sender_id: ids.K, recipient_user_id: ids[key],
        dm_key: CommunityDmsRepository.dmKey(workspaceId, ids.K, ids[key]), body: 'Review message',
      } });
    }
    const offer = await db.prisma.coachPackage.create({ data: {
      coach_id: ids.K, name: 'Review offer', amount_cents: 1999,
    } });
    packageId = offer.id;
    await db.prisma.communityCohortPackage.create({ data: { cohort_id: paid.id, package_id: packageId } });
  });

  afterAll(async () => db?.stop());

  it('a student with no current coach keeps the thread; an otherwise identical coach-role user does not', async () => {
    expect({ coachless: await kept(ids.U), coachRole: await kept(ids.C), movedStudent: await kept(ids.X) })
      .toEqual({ coachless: true, coachRole: false, movedStudent: true });
  });

  it('package membership alone is refused; a live linked purchase opens it and revoked entitlement closes it', async () => {
    expect(await kept(ids.P)).toBe(false);
    const purchase = await db.prisma.clientPurchase.create({ data: {
      client_user_id: ids.P, coach_user_id: ids.K, package_id: packageId, amount_cents: 1999,
      stripe_checkout_session_id: `review-${randomUUID()}`, idempotency_key: randomUUID(),
      status: 'paid', entitlement_active: true, access_expires_at: new Date(Date.now() + 86_400_000),
    } });
    expect(await kept(ids.P)).toBe(true);
    await db.prisma.clientPurchase.update({ where: { id: purchase.id }, data: { entitlement_active: false } });
    expect(await kept(ids.P)).toBe(false);
  });

  it('C1 actual behavior: the former client gets workspace-coach 403; the coach can block and unblock the former client', async () => {
    const safety = new CommunitySafetyService(db.db);
    await expect(safety.block({ id: ids.X }, ids.K)).rejects.toMatchObject({
      status: 403, response: { code: 'community.block.workspace_coach' },
    });
    await expect(safety.block({ id: ids.K }, ids.X)).resolves.toEqual({ blocked_user_id: ids.X, blocked: true });
    await expect(safety.assertDmAllowed(ids.X, ids.K)).rejects.toMatchObject({
      status: 403, response: { code: 'community.dm.blocked_by_them' },
    });
    await safety.unblock({ id: ids.K }, ids.X);
    await expect(safety.assertDmAllowed(ids.X, ids.K)).resolves.toBeUndefined();
  });
});
