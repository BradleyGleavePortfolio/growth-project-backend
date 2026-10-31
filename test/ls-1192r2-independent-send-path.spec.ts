import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { Expo } from 'expo-server-sdk';
import { NotificationsService, PushRoute } from '../src/notifications/notifications.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import {
  PushDeliveryService,
  USER_WINDOW_MAX,
  USER_WINDOW_MS,
} from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const NIGHT = new Date('2026-10-06T06:00:00Z');
const MORNING = new Date('2026-10-06T15:00:00Z');
const CLIENT = 'ls1192r2-reader';

afterEach(() => jest.restoreAllMocks());

function rig(at = NIGHT, prefs: Record<string, unknown> = {
  timezone: 'America/Los_Angeles',
  timezone_updated_at: new Date('2026-01-01T00:00:00Z'),
}) {
  const clock = { at: new Date(at.getTime()) };
  const world = pushOutboxWorld({ now: () => clock.at, prefs: { [CLIENT]: prefs } });
  world.tokens[CLIENT] = 'review-device-label';
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync')
    .mockResolvedValue([{ status: 'ok', id: 'unused-direct-receipt' }]);
  const sent = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, index) => ({ status: 'ok', id: `review-receipt-${index}` })),
  );
  const transport = stub<ExpoPushClient>({
    send: sent,
    getReceipts: jest.fn(async () => ({})),
  });
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(world.db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(world.db),
    undefined,
    undefined,
    delivery,
  );
  const messages = () => sent.mock.calls.flatMap(([batch]) => stub<Array<Record<string, unknown>>>(batch));
  return { clock, world, direct, sent, delivery, notifications, messages };
}

function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

it('LS-1192R2 independent AST scan: no SDK send or push endpoint outside the canonical client', () => {
  const root = join(__dirname, '..', 'src');
  const offending: string[] = [];
  for (const path of productionFiles(root)) {
    const name = relative(root, path).replace(/\\/g, '/');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(sendPushNotificationsAsync|sendMulticast|sendEachForMulticast|sendToDevice)$/.test(node.expression.name.text)
      ) {
        offending.push(`${name}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}:SDK`);
      }
      if (
        ts.isStringLiteralLike(node) &&
        /(?:exp\.host|expo\.dev).*\/push\/send|fcm\.googleapis\.com|api\.push\.apple\.com/.test(node.text) &&
        name !== 'notifications/push/expo-push-client.ts'
      ) {
        offending.push(`${name}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}:endpoint`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(offending).toEqual([]);
});

const routes: Array<[string, PushRoute]> = [
  ['client payment', { kind: 'dunning_blocker' }],
  ['payout adjustment', { kind: 'coach_alert', passesMuteAll: true }],
  ['trial notice', { kind: 'trial_ending' }],
  ['churn message', { kind: 'coach_nudge', muteAllOnly: true }],
  ['scout completion', { kind: 'import.complete', muteAllOnly: true }],
  ['community DM', { kind: 'community_dm_received', muteAllOnly: true }],
  ['community post reply', { kind: 'community_post_replied', muteAllOnly: true }],
  ['community event', { kind: 'community_event_starting_soon', muteAllOnly: true }],
  ['community milestone', { kind: 'community_challenge_milestone', muteAllOnly: true }],
  ['community moderation', { kind: 'community_moderation_action_against_me', muteAllOnly: true }],
  ['community membership', { kind: 'community_membership_changed', muteAllOnly: true }],
  ['nudge', { kind: 'nudge_inactive' }],
  ['coach brief', { kind: 'coach_brief', muteAllOnly: true }],
];

it.each(routes)('LS-1192R2 %s: sender words and tap survive overnight, replay does not duplicate', async (_name, route) => {
  const r = rig();
  const title = 'Review title';
  const body = 'Review body '.repeat(24);
  const data = { actionScreen: 'NotificationCenter', event: 'review-event' };
  const identified = { ...route, dedupeKey: `ls1192r2:${route.kind}` };
  expect(await r.notifications.pushToUser(CLIENT, title, body, data, undefined, identified))
    .toMatchObject({ delivered: true, detail: 'deferred' });
  expect(await r.notifications.pushToUser(CLIENT, title, body, data, undefined, identified))
    .toMatchObject({ delivered: true, detail: 'duplicate' });
  await r.delivery.drain();
  expect(r.direct).not.toHaveBeenCalled();
  expect(r.sent).not.toHaveBeenCalled();
  expect(r.world.rows).toHaveLength(1);
  expect(r.world.rows[0]).toMatchObject({ status: 'pending', not_before: MORNING, attempts: 0 });
  r.clock.at = MORNING;
  await r.delivery.drain();
  await r.delivery.drain();
  expect(r.messages()).toEqual([expect.objectContaining({ title, body, data, sound: 'default' })]);
  expect(r.world.rows[0].status).toBe('sent');
});

it('LS-1192R2 pushToCoach shares the queue and retains the alert tap payload', async () => {
  const r = rig();
  expect(await r.notifications.pushToCoach(CLIENT, {
    alertId: 'review-alert',
    alertType: 'review_type',
    severity: 'warning',
    message: 'Review alert body',
  })).toBe(true);
  expect(r.sent).not.toHaveBeenCalled();
  expect(r.world.rows[0].not_before).toEqual(MORNING);
  r.clock.at = MORNING;
  await r.delivery.drain();
  expect(r.messages()).toEqual([expect.objectContaining({
    title: 'Review alert body',
    body: 'review_type',
    data: { alertId: 'review-alert', alertType: 'review_type', category: 'SYSTEM' },
  })]);
});

it('LS-1192R2 no known zone: a schema-default preference zone is not invented as recipient provenance', async () => {
  const r = rig(NIGHT, { timezone: 'America/Los_Angeles', timezone_updated_at: null });
  await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
    kind: 'import.complete', muteAllOnly: true, dedupeKey: 'unknown-zone',
  });
  expect(r.world.rows[0]).toMatchObject({ time_zone: null, not_before: NIGHT });
  await r.delivery.drain();
  expect(r.sent).toHaveBeenCalledTimes(1);
});

