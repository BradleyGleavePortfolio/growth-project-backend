/**
 * KT-4 (KNOWN_TRAPS.md), TRAPTEST-NOTIFY-BE: every device push and every in-app notice goes through the one
 * delivery funnel and honors Mute all, quiet hours (21:00 to 08:00 in the recipient's zone), thread and space
 * mute, block and ban, and its recipient rule.
 *
 * This spec reads every runtime file in src/ (never tests), lists each place that sends a push or writes an
 * in-app notice, and checks that list against the sender registry in test/utils/notify-sender-registry.ts. Then
 * it runs the senders through the real NotificationsService and the real push outbox and checks each one does
 * what its registry row says.
 *
 * WHEN THIS IS RED, read the failure: it names the file, the line and the function. Then do one of these:
 *  1. "not in the sender registry": you added a new way to send (a function that calls sendPush,
 *     createNotification, pushToUser, an emitter in src/notifications/emitters/, sendCommunityPush, or writes a
 *     Notification row). Add a row for it to SENDERS in test/utils/notify-sender-registry.ts: its kinds and its
 *     five rules (Mute all, quiet hours, thread and space mute, block and ban, recipient). A push it queues
 *     through sendPush goes under `funnel`, so the table below sends it with Mute all on and in quiet hours.
 *  2. "calls the push transport directly": do not. Send the push through NotificationsService.sendPush (it applies
 *     Mute all, the push switch, quiet hours and the send-time re-check) and the inbox row through
 *     NotificationsService.createNotification. Do not add your file to FUNNEL_SITES.
 *  3. A behavior case is red: the sender does not do what its row says. Apply the rule in the sender. If your PR
 *     cannot apply it, do not change the expectation: ask the operator for a KNOWN GAP row (KNOWN_GAPS in the
 *     registry: file:function, the rule it misses, one line why, the AUDIT link) and name it on the rule.
 *  4. A KNOWN GAP case is red because the gap is fixed: delete the gap from the rule and from KNOWN_GAPS.
 *  5. "has no send site": the row's function moved or stopped sending. Move or delete the row.
 *  6. "Fix the row's funnel entries": a sendPush call passes a kind, `urgent`, a Mute all pass (passesMuteAll,
 *     MUTE_ALL_PASS, safetyAlert) or a renewal offer (RENEWAL_OFFER) its row's `funnel` entries do not declare,
 *     or the reverse. The funnel table sends the values the code passes (LO-1186 B2), so make the entries say
 *     what the code does. "a value the scan cannot read" (a kind or a context): write it so the scan can read
 *     it (an enum member, a literal, a push-preferences constant); a kind picked at run time is declared as the
 *     row's `dynamicKind`. Never declare a Mute all pass to make it green (FR-1186R2, LO-1186R2 C3).
 *  7. "looks fixed (tripwire)": the code a KNOWN GAP names is gone. Check the gap, then delete it.
 * The registry is per function: a second send of a kind its row already lists, in the same function, adds no
 * row. When you add one, read the row again and make sure its five rules still hold for the new send.
 * The scan finds the forms its header (test/utils/notify-sender-scan.ts) lists: called, bound, destructured, by
 * `x['name']`, and under a name that holds the sender (typed, a type alias, an interface field, `@Inject(X)`, a
 * local copy). It does not see a method name built at run time, `Reflect.get`, assignment destructuring, a
 * string DI token, or `any`. sender-scan-forms.spec.ts proves each form it knows; a new way to send goes there.
 * What is driven and what is a claim (LO-1186 C2, C3): Mute all and quiet hours run for every funnel kind and every
 * driver; an emitter caller of CoachAlertEmitter is run through the real emitter with the arguments its code
 * passes (LO-1186R2 C1); a renewal offer runs with and without the person's yes (LO-1186R2 B2). Block and ban,
 * thread and space mute run only in the broadcast, churn, spacePush and heldMessage drivers; for every
 * other row, and for every recipient rule, the registry's text is a claim the scan keeps in place, not a driven
 * case, and no driver checks an exact recipient list. Out of the scan: the CoachNudge list
 * (src/nudges/nudges.service.ts NudgesService.createForClient) and CoachAlert rows (src/coach/coach-alerts.service.ts).
 * Never skip a case, loosen a check or add to FUNNEL_SITES to make this green; that is the trap KT-4 names.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { BroadcastDispatcherService, type BroadcastThreadMuteProbe } from '../../broadcasts/broadcast-dispatcher.service';
import type { BroadcastScopeService } from '../../broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../../broadcasts/segment-resolver.service';
import { DunningEscalationClassifier } from '../../checkout/dunning-v2/dunning-escalation.classifier';
import { type DispatchContext, DunningV2Dispatcher } from '../../checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../../checkout/dunning-v2/dunning-v2.renderer';
import { ChurnInterventionService } from '../../coach/command-center/churn-intervention.service';
import { CommunityNotificationsService } from '../../community/notifications/community-notifications.service';
import type { AnalyticsService } from '../../analytics/analytics.service';
import type { PrismaService } from '../../prisma.service';
import { ScoutService } from '../../scout/scout.service';
import type { SupabaseService } from '../../supabase/supabase.service';
import { CoachAlertEmitter, type CoachAlertNotificationPayload } from '../emitters/coach-alert.emitter';
import { MessageReceivedEmitter } from '../emitters/message-received.emitter';
import { NotificationKind, type NotificationKindValue } from '../notification-kind';
import { NotificationsService } from '../notifications.service';
import { type ExpoPushClient, PushDeliveryService } from '../push/push-delivery.service';
import { pushOutboxWorld } from '../../../test/utils/push-outbox-fake';
import { spaceAtSendTime } from '../../../test/utils/space-push-send-time-fake';
import {
  type DriverName,
  type FunnelPush,
  FUNNEL_SITES,
  KNOWN_GAPS,
  type KnownGapId,
  type Outcome,
  type Rule,
  SENDERS,
  type SenderRow,
} from '../../../test/utils/notify-sender-registry';
import {
  directTransport,
  funnelArgFindings,
  keyOf,
  KT4,
  sendPushHitsByRow,
  sentValues,
  unregistered,
} from '../../../test/utils/notify-sender-checks';
import { type SendHit, scanSenders } from '../../../test/utils/notify-sender-scan';

const stub = <T>(v: unknown): T => v as T;
const REPO = path.resolve(__dirname, '../../..');
/** One scan of src/ for every block below. */
const HITS = scanSenders(REPO);

