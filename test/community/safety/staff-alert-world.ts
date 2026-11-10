/**
 * FIX-1232R1 (agent 203): the staff alert's own world, as the table spec builds it
 * (community-crisis-text.table.spec.ts): the real CommunitySafetyService.alertStaff, NotificationsService.sendPush and
 * PushDeliveryService.enqueue over test/utils/push-outbox-fake.ts, which models the (user_id, dedupe_key) unique key.
 * The inbox is the recorded createNotification write.
 */
import type { ModuleRef } from '@nestjs/core';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';

export const STAFF_A = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
export const STAFF_B = '0b4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b61';
export const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const TOKEN = 'ExponentPushToken[crisisstaffworld0001]';
const ZONE = 'America/New_York';
const DAY = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York

type Row = Record<string, unknown>;
const stub = <T>(v: unknown): T => v as T;

export function staffAlertWorld(opts: { staff?: string[]; at?: Date; prefs?: Record<string, unknown> } = {}) {
  const staff = opts.staff ?? [STAFF_A, STAFF_B];
  const clock = { at: opts.at ?? DAY };
  const out = pushOutboxWorld({ now: () => clock.at, tokens: Object.fromEntries(staff.map((s) => [s, TOKEN])) });
  for (const s of staff) out.prefs[s] = { muted: false, timezone: ZONE, timezone_updated_at: DAY, ...opts.prefs };
  const inbox: Row[] = [];
  const db = {
    ...out.db,
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: Row }) => {
        inbox.push(a.data);
        return { id: `n-${inbox.length}`, ...a.data };
      }),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery: PushDeliveryService = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), {
    send: jest.fn(async (m: unknown[]) => m.map(() => ({ status: 'ok' as const, id: 't' }))),
    getReceipts: jest.fn(async () => ({})),
  });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery);
  const prisma = {
    user: {
      findMany: jest.fn(async (a: { where: { id: { not: string } } }) =>
        staff.filter((id) => id !== a.where.id.not).map((id) => ({ id })),
      ),
    },
  };
  const safety = new CommunitySafetyService(
    stub(prisma),
    stub<ModuleRef>({ get: (t: unknown) => (t === NotificationsService ? notifications : undefined) }),
  );
  return { clock, out, inbox, safety, notifications, delivery };
}