it('LS-1192R2 changed recipient zone across midnight is evaluated again, not dropped', async () => {
  const r = rig();
  await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
    kind: 'dunning_blocker', dedupeKey: 'travel-zone',
  });
  // The original 08:00 LA is now midnight in Tokyo on the next local date.
  r.world.prefs[CLIENT].timezone = 'Asia/Tokyo';
  r.clock.at = MORNING;
  await r.delivery.drain();
  expect(r.sent).not.toHaveBeenCalled();
  const tokyoMorning = new Date('2026-10-06T23:00:00Z');
  expect(r.world.rows[0]).toMatchObject({ status: 'pending', not_before: tokyoMorning, attempts: 0 });
  r.clock.at = tokyoMorning;
  await r.delivery.drain();
  expect(r.sent).toHaveBeenCalledTimes(1);
});

it('LS-1192R2 the burst cap retains every distinct event and refunds only deferral attempts', async () => {
  const r = rig(MORNING);
  for (let index = 0; index < USER_WINDOW_MAX + 3; index += 1) {
    await r.notifications.pushToUser(CLIENT, 't', `event ${index}`, { index }, undefined, {
      kind: 'coach_nudge', muteAllOnly: true, dedupeKey: `burst-${index}`,
    });
  }
  await r.delivery.drain();
  expect(r.messages()).toHaveLength(USER_WINDOW_MAX);
  expect(r.world.rows.filter((row) => row.status === 'pending')).toHaveLength(3);
  expect(r.world.rows.filter((row) => row.status === 'dropped')).toHaveLength(0);
  r.clock.at = new Date(MORNING.getTime() + USER_WINDOW_MS);
  await r.delivery.drain();
  expect(r.messages()).toHaveLength(USER_WINDOW_MAX + 3);
  expect(r.world.rows.every((row) => row.status === 'sent' && row.attempts === 1)).toBe(true);
});

it('LS-1192R2 a held push uses the replacement token; a cleared token stops its peer', async () => {
  const r = rig();
  await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
    kind: 'coach_nudge', muteAllOnly: true, dedupeKey: 'replacement-device',
  });
  r.world.tokens[CLIENT] = 'replacement-device-label';
  r.clock.at = MORNING;
  await r.delivery.drain();
  expect(r.messages()).toEqual([expect.objectContaining({ to: 'replacement-device-label' })]);
  await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
    kind: 'coach_nudge', muteAllOnly: true, dedupeKey: 'cleared-device',
  });
  r.world.tokens[CLIENT] = null;
  await r.delivery.drain();
  expect(r.messages()).toHaveLength(1);
  expect(r.world.rows[1]).toMatchObject({ status: 'dropped', result_code: 'no-token' });
});

it('LS-1192R2 the morning workout retains its 07:00 chosen time and audible default channel', async () => {
  const r = rig(new Date('2026-10-06T14:00:00Z'));
  await r.notifications.pushToUser(CLIENT, 'Workout today', 'Review reminder', {}, undefined, {
    kind: 'workout_reminder', dedupeKey: 'morning-reminder',
  });
  await r.delivery.drain();
  expect(r.messages()).toEqual([expect.objectContaining({ channelId: 'default', sound: 'default' })]);
});

it.each(routes)('LS-1192R2 %s: the current mute is applied at delivery, with only the money passes exempt', async (_name, route) => {
  const r = rig();
  await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
    ...route, dedupeKey: 'mute-after-queue',
  });
  r.world.prefs[CLIENT].muted = true;
  r.clock.at = MORNING;
  await r.delivery.drain();
  const money = ['dunning_blocker', 'trial_ending'].includes(route.kind) || route.passesMuteAll;
  expect(r.messages()).toHaveLength(money ? 1 : 0);
  expect(r.world.rows[0].status).toBe(money ? 'sent' : 'dropped');
});

it.each(['roman_crisis_reply', 'roman_urgent_reply', 'community_photo_safety'])(
  'LS-1192R2 %s safety bypasses both nighttime and a full burst window while muted',
  async (alertType) => {
  const r = rig(MORNING);
  for (let index = 0; index < USER_WINDOW_MAX; index += 1) {
    await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, {
      kind: 'coach_nudge', muteAllOnly: true, dedupeKey: `ordinary-${index}`,
    });
  }
  await r.delivery.drain();
  // Move to 23:00 on that day. The cap assertion below is also exercised by
  // explicitly marking existing sends as occurring immediately beforehand.
  r.clock.at = new Date('2026-10-07T06:00:00Z');
  for (const row of r.world.rows) row.sent_at = new Date(r.clock.at.getTime() - 1000);
  r.world.prefs[CLIENT].muted = true;
  const emitter = new CoachAlertEmitter(r.notifications);
  await emitter.emit({
    coachId: CLIENT,
    alertId: 'review-crisis',
    alertType,
    message: 'This text must not reach the lock screen',
    severity: 'critical',
    clientUserId: 'review-other-client',
  }, { inapp: false });
  await r.delivery.drain();
  expect(r.messages()).toHaveLength(USER_WINDOW_MAX + 1);
  expect(r.world.rows[r.world.rows.length - 1]).toMatchObject({ urgent: true, status: 'sent' });
  const messages = r.messages();
  expect(messages[messages.length - 1].body).not.toContain('This text');
});