// ─── (b) Architecture: every send site in src/ is the funnel or a registered sender ─────────────────────────────

describe('KT-4 sender registry: the send sites in src/', () => {
  const hits = HITS;

  it('the scan still sees the funnel (a scan that finds nothing proves nothing)', () => {
    const missing = FUNNEL_SITES.filter((s) => !hits.some((h) => h.file === s.file && h.fn === s.fn && h.via === s.via));
    expect(missing.map((s) => `FUNNEL_SITES row has no send site: ${s.file} ${s.fn} [${s.via}]`)).toEqual([]);
    expect(hits.length).toBeGreaterThan(80);
  });

  it('nothing outside the funnel calls the push transport directly', () => {
    expect(directTransport(hits)).toEqual([]);
  });

  it('every other send site is a registered sender', () => {
    expect(unregistered(hits)).toEqual([]);
  });

  it("each sendPush sender's funnel entries declare what its code passes (kind, urgent, a Mute all pass)", () => {
    expect(funnelArgFindings(hits)).toEqual([]);
  });

  it('every KNOWN GAP no driver runs still has the code that causes it (tripwire)', () => {
    const findings = (Object.entries(KNOWN_GAPS) as Array<[KnownGapId, (typeof KNOWN_GAPS)[KnownGapId]]>).flatMap(([id, g]) => {
      if (g.today) return []; // driven: the behavior cases below measure it
      const t = g.tripwire;
      if (!t) return [`${id} is not driven, so it needs a tripwire in KNOWN_GAPS. ${KT4}`];
      const at = hits.filter((h) => h.file === t.file && (!t.fn || h.fn === t.fn));
      const out: string[] = [];
      if (t.has && !at.some((h) => h.via === t.has)) out.push(`${id} looks fixed (tripwire): ${t.file} ${t.fn ?? ''} has no [${t.has}] send site any more`);
      if (t.lacks) {
        for (const h of at.filter((x) => x.via === t.lacks)) out.push(`${id} looks fixed (tripwire): ${h.file}:${h.line} ${h.fn} now has [${t.lacks}]`);
      }
      if (t.textLacks && t.textLacks.test(fs.readFileSync(path.join(REPO, t.file), 'utf8'))) {
        out.push(`${id} looks fixed (tripwire): ${t.file} now says ${t.textLacks}`);
      }
      return out.map((m) => `${m}. Check the gap, then delete it from its rule and from KNOWN_GAPS. ${KT4}`);
    });
    expect(findings).toEqual([]);
  });

  it('every registry row still has its send sites', () => {
    const stale = SENDERS.flatMap((r) =>
      r.via
        .filter((v) => !hits.some((h) => h.file === r.file && h.fn === r.fn && h.via === v))
        .map((v) => `registry row has no send site [${v}] any more: ${r.file} ${r.fn}. Move or delete the row. ${KT4}`),
    );
    expect(stale).toEqual([]);
  });

  it('the registry is well formed: one row per function, every gap named and used, every driver real', () => {
    const keys = SENDERS.map((r) => keyOf(r.file, r.fn));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const rules = (r: SenderRow): Rule[] => [r.muteAll, r.quietHours, r.mute, r.blockBan];
    const used = new Set(SENDERS.flatMap((r) => rules(r).map((x) => x.gap)).filter((g): g is KnownGapId => !!g));
    expect(Object.keys(KNOWN_GAPS).filter((g) => !used.has(g as KnownGapId))).toEqual([]);
    for (const r of SENDERS) {
      expect([r.file, r.fn, r.recipient.length > 0, r.covered.length > 0, r.kinds.length > 0]).toEqual([r.file, r.fn, true, true, true]);
      if (r.driver) expect([r.fn, r.driver in DRIVERS]).toEqual([r.fn, true]);
      // A direct pushToUser sender has no funnel quiet hours: its row must say how it keeps them, or name the gap.
      if (r.via.includes('pushToUser') && r.quietHours.does === 'held' && !r.quietHours.gap) {
        expect([r.fn, r.quietHours.why]).toEqual([r.fn, expect.stringMatching(/QuietHoursPolicy/)]);
      }
    }
  });
});

