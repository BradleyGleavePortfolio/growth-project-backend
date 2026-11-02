/**
 * LO-1186R3 B1 (b#1186 review round 3, the Opus T3 lens): a relay held under a getter, a method's return, a Map
 * field or a typed array is not seen by the KT-4 sender scan, so a new sender in that form needs no registry row.
 *
 * The forms hold the relay under a type that names it (unlike the `any` or the "name and type that say nothing"
 * the scan header lists as not seen). The repo already holds a dependency under a getter
 * (src/wearables/connectors/strava/index.ts:57 `private get impl(): StravaConnector`).
 *
 * The effect: a new CoachAlertEmitter caller with `money: true` held this way pushes a muted coach through Mute all
 * (the real emitter, NotificationsService and push outbox, below), and no row, no Mute all case and no finding says
 * so. The cases red today assert what the scan should report: "not in the sender registry", naming the file:line.
 */
import * as path from 'path';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService, type ExpoPushClient } from '../src/notifications/push/push-delivery.service';
import { unregistered } from './utils/notify-sender-checks';
import { scanSenders, scanText } from './utils/notify-sender-scan';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const REPO = path.resolve(__dirname, '..');
const HITS = scanSenders(REPO);
const F = 'src/coach/lo-r3-streak-alert.service.ts';
const IMPORT_ALERT = `import { CoachAlertEmitter } from '../notifications/emitters/coach-alert.emitter';\n`;
const ALERT = `{ coachId: 'c', alertId: 'a', alertType: 'kt4_streak', message: 'm', severity: 'warning', money: true }`;

/** The real tree, plus one new file: what unregistered() reports. */
const findings = (text: string): string[] => unregistered([...HITS, ...scanText(F, text, path.join(REPO, F))]);
const lineOf = (text: string, at: string): number => text.split('\n').findIndex((l) => l.includes(at)) + 1;

const FORMS: Array<[string, string, string]> = [
  [
    'an emitter held under a getter is red naming the file',
    `${IMPORT_ALERT}export class StreakAlerts {
  constructor(private readonly made: CoachAlertEmitter) {}
  private get alerts(): CoachAlertEmitter {
    return this.made;
  }
  async notify(): Promise<void> {
    await this.alerts.emit(${ALERT});
  }
}
`,
    'this.alerts.emit(',
  ],
  [
    'an emitter returned by a method is red naming the file',
    `${IMPORT_ALERT}export class StreakAlerts {
  constructor(private readonly made: CoachAlertEmitter) {}
  private alerts(): CoachAlertEmitter {
    return this.made;
  }
  async notify(): Promise<void> {
    await this.alerts().emit(${ALERT});
  }
}
`,
    'this.alerts().emit(',
  ],
  [
    'an emitter held in a Map field is red naming the file',
    `${IMPORT_ALERT}export class StreakAlerts {
  private readonly relays = new Map<string, CoachAlertEmitter>();
  async notify(): Promise<void> {
    await this.relays.get('coach')?.emit(${ALERT});
  }
}
`,
    ".get('coach')?.emit(",
  ],
  [
    'an emitter taken from a typed array by for-of is red naming the file',
    `${IMPORT_ALERT}export class StreakAlerts {
  constructor(private readonly list: CoachAlertEmitter[]) {}
  async notify(): Promise<void> {
    for (const each of this.list) await each.emit(${ALERT});
  }
}
`,
    'await each.emit(',
  ],
  [
    'the community relay held under a getter is red naming the file',
    `import { CommunityNotificationsService } from '../community/notifications/community-notifications.service';
export class StreakAlerts {
  constructor(private readonly made: CommunityNotificationsService) {}
  get community(): CommunityNotificationsService {
    return this.made;
  }
  async notify(): Promise<void> {
    await this.community.sendCommunityPush({ recipientId: 'u', kind: 'community_dm_received', targetType: 'dm', targetId: 'd' });
  }
}
`,
    'this.community.sendCommunityPush(',
  ],
];

describe('LO-1186R3 B1: a relay held under a getter, a method, a Map or a typed array', () => {
  it.each(FORMS)('%s', (_name, text, at) => {
    const line = lineOf(text, at);
    expect(line).toBeGreaterThan(0);
    expect(findings(text)).toEqual([expect.stringContaining(`${F}:${line} StreakAlerts.notify [`)]);
  });

  it('control (green today): the same caller with a constructor-held emitter is red naming the file', () => {
    const text = `${IMPORT_ALERT}export class StreakAlerts {
  constructor(private readonly alerts: CoachAlertEmitter) {}
  async notify(): Promise<void> {
    await this.alerts.emit(${ALERT});
  }
}
`;
    expect(findings(text)).toEqual([expect.stringContaining(`${F}:5 StreakAlerts.notify [emitter]`)]);
  });

  it('control (green today): the real tree has no unregistered sender', () => {
    expect(unregistered(HITS)).toEqual([]);
  });
});

describe('LO-1186R3 B1 effect: the caller that no row covers reaches a muted coach', () => {
  const DAY = new Date('2026-06-02T18:00:00Z');
  async function muted(payload: Parameters<CoachAlertEmitter['emit']>[0]): Promise<string> {
    const w = pushOutboxWorld({ now: () => DAY });
    w.prefs['coach-a'] = { timezone: 'America/New_York', timezone_updated_at: DAY, muted: true };
    w.tokens['coach-a'] = 'ExponentPushToken[lo1186r3b1000000001]';
    const db = { ...w.db, notification: { findFirst: jest.fn(async () => null), create: jest.fn(async (a: { data: Record<string, unknown> }) => a.data) } };
    class Clocked extends PushDeliveryService {
      protected now(): Date {
        return new Date(DAY.getTime());
      }
    }
    const client = stub<ExpoPushClient>({ send: jest.fn(async (m: unknown[]) => m.map(() => ({ status: 'ok', id: 't' }))), getReceipts: jest.fn(async () => ({})) });
    const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
    delivery.autoDrain = false;
    const svc = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery);
    await new CoachAlertEmitter(svc).emit(payload, { inapp: false });
    const q = w.rows.filter((r) => r.user_id === 'coach-a');
    return q.some((r) => r.not_before.getTime() <= DAY.getTime()) ? 'sent' : q.length > 0 ? 'held' : 'none';
  }
  it('money: true goes through Mute all (sent)', async () => {
    expect(await muted({ coachId: 'coach-a', alertId: 'a', alertType: 'kt4_streak', message: 'm', severity: 'warning', money: true })).toBe('sent');
  });
  it('control: without money: true, Mute all stops it (none)', async () => {
    expect(await muted({ coachId: 'coach-a', alertId: 'a', alertType: 'kt4_streak', message: 'm', severity: 'warning' })).toBe('none');
  });
});
