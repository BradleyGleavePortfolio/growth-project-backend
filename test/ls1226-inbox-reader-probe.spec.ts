import { randomUUID } from 'crypto';
import { NotificationsService } from '../src/notifications/notifications.service';
import { InboxBlockRule } from '../src/notifications/inbox-block-rule';
import { stub } from './utils/trial-fakes';

// LS-1226: real inbox service/block rule, storage fake for known-valid
// coach_nudge rows. Real SQL/RLS remains covered by the required live checks.
describe('LS-1226 inbox reader beyond page one', () => {
  it('reads all 101 nudge rows with UUID cursors; the badge and read marks remain scoped', async () => {
    const client = randomUUID();
    const foreign = randomUUID();
    const coach = randomUUID();
    const body = 'a'.repeat(500);
    const rows = Array.from({ length: 104 }, (_, i) => ({
      id: randomUUID(),
      user_id: i < 101 ? client : foreign,
      kind: 'coach_nudge',
      channel: 'inapp',
      deep_link: null,
      body,
      payload: { title: `Nudge ${i}`, coach_id: coach, nudge_id: randomUUID() },
      inbox_hidden: false,
      created_at: new Date(Date.UTC(2026, 9, 1, 12, 0, i)),
      read_at: null as Date | null,
    }));
    type Row = (typeof rows)[number];
    type Where = { user_id?: string; id?: string; read_at?: null; created_at?: { lt: Date } };
    const matches = (row: Row, where: Where) =>
      (!where.user_id || row.user_id === where.user_id) &&
      (!where.id || row.id === where.id) &&
      (!('read_at' in where) || row.read_at === where.read_at) &&
      (!where.created_at || row.created_at < where.created_at.lt);
    const notification = {
      findMany: jest.fn(async (a: { where: Where; take: number }) =>
        rows.filter((r) => matches(r, a.where))
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, a.take)),
      count: jest.fn(async (a: { where: Where }) => rows.filter((r) => matches(r, a.where)).length),
      findUnique: jest.fn(async (a: { where: { id: string } }) =>
        rows.find((r) => r.id === a.where.id) ?? null),
      findFirst: jest.fn(async (a: { where: Where }) => rows.find((r) => matches(r, a.where)) ?? null),
      update: jest.fn(async (a: { where: Where; data: { read_at: Date } }) => {
        const row = rows.find((r) => matches(r, a.where))!;
        Object.assign(row, a.data);
        return row;
      }),
      updateMany: jest.fn(async (a: { where: Where; data: { read_at: Date } }) => {
        const selected = rows.filter((r) => matches(r, a.where));
        selected.forEach((r) => Object.assign(r, a.data));
        return { count: selected.length };
      }),
    };
    const db = {
      notification,
      user: { findUnique: jest.fn(async () => ({ role: 'student', coach_id: coach })) },
      userBlock: { findMany: jest.fn(async () => []) },
    };
    const service = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
      undefined, undefined, undefined,
      new InboxBlockRule(stub<ConstructorParameters<typeof InboxBlockRule>[0]>(db)),
    );
    const read: string[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const page = await service.listNotifications(client, { limit: 25, cursor });
      expect(page.unreadCount).toBe(101);
      expect(page.items.every((r) => r.user_id === client && r.body === body)).toBe(true);
      read.push(...page.items.map((r) => r.id));
      if (pageNo < 4) {
        expect(page.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
        cursor = page.nextCursor!;
      } else {
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeNull();
      }
    }
    expect(new Set(read).size).toBe(101);
    expect(read).toHaveLength(101);
    expect(await service.getUnreadCount(foreign)).toBe(3);
    await expect(service.markRead(read[0], foreign)).rejects.toThrow('Notification not found');
    await service.markRead(read[0], client);
    expect(await service.getUnreadCount(client)).toBe(100);
    expect(await service.markAllRead(client)).toEqual({ updated: 100 });
    expect(await service.getUnreadCount(client)).toBe(0);
    expect(await service.getUnreadCount(foreign)).toBe(3);
  });
});