// ─── (c) Behavior: the senders through the real funnel ──────────────────────────────────────────────────────────

const TOKEN = 'ExponentPushToken[kt4senderregistry00001]';
const ZONE = 'America/New_York';
const DAY = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York
const NIGHT = new Date('2026-06-03T03:30:00Z'); // 23:30 in New York: quiet hours
const MORNING = new Date('2026-06-03T12:00:00Z'); // 08:00 the next morning in New York
const COACH = 'coach-a';
const CLIENT = 'client-1';

type Scenario = 'baseline' | 'muteAll' | 'quietHours' | 'blocked' | 'banned' | 'threadMuted' | 'spaceMuted';
const nowOf = (s: Scenario): Date => (s === 'quietHours' ? NIGHT : DAY);
// timezone_updated_at: the zone is the person's own (recipient-timezone.ts trusts only a supplied zone).
const prefsOf = (s: Scenario): Record<string, unknown> => ({ muted: s === 'muteAll', timezone: ZONE, timezone_updated_at: DAY });

let expoSend: jest.SpyInstance<Promise<ExpoPushTicket[]>, [ExpoPushMessage[]]>;

/** The real core for one recipient: NotificationsService, the push outbox (PushDeliveryService) and Expo. */
function core(user: string, scenario: Scenario, extraPrefs: Record<string, unknown> = {}) {
  const clock = { at: nowOf(scenario) };
  const w = pushOutboxWorld({ now: () => clock.at });
  w.prefs[user] = { ...prefsOf(scenario), ...extraPrefs };
  w.tokens[user] = TOKEN;
  const rows: Array<Record<string, unknown>> = [];
  // FR-1186R2 (LO-1186R2 C2): blocks the heldMessage driver makes while a push waits, readable by a worker that checks.
  const blocks: Array<{ blocker_id: string; blocked_id: string }> = [];
  const db = {
    ...w.db,
    userBlock: {
      findFirst: jest.fn(async () => blocks[0] ?? null),
      findMany: jest.fn(async () => [...blocks]),
      count: jest.fn(async () => blocks.length),
    },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        rows.push(a.data);
        return { id: `n-${rows.length}`, ...a.data };
      }),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const client = stub<ExpoPushClient>({
    send: jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` }))),
    getReceipts: jest.fn(async () => ({})),
  });
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
  delivery.autoDrain = false;
  const svc = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery);
  // Some senders fire pushToUser without awaiting it; the outcome waits for those calls to finish.
  const direct = jest.spyOn(svc, 'pushToUser');
  return {
    w,
    svc,
    clock,
    blocks,
    delivery,
    /** How many pushes the outbox worker handed to its transport. */
    workerSent: (): number => (client.send as jest.Mock).mock.calls.length,
    rows: () => rows.filter((r) => r.user_id === user),
    /** What reached the person: a push sent now (Expo) or due now (the outbox), a push held to 08:00, or nothing. */
    outcome: async (): Promise<string> => {
      await Promise.allSettled(direct.mock.results.map((r) => r.value));
      const sentNow = expoSend.mock.calls.flatMap(([chunk]) => chunk).filter((m) => m.to === TOKEN).length;
      const queued = w.rows.filter((r) => r.user_id === user);
      const due = queued.filter((r) => r.not_before.getTime() <= clock.at.getTime()).length;
      const held = queued.filter((r) => r.not_before.getTime() > clock.at.getTime());
      if (sentNow + due > 0) return 'sent';
      if (held.length === 0) return 'none';
      return held.every((r) => r.not_before.getTime() === MORNING.getTime()) ? 'held' : `held to ${held.map((r) => r.not_before.toISOString())}`;
    },
  };
}

/** A broadcast copy to CLIENT: the real deliverOne, the real MessageReceivedEmitter, the real core. */
async function broadcast(s: Scenario): Promise<string> {
  const c = core(CLIENT, s);
  const settle = jest.fn(async (_a: { data: { deliver_after?: Date } }) => ({ count: 1 }));
  const tx = {
    $queryRaw: jest.fn(async () => [{ status: 'sending' }]),
    coachMessage: { create: jest.fn(async () => ({ id: 'm1' })) },
    coachMessageCard: { create: jest.fn(async () => ({})) },
    coachBroadcastDelivery: { updateMany: settle },
  };
  const payload = { urgent: false, body: 'Morning {first_name}', card: null };
  const prisma = {
    coachBroadcastDelivery: {
      updateMany: settle,
      findUnique: jest.fn(async () => ({
        id: 'd1',
        attempts: 0,
        recipient_id: CLIENT,
        run: { ...payload, segment: {}, broadcast: { id: 'b1', coach_id: COACH, author_user_id: COACH, status: 'sending', ...payload } },
      })),
    },
    user: {
      findFirst: jest.fn(async () => ({ id: CLIENT, name: 'Sarah Lee' })),
      findUnique: jest.fn(async () => ({ name: 'Coach Bradley' })),
    },
    userBlock: { findFirst: jest.fn(async () => (s === 'blocked' ? { blocker_id: CLIENT, blocked_id: COACH } : null)) },
    notificationPreferences: { findUnique: jest.fn(async () => prefsOf(s)) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new BroadcastDispatcherService(
    stub<ConstructorParameters<typeof BroadcastDispatcherService>[0]>(prisma),
    stub<BroadcastScopeService>({ lockSendAuthority: jest.fn(async () => null) }),
    stub<SegmentResolverService>({}),
    stub<SupabaseService>({ pingChat: jest.fn(async () => undefined) }),
    new MessageReceivedEmitter(c.svc),
    stub<BroadcastThreadMuteProbe>({ isThreadMuted: jest.fn(async () => s === 'threadMuted') }),
  );
  const status = await svc.deliverOne('d1', nowOf(s));
  expect([s, status]).toEqual([s, s === 'blocked' ? 'skipped_blocked' : s === 'quietHours' ? 'deferred' : 'delivered']);
  if (s === 'threadMuted') expect(c.rows()).toEqual([]); // a muted thread gets the message, no row and no push
  if (status === 'deferred') {
    // deliverOne holds the whole copy (message, row and push) to 08:00 in the client's zone.
    const until = settle.mock.calls.map(([a]) => a.data.deliver_after).find((d): d is Date => d instanceof Date);
    return until && until.getTime() === MORNING.getTime() ? 'held' : `held to ${String(until)}`;
  }
  return c.outcome();
}

/** A churn intervention to CLIENT: the real sendIntervention and the real pushToUser. */
async function churnIntervention(s: Scenario): Promise<string> {
  const c = core(CLIENT, s);
  const intervention = { id: 'int-1', coach_id: COACH, client_id: CLIENT, status: 'draft', draft_text: 'Hi' };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: CLIENT, coach_id: COACH, role: 'student', deleted_at: null }]),
    churnIntervention: { updateMany: jest.fn(async () => ({ count: 1 })) },
    coachNudge: { create: jest.fn(async (a: { data: Record<string, unknown> }) => a.data) },
    notification: { create: jest.fn(async (a: { data: Record<string, unknown> }) => a.data) },
  };
  const prisma = {
    churnIntervention: { findFirst: jest.fn(async (a: { where: { id?: string } }) => (a.where.id ? intervention : null)) },
    notificationPreferences: { findUnique: jest.fn(async () => prefsOf(s)) },
    userBlock: { findMany: jest.fn(async () => (s === 'blocked' ? [{ blocker_id: CLIENT, blocked_id: COACH }] : [])) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new ChurnInterventionService(
    stub<ConstructorParameters<typeof ChurnInterventionService>[0]>(prisma),
    stub<ConstructorParameters<typeof ChurnInterventionService>[1]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[2]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[3]>({}),
    c.svc,
  );
  const sent = svc.sendIntervention(COACH, 'int-1', { message_text: 'Checking in this week', idempotency_key: randomUUID() });
  if (s === 'blocked') await expect(sent).rejects.toMatchObject({ status: 403 });
  else expect((await sent).ok).toBe(true);
  // The inbox row is written in the send transaction; Mute all never stops it (owner #171-3).
  expect([s, tx.notification.create.mock.calls.length]).toEqual([s, s === 'blocked' ? 0 : 1]);
  return c.outcome();
}

/** An import settled for COACH: the real ScoutService.complete and the real pushToUser. */
async function scoutImport(s: Scenario): Promise<string> {
  const c = core(COACH, s);
  const prisma = {
    scoutImportCompletion: { create: jest.fn(async () => ({})) },
    scoutImport: { upsert: jest.fn(async () => ({})) },
    notificationPreferences: { findUnique: jest.fn(async () => prefsOf(s)) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new ScoutService(stub<ConstructorParameters<typeof ScoutService>[0]>(prisma), c.svc, stub<AnalyticsService>({ capture: jest.fn() }));
  expect(await svc.complete(COACH, { intent_id: 'intent-1', terminal_status: 'success' })).toEqual({ acknowledged: true, intent_id: 'intent-1' });
  return c.outcome();
}

let communityRuns = 0;

/** A community DM push: the real sendCommunityPush, channelGate and pushToUser. */
async function communityPush(s: Scenario): Promise<string> {
  // One recipient per run: createNotification keeps a 60 s push-channel throttle in module state,
  // and seven registry rows share this driver.
  communityRuns += 1;
  const member = `member-${communityRuns}-${s}`;
  const c = core(member, s);
  const prisma = {
    notification: { findFirst: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ expo_push_token: TOKEN })) },
  };
  const community = new CommunityNotificationsService(
    c.svc,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
  );
  await community.sendCommunityPush({ recipientId: member, kind: NotificationKind.COMMUNITY_DM_RECEIVED, targetType: 'dm', targetId: `dm-${s}` });
  expect(c.rows().map((r) => r.kind)).toEqual([NotificationKind.COMMUNITY_DM_RECEIVED]); // the row stays
  return c.outcome();
}

/** The client's failed-payment push: the real DunningV2Dispatcher.sendClientPush and the real pushToUser. */
async function dunningClientPush(s: Scenario): Promise<string> {
  const c = core(CLIENT, s);
  const classifier = new DunningEscalationClassifier();
  const step = [0, 1, 2, 3].find((i) => classifier.resolve({ stepIndex: i, isLateReversalCycle: false }).push);
  expect(step).toBeDefined();
  const dispatcher = new DunningV2Dispatcher(
    classifier,
    new DunningV2Renderer(),
    stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({ attemptFailed: jest.fn(), notifySent: jest.fn(), coachNotified: jest.fn() }),
    c.svc,
    undefined,
    new CoachAlertEmitter(c.svc),
  );
  const ctx: DispatchContext = {
    dunningStateId: 'ds-kt4',
    cycleKey: '1',
    stepIndex: step ?? -1,
    isLateReversalCycle: false,
    clientUserId: CLIENT,
    coachUserId: COACH,
    clientEmail: 'client@tgp.invalid',
    coachEmail: 'coach@tgp.invalid',
    tokens: { firstName: 'Avery', clientName: 'Avery Client', coachName: 'Morgan Coach', amount: '$150.00', lockoutDate: 'October 14' },
    dunningDetailDeeplink: `tgp://coach/clients/${CLIENT}`,
  };
  const out = await dispatcher.dispatchStepDetailed(ctx, undefined, { channels: ['client_push'] });
  expect(out.results.client_push).toEqual({ status: 'sent' });
  return c.outcome();
}

