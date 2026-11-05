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
    // The reader is a coach (no coach of their own).
    const user = { findUnique: jest.fn(async () => ({ coach_id: null })) };
    const rule = new InboxBlockRule(stub<RuleDb>({ userBlock, notification, user }));
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

  it('(failed before) a client in a block with their coach: the message notices for their own chat leave too', async () => {
    // A client's message notices link their own chat (the chat id is the
    // client: messaging.service.ts notifyNewMessage, broadcast-dispatcher
    // threadId: client.id), so "New message from <coach>" names the coach.
    const userBlock = { findMany: jest.fn(async () => [{ blocker_id: 'c1', blocked_id: 'k1' }]) };
    const notification = { findMany: jest.fn(async () => []) };
    const user = { findUnique: jest.fn(async () => ({ coach_id: 'k1' })) };
    const rule = new InboxBlockRule(stub<RuleDb>({ userBlock, notification, user }));
    const where = await rule.where('c1');
    expect(user.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' }, select: { coach_id: true } });
    expect(where).toEqual([
      {
        OR: [
          { deep_link: null },
          {
            deep_link: { notIn: ['tgp://messages/k1', 'tgp://messages/c1'] },
            NOT: [
              { deep_link: { startsWith: 'tgp://messages/k1/' } },
              { deep_link: { startsWith: 'tgp://messages/c1/' } },
            ],
          },
        ],
      },
    ]);
  });

  it('a client in a block with someone else (not their coach): their own chat stays', async () => {
    const userBlock = { findMany: jest.fn(async () => [{ blocker_id: 'x9', blocked_id: 'c1' }]) };
    const notification = { findMany: jest.fn(async () => []) };
    const user = { findUnique: jest.fn(async () => ({ coach_id: 'k1' })) };
    const rule = new InboxBlockRule(stub<RuleDb>({ userBlock, notification, user }));
    const [links] = await rule.where('c1');
    expect(links).toEqual({
      OR: [
        { deep_link: null },
        { deep_link: { notIn: ['tgp://messages/x9'] }, NOT: [{ deep_link: { startsWith: 'tgp://messages/x9/' } }] },
      ],
    });
  });
});
