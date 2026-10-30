import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import { EmailService } from '../src/email/email.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';
import { PrismaService } from '../src/prisma.service';
import {
  COACH_A, addUser, buildAttachDb, fakeAnalytics, fakeAudit, fakeEmail, user,
} from './support/attach-fixture';

// Exercise the public attach writer, not just the helper or its mock call.
// Its fallback package is created BEFORE the attach/grant transaction.
async function fixture(name: string) {
  const db = buildAttachDb();
  db.model('coachPackage', [['id']], () => ({
    archived_at: null, requires_contract: false, contract_template_id: null,
    interval_count: 1, duration_periods: null, created_at: new Date(),
  }));
  db.model('clientPurchase', [['id'], ['idempotency_key']]);
  Object.assign(user(db, COACH_A), { name });
  addUser(db, { id: 'new-client' });
  const module = await Test.createTestingModule({
    providers: [
      InviteCodesService, InviteGrantService,
      { provide: PrismaService, useValue: db },
      { provide: AnalyticsService, useValue: fakeAnalytics() },
      { provide: AuditService, useValue: fakeAudit() },
      { provide: EmailService, useValue: fakeEmail() },
    ],
  }).compile();
  return { db, invites: module.get(InviteCodesService) };
}

describe('LS-1TO1R2: every publisher obeys the named coaching rule', () => {
  const previous = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = previous;
  });

  it('ordinary coach control: first join publishes Getting started and grants it', async () => {
    const { db, invites } = await fixture('Coach A');
    await expect(invites.attachUserToCoachByCode('new-client', 'GP-AAAAAA'))
      .resolves.toMatchObject({ coach_id: COACH_A, grant: { status: 'created' } });
    expect(db.state.coachPackage).toEqual([
      expect.objectContaining({ name: 'Getting started', is_active: true, published_at: expect.any(Date) }),
    ]);
    expect(db.state.clientPurchase).toHaveLength(1);
  });

  it('a nameless coach code must not publish a fallback package when its grant is refused', async () => {
    const { db, invites } = await fixture('');
    await expect(invites.attachUserToCoachByCode('new-client', 'GP-AAAAAA'))
      .rejects.toMatchObject({ response: { error: 'PACKAGE_NOT_FOUND' } });
    expect(user(db, 'new-client').coach_id).toBeNull();
    expect(db.state.clientPurchase).toHaveLength(0);
    // The sale gate alone is insufficient: no ACTIVE, PUBLISHED row may survive.
    expect(db.state.coachPackage.filter((pkg) => pkg.is_active && pkg.published_at))
      .toHaveLength(0);
  });
});