/** A space chat push at send time: the real sendPush, the real outbox worker and its space re-plan. */
async function spacePush(s: Scenario): Promise<string> {
  const clock = { at: nowOf(s) };
  const w = pushOutboxWorld({ now: () => clock.at, tokens: { ana: TOKEN, bo: TOKEN } });
  w.prefs.ana = prefsOf(s);
  w.prefs.bo = prefsOf(s);
  const at = spaceAtSendTime(w.db);
  const MSG = { id: 'm1', workspace_id: 'w', cohort_id: 'c1', sender_id: 'sam', parent_message_id: null as string | null, high_alert: false };
  at.s.messages.push({ ...MSG }, { ...MSG, id: 'm2', parent_message_id: 'p1' }, { ...MSG, id: 'p1', sender_id: 'ana' });
  if (s === 'blocked') at.s.blocks.push({ blocker_id: 'bo', blocked_id: 'sam' });
  if (s === 'banned') at.s.bans.add('w:sam');
  if (s === 'spaceMuted') at.s.reads.bo = { notify_mode: 'mute_all', silenced_until: null };
  if (s === 'threadMuted') at.s.threads['ana:p1'] = 'muted';
  const send = jest.fn(async (m: Array<{ to: unknown }>) => m.map(() => ({ status: 'ok' as const, id: 't' })));
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<PrismaService>(at.db), { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(w.db), undefined, undefined, delivery);
  // A reply in thread p1 goes to its author (ana); an ordinary message goes to the other reader (bo).
  const [user, kind, messageId] = s === 'threadMuted' ? (['ana', 'reply', 'm2'] as const) : (['bo', 'unread', 'm1'] as const);
  await notifications.sendPush({
    user_id: user,
    kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
    body: '',
    deep_link: 'tgp://community/cohorts/c1',
    dedupe_key: `space-push:${messageId}:${user}`,
    context: { timeZone: ZONE, spacePush: { kind, unread: 1, space: 'Team', cohortId: 'c1', messageId, senderId: 'sam' } },
  });
  await delivery.drain();
  if (send.mock.calls.length > 0) return 'sent';
  const held = w.rows.filter((r) => r.status === 'pending');
  if (held.length === 0) return 'none';
  return held.every((r) => r.not_before.getTime() === MORNING.getTime()) ? 'held' : `held to ${held.map((r) => r.not_before.toISOString())}`;
}

