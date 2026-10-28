/**
 * B-LONOTIFY3-1 / B-LSNOTIFY3-3 (FR-NOTIFY4, agent 180): the inbox's block
 * rule (src/notifications/inbox-block-rule.ts) is wired the way production
 * runs it, and asks nothing more when the reader is in no block. What it hides
 * and restores on real rows: test/rls/churn-nudge-inbox-rls.spec.ts
 * (Postgres) and test/churn-nudge-inbox-contract.spec.ts.
 */
import 'reflect-metadata';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationsService } from '../src/notifications/notifications.service';
import { InboxBlockRule } from '../src/notifications/inbox-block-rule';
import { stub } from './utils/trial-fakes';

type ServiceArgs = ConstructorParameters<typeof NotificationsService>;
type RuleDb = ConstructorParameters<typeof InboxBlockRule>[0];

describe('B-LONOTIFY3-1: the inbox block rule', () => {
  it('is provided by NotificationsModule and injected into NotificationsService, so production applies it', () => {
    expect(Reflect.getMetadata('providers', NotificationsModule)).toContain(InboxBlockRule);
    const params: unknown[] = Reflect.getMetadata('design:paramtypes', NotificationsService) ?? [];
    expect(params).toContain(InboxBlockRule);
  });

  it('a production boot without it fails, like a boot without push delivery', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const db = stub<ServiceArgs[0]>({});
      const delivery = stub<ServiceArgs[3]>({});
      const without = new NotificationsService(db, undefined, undefined, delivery);
      expect(() => without.onModuleInit()).toThrow('started without InboxBlockRule');
      const wired = new NotificationsService(db, undefined, undefined, delivery, new InboxBlockRule(stub<RuleDb>({})));
      expect(() => wired.onModuleInit()).not.toThrow();
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('a reader in no block: one block read, no other query, no extra condition', async () => {
    const userBlock = { findMany: jest.fn(async () => []) };
    const notification = { findMany: jest.fn(async () => []) };
    const rule = new InboxBlockRule(stub<RuleDb>({ userBlock, notification }));
    await expect(rule.where('u1')).resolves.toEqual([]);
    expect(userBlock.findMany).toHaveBeenCalledTimes(1);
    expect(notification.findMany).not.toHaveBeenCalled();
  });

  it('in a block either way: rows named in their payload leave by id, message notices by their chat link', async () => {
    const userBlock = {
      findMany: jest.fn(async () => [
        { blocker_id: 'u1', blocked_id: 'k1' },
        { blocker_id: 'k2', blocked_id: 'u1' },
      ]),
    };
    const notification = { findMany: jest.fn(async () => [{ id: 'n1' }, { id: 'n2' }]) };
    const rule = new InboxBlockRule(stub<RuleDb>({ userBlock, notification }));
    const where = await rule.where('u1');
    expect(notification.findMany).toHaveBeenCalledWith({
      where: {
        user_id: 'u1',
        OR: [
          { kind: 'coach_nudge', payload: { path: ['coach_id'], equals: 'k1' } },
          { payload: { path: ['approvedByCoachId'], equals: 'k1' } },
          { kind: 'coach_nudge', payload: { path: ['coach_id'], equals: 'k2' } },
          { payload: { path: ['approvedByCoachId'], equals: 'k2' } },
        ],
      },
      select: { id: true },
    });
    expect(where).toEqual([
      {
        OR: [
          { deep_link: null },
          {
            deep_link: { notIn: ['tgp://messages/k1', 'tgp://messages/k2'] },
            NOT: [
              { deep_link: { startsWith: 'tgp://messages/k1/' } },
              { deep_link: { startsWith: 'tgp://messages/k2/' } },
            ],
          },
        ],
      },
      { id: { notIn: ['n1', 'n2'] } },
    ]);
  });
});