/**
 * FR-1186R2 (LO-1186R2 C2, KG-HELD-BLOCK-MESSAGE): a coach's message push to CLIENT through the real
 * MessageReceivedEmitter and the real funnel, held at 23:30 by quiet hours. In `blocked`, CLIENT blocks the
 * coach while it waits. At 08:00 the real outbox worker runs: 'sent' when it hands the push to the transport.
 */
async function heldMessage(s: Scenario): Promise<string> {
  const c = core(CLIENT, 'quietHours');
  await new MessageReceivedEmitter(c.svc).emit(CLIENT, { senderName: 'Coach A', threadId: 'thread-1' });
  const at2330 = await c.outcome();
  if (at2330 !== 'held') return `not held at 23:30 (${at2330})`;
  if (s === 'blocked') c.blocks.push({ blocker_id: CLIENT, blocked_id: COACH });
  c.clock.at = MORNING;
  await c.delivery.drain();
  return c.workerSent() > 0 ? 'sent' : 'none';
}

const DRIVERS: Record<DriverName, { run: (s: Scenario) => Promise<string>; scenarios: Scenario[] }> = {
  broadcast: { run: broadcast, scenarios: ['baseline', 'muteAll', 'quietHours', 'blocked', 'threadMuted'] },
  churnIntervention: { run: churnIntervention, scenarios: ['baseline', 'muteAll', 'quietHours', 'blocked'] },
  scoutImport: { run: scoutImport, scenarios: ['baseline', 'muteAll', 'quietHours'] },
  communityPush: { run: communityPush, scenarios: ['baseline', 'muteAll', 'quietHours'] },
  dunningClientPush: { run: dunningClientPush, scenarios: ['baseline', 'muteAll', 'quietHours'] },
  spacePush: { run: spacePush, scenarios: ['baseline', 'muteAll', 'quietHours', 'blocked', 'banned', 'spaceMuted', 'threadMuted'] },
  heldMessage: { run: heldMessage, scenarios: ['baseline', 'blocked'] },
};

/** What the registry row says must happen in this case; a KNOWN GAP case expects what the code does today. */
function expected(row: SenderRow, s: Scenario): { outcome: Outcome; gap?: KnownGapId } {
  const rule: Rule | undefined =
    s === 'muteAll' ? row.muteAll : s === 'quietHours' ? row.quietHours : s === 'blocked' || s === 'banned' ? row.blockBan : s === 'baseline' ? undefined : row.mute;
  if (!rule) return { outcome: 'sent' };
  if (rule.gap) {
    const today = KNOWN_GAPS[rule.gap].today;
    if (!today) throw new Error(`${row.fn}: ${rule.gap} is driven here, so KNOWN_GAPS must say what the code does today`);
    return { outcome: today, gap: rule.gap };
  }
  if (rule.does === 'stops') return { outcome: 'none' };
  if (rule.does === 'held') return { outcome: 'held' };
  if (rule.does === 'passes') return { outcome: 'sent' };
  throw new Error(`${row.fn}: the ${s} case is driven but the rule is n/a; drop the case or state the rule`);
}

const quiet = (): void => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
};
const FLAGS = ['FEATURE_COACH_BROADCASTS', 'FEATURE_COMMUNITY_PUSH', 'FEATURE_COMMUNITY_SPACE_PUSH'] as const;
const savedFlags = FLAGS.map((f) => [f, process.env[f]] as const);

describe('KT-4 sender registry: each driven sender does what its row says', () => {
  beforeAll(() => {
    quiet();
    for (const f of FLAGS) process.env[f] = 'true';
  });
  beforeEach(() => {
    expoSend = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' as const, id: 'ticket' })));
  });
  afterEach(() => expoSend.mockRestore());
  afterAll(() => {
    for (const [f, v] of savedFlags) {
      if (v === undefined) delete process.env[f];
      else process.env[f] = v;
    }
    jest.restoreAllMocks();
  });

  const cases = SENDERS.filter((r): r is SenderRow & { driver: DriverName } => !!r.driver).flatMap((row) =>
    DRIVERS[row.driver].scenarios.map((s) => {
      const exp = expected(row, s);
      const label = `${row.fn} [${row.driver}] ${s}: ${exp.outcome}${exp.gap ? ` (KNOWN GAP ${exp.gap})` : ''}`;
      return [label, row, s, exp] as const;
    }),
  );

  it.each(cases)('%s', async (_label, row, s, exp) => {
    const got = await DRIVERS[row.driver].run(s);
    const hint = exp.gap
      ? `${exp.gap} looks fixed: delete it from the rule and from KNOWN_GAPS`
      : `${row.file} ${row.fn} breaks its registry row (${s}). ${KT4}`;
    expect({ case: s, got, hint }).toEqual({ case: s, got: exp.outcome, hint });
  });
});

/** FR-1186R2 (LO-1186R2 C1): an emitter caller's CoachAlertEmitter calls, each with the argument the scan read. */
function coachAlertCalls(row: SenderRow): SendHit[] {
  return HITS.filter((h) => h.file === row.file && h.fn === row.fn && h.via === 'emitter' && h.relay?.name === 'CoachAlertEmitter');
}

/** The props of a CoachAlertEmitter.emit argument that pick its push's context and urgent. */
const ALERT_PROPS = ['money', 'alertType', 'severity', 'spaceId'] as const;

/**
 * FR-1186R2 (LO-1186R2 C1): what the real CoachAlertEmitter queues for one funnel entry of a caller. Each prop in
 * ALERT_PROPS is the caller's own literal when every call passes the same one, left out when no call passes it,
 * and the entry's stand-in (from its context and urgent) only when the caller picks it at run time.
 */
async function coachAlertSent(row: SenderRow, e: FunnelPush) {
  const vs = coachAlertCalls(row).flatMap((h) => (h.callArgs && !h.callArgs.opaque ? h.callArgs.variants : []));
  const cx = (e.context ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    coachId: CLIENT,
    alertId: 'kt4-alert',
    message: 'Body',
    clientUserId: 'client-x',
    alertType: typeof cx.safetyAlert === 'string' ? cx.safetyAlert : 'kt4_alert',
    severity: e.urgent ? 'critical' : 'warning',
    ...(cx.passesMuteAll === true ? { money: true } : {}),
    ...(cx.spaceAlert === true ? { spaceId: 'space-1' } : {}),
  };
  const from: string[] = [];
  if (vs.length === 0) from.push('registry (the scan cannot read its argument)');
  else {
    for (const k of ALERT_PROPS) {
      const seen = vs.map((v) => v[k]);
      const values = new Set(seen.map((x) => (x && 'value' in x ? JSON.stringify(x.value) : undefined)));
      if (seen.every((x) => x === undefined)) {
        delete payload[k];
        from.push(`${k}: code (none)`);
      } else if (values.size === 1 && !values.has(undefined)) {
        payload[k] = JSON.parse([...values][0] as string) as unknown;
        from.push(`${k}: code`);
      } else from.push(`${k}: registry`);
    }
  }
  const queued: Array<Record<string, unknown>> = [];
  const notifications = stub<NotificationsService>({
    sendPush: jest.fn(async (a: Record<string, unknown>) => {
      queued.push(a);
      return true;
    }),
    createNotification: jest.fn(async () => null),
  });
  await new CoachAlertEmitter(notifications).emit(payload as unknown as CoachAlertNotificationPayload, { inapp: false });
  const a = queued[0] ?? {};
  return {
    kind: (a.kind ?? e.kind) as FunnelPush['kind'],
    urgent: a.urgent as boolean | undefined,
    context: (a.context ?? null) as FunnelPush['context'],
    from: `emitter: the real CoachAlertEmitter.emit (${from.join(', ')})`,
  };
}

describe('KT-4 sender registry: the funnel holds every registered push kind to its rules', () => {
  beforeAll(quiet);
  afterAll(() => jest.restoreAllMocks());

  // LO-1186 B2: each push is sent with the kind, urgent and context its sender's own sendPush call passes; an
  // entry's declared value is used only where the code picks at run time (funnelArgFindings checks the entries
  // cover each choice). FR-1186R2 (LO-1186R2 C1): a caller of CoachAlertEmitter is run through the real emitter
  // with the money, alertType, severity and spaceId its own call passes (coachAlertSent). Any other emitter
  // caller sends its declared values: those emitters fix the kind, urgent and context themselves.
  // FR-1186R2 (LO-1186R2 B2, LS-1186R2 B2): an entry with consent: 'needed' (a renewal offer) is sent with the
  // person's yes (plan_renewal_offers_opt_in_at), and once without it; so is every other entry of its row
  // (Day 0 needs no yes).
  const byRow = sendPushHitsByRow(HITS);
  const pushes = SENDERS.flatMap((r) => (r.funnel ?? []).map((p) => [r, p, sentValues(byRow.get(r), p)] as const));
  type FunnelCase = 'baseline' | 'muteAll' | 'quietHours' | 'noConsent';
  const cases = pushes.flatMap(([row, p, sent]) => {
    const consentRow = (row.funnel ?? []).some((e) => e.consent === 'needed');
    const scenarios: FunnelCase[] = ['baseline', 'muteAll', 'quietHours', ...(consentRow ? (['noConsent'] as const) : [])];
    const from = coachAlertCalls(row).length > 0 && !byRow.has(row) ? 'emitter: the real CoachAlertEmitter.emit with its call args' : sent.from;
    return scenarios.map((s) => {
      const outcome: Outcome =
        s === 'baseline'
          ? 'sent'
          : s === 'noConsent'
            ? p.consent === 'needed'
              ? 'none'
              : 'sent'
            : s === 'muteAll'
              ? p.muteAll === 'stops'
                ? 'none'
                : 'sent'
              : p.quietHours === 'held'
                ? 'held'
                : 'sent';
      return [`${row.fn}: ${sent.kind} (${p.note}; ${from}) ${s}: ${outcome}`, row, p, sent, s, outcome] as const;
    });
  });

  it.each(cases)('%s', async (_label, row, entry, declared, s, outcome) => {
    expoSend = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' as const, id: 't' })));
    try {
      const p = coachAlertCalls(row).length > 0 && !byRow.has(row) ? await coachAlertSent(row, entry) : declared;
      const yes = entry.consent === 'needed' && s !== 'noConsent' ? { plan_renewal_offers_opt_in_at: DAY } : {};
      const c = core(CLIENT, s === 'noConsent' ? 'baseline' : s, yes);
      await c.svc.sendPush({
        user_id: CLIENT,
        kind: p.kind,
        body: 'Body',
        deep_link: 'tgp://notifications',
        context: p.context ?? null,
        urgent: p.urgent,
        dedupe_key: `kt4:${randomUUID()}`,
      });
      const hint = `${row.file} ${row.fn}: ${p.kind} (${p.from}) must give ${outcome} (${s}). ${KT4}`;
      expect({ case: s, got: await c.outcome(), hint }).toEqual({ case: s, got: outcome, hint });
    } finally {
      expoSend.mockRestore();
    }
  });
});

describe('KT-4 sender registry: Mute all never stops an in-app row (owner #171-3)', () => {
  beforeAll(quiet);
  afterAll(() => jest.restoreAllMocks());

  const kinds = new Set<string>(Object.values(NotificationKind));
  const inapp = [
    ...new Set(
      SENDERS.filter((r) => r.via.includes('createNotification') || r.via.includes('emitter') || r.via.includes('communityPush'))
        .flatMap((r) => r.kinds)
        .filter((k) => kinds.has(k)),
    ),
  ].sort();

  it('the registry names in-app kinds', () => expect(inapp.length).toBeGreaterThan(10));

  it.each(inapp)('%s: written for a recipient with Mute all on', async (kind) => {
    expoSend = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' as const, id: 't' })));
    try {
      const c = core(CLIENT, 'muteAll');
      const row = await c.svc.createNotification({ user_id: CLIENT, kind: kind as NotificationKindValue, body: 'Body', channel: 'inapp' });
      expect([kind, row === null ? 'stopped' : 'written']).toEqual([kind, 'written']);
    } finally {
      expoSend.mockRestore();
    }
  });
});
