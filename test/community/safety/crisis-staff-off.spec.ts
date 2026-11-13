/**
 * CRISIS-STAFF-OFF-BE (operator 203; owner #203-E34, answering 203-D7): for v1 a community text Roman's crisis check
 * matches tells no owner-role account. O1 (red at main): none of alertStaff's 10 callers (S1 to S8, the word-list
 * refusal R1, the photo or caption refusal R2) writes an inbox row, queues a push, reads the owner-role accounts or
 * logs a community.crisis_alert line. O2 (red at main): a staff push main's alertStaff already queued is dropped at
 * send, due now, held to 08:00 by quiet hours or due for a retry, and never reaches Expo. Guards, green at main too:
 * the poster's answer, its 422s and the photo safety alert (O3); every other safety push, a plain coach_alert push and
 * the money check (O4); a stored staff row still lists, counts and marks read for its own recipient only (O5).
 * The writes run the crisis table's world (crisis-text-world.ts); samples are its ROT13 constants, described by kind
 * only ([R22]).
 */
import { Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import * as photoCheck from '../../../src/community/images/community-photo-check';
import { mintImageKey } from '../../../src/community/images/community-image-store';
import { CoachAlertsService } from '../../../src/coach/coach-alerts.service';
import { ReconciliationDailyCron } from '../../../src/checkout/reconciliation-daily.cron';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { SubCoachScopeService } from '../../../src/sub-coach/sub-coach-scope.service';
import { SchedulingAccessService } from '../../../src/scheduling/scheduling-access.service';
import * as spaces from '../../../src/community/space-safety-alerts';
import {
  COMMUNITY_CRISIS_ALERT_KEY,
  COMMUNITY_CRISIS_ALERT_TITLE,
  SAFETY_ALERT_INBOX_BODY,
  SAFETY_ALERT_PUSH_BODY,
  SPACE_SAFETY_ALERT_PUSH_BODY,
} from '../../../src/notifications/push/lock-screen-copy';
import { whereMatches } from '../../utils/notification-where';
import { staffAlertWorld } from './staff-alert-world';
import {
  ORDINARY,
  PATHS,
  POSTER,
  REFUSED_MATCH,
  REFUSED_ORDINARY,
  SELF_HARM,
  SPACE,
  STAFF_A,
  STAFF_B,
  type Row,
  type World,
  type WorldOptions,
  asSent,
  eachPath,
  poster,
  pushesOf,
  settled,
  stub,
  world,
} from './crisis-text-world';

const CHECK = 'COMMUNITY_CRISIS_CHECK_ENABLED';
const IMAGES = { FEATURE_COMMUNITY_IMAGES: 'true', VOICE_KEY_SIGNING_SECRET: 'crisis-staff-off-secret' };
/** The caption a photo message has before its edit (ordinary, and not either edit's text). */
const PHOTO_CAPTION = 'Photo from leg day';
const SPACE_LEAD = '4f4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6d';
const DAY = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York
const NIGHT = new Date('2026-06-03T03:30:00Z'); // 23:30 in New York: quiet hours
const MORNING = new Date('2026-06-03T12:00:00Z'); // 08:00 in New York (EDT)

beforeEach(() => {
  delete process.env[CHECK];
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env[CHECK];
  for (const k of Object.keys(IMAGES)) delete process.env[k];
});

/** A photo send (S1) whose photo check refuses with `code`; the check's own photo alert runs first, as it does live. */
const photoRefused = (code: string, error: string, text: string) => async (w: World) => {
  Object.assign(process.env, IMAGES);
  jest.spyOn(photoCheck, 'assertPhotoAllowed').mockImplementation(async (...a) => {
    await a[6]?.();
    throw new UnprocessableEntityException({ error, code });
  });
  return w.chat
    .send(poster, SPACE, text, undefined, undefined, { key: mintImageKey(POSTER, SPACE), width: 10, height: 10 })
    .catch((e: unknown) => e);
};

/** A photo message's caption edit (S2) that the caption check refuses. */
const captionEditRefused = (text: string) => async (w: World) => {
  Object.assign(process.env, IMAGES);
  jest.spyOn(photoCheck, 'assertCaptionAllowed').mockImplementation(async (...a) => {
    await a[2]?.();
    throw new UnprocessableEntityException({ error: 'invalid_caption', code: 'CAPTION_NOT_ALLOWED' });
  });
  const m = w.stamp({ body: PHOTO_CAPTION, kind: 'image' });
  return w.chat.edit(poster, String(m.id), text).catch((e: unknown) => e);
};

/** The poster's answer, or the body of the 422 the phone receives. */
const bodyOf = (got: unknown): Row => (got instanceof Error ? asSent(got).body : (got as Row));

// ─── The universe: alertStaff's 10 callers (git grep alertStaff over src at 9251b4eb) ───────────────────────────────

interface Caller {
  id: string;
  /** The write, with a text Roman's crisis check matches. */
  write: (w: World) => Promise<unknown>;
}
const CALLERS: Caller[] = [
  ...PATHS.map((p) => ({ id: p.id, write: (w: World) => p.write(w, SELF_HARM) })),
  ...PATHS.map((p) => ({
    id: `R1 word-list refusal, from ${p.id}`,
    write: (w: World) => p.write(w, REFUSED_MATCH).catch((e: unknown) => e),
  })),
  { id: 'R2 photo refusal, S1 PHOTO_NOT_ALLOWED', write: photoRefused('PHOTO_NOT_ALLOWED', 'invalid_image', SELF_HARM) },
  { id: 'R2 caption refusal, S1 CAPTION_NOT_ALLOWED', write: photoRefused('CAPTION_NOT_ALLOWED', 'invalid_caption', SELF_HARM) },
  { id: 'R2 caption refusal, S2 caption edit', write: captionEditRefused(SELF_HARM) },
];
const EACH = CALLERS.map((c) => [c.id, c] as const);

// ─── O1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('O1 (#203-E34): a community crisis match tells no owner-role account, from any of the 10 callers', () => {
  it.each(EACH)('%s: the write matched, and no inbox row, no push and no PushOutbox row for either owner-role account', async (_n, c) => {
    const w = world();
    const rows = jest.spyOn(w.notifications, 'createNotification');
    const sends = jest.spyOn(w.notifications, 'sendPush');
    const got = await c.write(w);
    await settled();
    expect(bodyOf(got).crisis_flag).toBe(true);
    expect(rows).not.toHaveBeenCalled();
    expect(sends).not.toHaveBeenCalled();
    expect(w.inbox).toEqual([]);
    expect(pushesOf(w)).toEqual([]);
  });

  it.each(EACH)('%s: the owner-role accounts are not read', async (_n, c) => {
    const w = world();
    await c.write(w);
    await settled();
    expect(w.prisma.user.findMany.mock.calls.filter(([a]) => a?.where?.role === 'owner')).toEqual([]);
  });

  const LOGGING: Array<[string, WorldOptions]> = [
    ['no owner-role account', { owners: [] }],
    ['both owner-role accounts with coach_alert in-app and push off', { prefs: { coach_alert_inapp: false, coach_alert_push: false } }],
  ];
  const logCases = CALLERS.flatMap((c) => LOGGING.map(([n, o]) => [c.id, n, c, o] as const));
  it.each(logCases)('%s, %s: no community.crisis_alert line', async (_n, _k, c, o) => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...m: unknown[]) => void lines.push(String(m[0])));
    }
    const w = world(o);
    await c.write(w);
    await settled();
    expect(lines.filter((m) => m.startsWith('community.crisis_alert'))).toEqual([]);
  });
});

// ─── O2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Queue the staff push exactly as main's alertStaff queues it (community-safety.service.ts:356-363 at 9251b4eb). */
async function queueAsMain(w: ReturnType<typeof staffAlertWorld>) {
  const day = w.clock.at.toISOString().slice(0, 10);
  for (const user_id of [STAFF_A, STAFF_B]) {
    await w.notifications.sendPush({
      user_id,
      kind: NotificationKind.COACH_ALERT,
      body: SAFETY_ALERT_PUSH_BODY[COMMUNITY_CRISIS_ALERT_KEY],
      context: { safetyAlert: COMMUNITY_CRISIS_ALERT_KEY },
      dedupe_key: `community_crisis:${POSTER}:${day}`,
    });
  }
  expect(w.out.rows.map((r) => [r.user_id, r.kind, r.context, r.status])).toEqual([
    [STAFF_A, NotificationKind.COACH_ALERT, { safetyAlert: COMMUNITY_CRISIS_ALERT_KEY }, 'pending'],
    [STAFF_B, NotificationKind.COACH_ALERT, { safetyAlert: COMMUNITY_CRISIS_ALERT_KEY }, 'pending'],
  ]);
}
const expoOf = (w: ReturnType<typeof staffAlertWorld>) =>
  (w.delivery as unknown as { client: { send: jest.Mock } }).client.send;

describe('O2 (#203-E34): a staff crisis push already queued is dropped at send and never reaches Expo', () => {
  it('due now: both rows end dropped, obsolete', async () => {
    const w = staffAlertWorld({ at: DAY });
    await queueAsMain(w);
    await w.delivery.drain();
    expect(w.out.rows.map((r) => [r.status, r.result_code, r.sent_at])).toEqual([
      ['dropped', 'obsolete', null],
      ['dropped', 'obsolete', null],
    ]);
    expect(expoOf(w)).not.toHaveBeenCalled();
  });

  it('held to 08:00 by quiet hours, then due at 08:00: both rows end dropped, obsolete', async () => {
    const w = staffAlertWorld({ at: NIGHT });
    await queueAsMain(w);
    expect(w.out.rows.map((r) => [r.not_before.toISOString(), r.deferred_reason])).toEqual([
      [MORNING.toISOString(), 'quiet_hours'],
      [MORNING.toISOString(), 'quiet_hours'],
    ]);
    w.clock.at = MORNING;
    await w.delivery.drain();
    expect(w.out.rows.map((r) => [r.status, r.result_code, r.sent_at])).toEqual([
      ['dropped', 'obsolete', null],
      ['dropped', 'obsolete', null],
    ]);
    expect(expoOf(w)).not.toHaveBeenCalled();
  });

  it('a retry due (main tried once and scheduled a provider retry): both rows end dropped, obsolete', async () => {
    const w = staffAlertWorld({ at: DAY });
    await queueAsMain(w);
    for (const r of w.out.rows) {
      Object.assign(r, { attempts: 1, deferred_reason: 'provider_retry', result_code: 'retry-scheduled', not_before: DAY });
    }
    await w.delivery.drain();
    expect(w.out.rows.map((r) => [r.status, r.result_code, r.sent_at])).toEqual([
      ['dropped', 'obsolete', null],
      ['dropped', 'obsolete', null],
    ]);
    expect(expoOf(w)).not.toHaveBeenCalled();
  });
});

// ─── O3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An answer's JSON with ids and instants masked, so two writes in two worlds compare byte for byte. */
const masked = (a: unknown) =>
  JSON.stringify(a)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<at>');

describe('O3 (guard, green at main too): what the poster gets is as at main', () => {
  it.each(eachPath)('%s: a match answers crisis_flag: true', async (_n, p) => {
    const a = await p.write(world(), SELF_HARM);
    expect(a.crisis_flag).toBe(true);
  });

  it.each(eachPath)('%s: an ordinary text gets no field, and a match is that same answer byte for byte plus the one key', async (_n, p) => {
    const ordinary = await p.write(world(), ORDINARY);
    const { crisis_flag, ...rest } = await p.write(world(), SELF_HARM);
    expect(ordinary).not.toHaveProperty('crisis_flag');
    expect(crisis_flag).toBe(true);
    expect(masked(rest).split(SELF_HARM).join(ORDINARY)).toBe(masked(ordinary));
  });

  it.each(eachPath)('R1 from %s: the 422 keeps crisis_flag: true beside the same keys', async (_n, p) => {
    const match = asSent(await p.write(world(), REFUSED_MATCH).catch((e: unknown) => e));
    const plain = asSent(await p.write(world(), REFUSED_ORDINARY).catch((e: unknown) => e));
    expect([match.status, plain.status]).toEqual([422, 422]);
    expect(match.body).toMatchObject({ code: 'community.content.rejected', error: 'content_rejected', crisis_flag: true });
    expect(Object.keys(match.body).sort()).toEqual([...Object.keys(plain.body), 'crisis_flag'].sort());
  });

  it.each([
    ['S1 PHOTO_NOT_ALLOWED', (t: string) => photoRefused('PHOTO_NOT_ALLOWED', 'invalid_image', t)],
    ['S1 CAPTION_NOT_ALLOWED', (t: string) => photoRefused('CAPTION_NOT_ALLOWED', 'invalid_caption', t)],
    ['S2 caption edit CAPTION_NOT_ALLOWED', (t: string) => captionEditRefused(t)],
  ] as const)('R2 %s: the 422 keeps its own code with crisis_flag: true beside the same keys', async (name, refusal) => {
    const match = asSent(await refusal(SELF_HARM)(world()));
    const plain = asSent(await refusal(ORDINARY)(world()));
    expect([match.status, plain.status]).toEqual([422, 422]);
    expect(match.body).toMatchObject({ code: name.split(' ').pop(), crisis_flag: true });
    expect(Object.keys(match.body).sort()).toEqual([...Object.keys(plain.body), 'crisis_flag'].sort());
  });

  it.each(eachPath)('%s: COMMUNITY_CRISIS_CHECK_ENABLED "false": a match and a refused match read as main', async (_n, p) => {
    process.env[CHECK] = 'false';
    const w = world();
    const a = await p.write(w, SELF_HARM);
    const refused = asSent(await p.write(w, REFUSED_MATCH).catch((e: unknown) => e));
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expect(refused.status).toBe(422);
    expect(refused.body).not.toHaveProperty('crisis_flag');
    expect(w.inbox).toEqual([]);
    expect(pushesOf(w)).toEqual([]);
  });

  it("R2 S1 photo refusal: the photo safety alert still goes to the poster's coach and to the public space's side", async () => {
    const w = world();
    const alerts = { createAlert: jest.fn(async () => undefined) };
    Object.defineProperty(w.chat, 'moduleRef', {
      value: stub<ModuleRef>({ get: (t: unknown) => (t === CoachAlertsService ? alerts : undefined) }),
    });
    Object.assign(w.access, { spaceLeaders: async () => [SPACE_LEAD] });
    jest.spyOn(w.safety, 'hiddenFromViewer').mockResolvedValue(new Set());
    const got = await photoRefused('PHOTO_NOT_ALLOWED', 'invalid_image', SELF_HARM)(w);
    await settled();
    expect(asSent(got).body).toMatchObject({ code: 'PHOTO_NOT_ALLOWED', crisis_flag: true });
    const alert = { clientId: POSTER, alertType: 'community_photo_safety', severity: 'critical' };
    expect(alerts.createAlert.mock.calls).toEqual([
      [{ ...alert, coachId: 'coach-1', message: SAFETY_ALERT_PUSH_BODY.community_photo_safety }],
      [{ ...alert, coachId: SPACE_LEAD, message: SPACE_SAFETY_ALERT_PUSH_BODY, payload: { space_id: SPACE } }],
    ]);
  });
});

// ─── O4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('O4 (guard, green at main too): every other queued push is still sent by the worker', () => {
  const OTHER_KEYS = Object.keys(SAFETY_ALERT_PUSH_BODY).filter((k) => k !== COMMUNITY_CRISIS_ALERT_KEY);
  it('the other safety keys are Roman\'s three and the photo key', () => {
    expect(OTHER_KEYS.sort()).toEqual(
      ['community_photo_safety', 'roman_crisis_reply', 'roman_eating_disorder_reply', 'roman_urgent_reply'].sort(),
    );
  });

  const ROWS: Array<[string, Record<string, unknown> | null]> = [
    ...OTHER_KEYS.map((k) => [`safety key ${k}`, { safetyAlert: k, alertId: `alert-${k}` }] as [string, Record<string, unknown>]),
    ['the photo safety alert\'s space copy', { safetyAlert: 'community_photo_safety', alertId: 'alert-space', spaceAlert: true }],
    ['a coach_alert push with no safetyAlert', null],
  ];
  it.each(ROWS)('%s: queued, then sent', async (_n, context) => {
    const w = staffAlertWorld({ at: DAY, staff: [STAFF_A] });
    await w.notifications.sendPush({
      user_id: STAFF_A,
      kind: NotificationKind.COACH_ALERT,
      body: 'Body',
      deep_link: 'tgp://coach/alerts',
      context: context as never,
      dedupe_key: `coach_alert:${String(context?.alertId ?? 'plain')}`,
    });
    await w.delivery.drain();
    expect(w.out.rows.map((r) => [r.status, r.result_code])).toEqual([['sent', 'sent']]);
    expect(expoOf(w)).toHaveBeenCalledTimes(1);
  });

  it('the money check: its row and push to the owner account are written, and the push is sent', async () => {
    const w = staffAlertWorld({ at: DAY, staff: [STAFF_A] });
    const cron = new ReconciliationDailyCron(
      stub({}),
      stub({}),
      w.notifications,
      stub({ user: { findFirst: jest.fn(async () => ({ id: STAFF_A })) } }),
    );
    const tally = { checked: 3, ok: 3, drift: 0, unknown: 0, failed: 0, stopped: null };
    const alerted = await (cron as unknown as { alertOwner(t: typeof tally, now: Date): Promise<boolean> }).alertOwner(tally, DAY);
    expect(alerted).toBe(true);
    expect(w.inbox.map((r) => [r.user_id, r.kind, (r.payload as Row).type])).toEqual([[STAFF_A, NotificationKind.COACH_ALERT, 'money_check']]);
    expect(w.out.rows.map((r) => [r.user_id, r.dedupe_key])).toEqual([[STAFF_A, 'money_daily:2026-06-02']]);
    await w.delivery.drain();
    expect(w.out.rows.map((r) => [r.status, r.result_code])).toEqual([['sent', 'sent']]);
    expect(expoOf(w)).toHaveBeenCalledTimes(1);
  });
});

// ─── O5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Notifications over rows put in by hand; every inbox read is the real method over the where Postgres would read. */
function storedRowWorld() {
  const rows: Row[] = [];
  const pick = (where: unknown) => rows.filter((r) => whereMatches(r, where));
  const db = {
    notification: {
      findFirst: jest.fn(async (a: { where: unknown }) => pick(a.where)[0] ?? null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async (a: { where: unknown; take?: number }) => pick(a.where).slice(0, a.take ?? rows.length)),
      count: jest.fn(async (a: { where: unknown }) => pick(a.where).length),
      update: jest.fn(async (a: { where: { id: string }; data: Row }) => Object.assign(rows.find((r) => r.id === a.where.id)!, a.data)),
      updateMany: jest.fn(async (a: { where: unknown; data: Row }) => {
        const hit = pick(a.where);
        hit.forEach((r) => Object.assign(r, a.data));
        return { count: hit.length };
      }),
    },
    notificationPreferences: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ role: 'owner' })) },
    coachingSession: { findMany: jest.fn(async () => []) },
  };
  jest.spyOn(SubCoachScopeService.prototype, 'getAuthorizedClientIds').mockResolvedValue([]);
  jest.spyOn(SchedulingAccessService.prototype, 'sessionsStillTheirs').mockResolvedValue(stub({}));
  jest.spyOn(spaces, 'publicSpacesLedBy').mockResolvedValue([]);
  const notifications = new NotificationsService(stub(db));
  /** The row in the shape main's alertStaff writes (community-safety.service.ts:337-350), not written through it. */
  const store = (user_id: string, n: number) => {
    const row: Row = {
      id: `n-${n}`,
      user_id,
      kind: NotificationKind.COACH_ALERT,
      body: SAFETY_ALERT_INBOX_BODY[COMMUNITY_CRISIS_ALERT_KEY],
      payload: {
        type: COMMUNITY_CRISIS_ALERT_KEY,
        title: COMMUNITY_CRISIS_ALERT_TITLE,
        severity: 'critical',
        surface: 'post_comment',
        poster_id: POSTER,
        row_id: 'row-1',
      },
      deep_link: null,
      channel: 'inapp',
      read_at: null,
      inbox_hidden: false,
      created_at: new Date(2026, 5, 2, 14, 0, 0, n),
    };
    rows.push(row);
    return row;
  };
  return { rows, notifications, store };
}

describe('O5 (guard, green at main too): a stored staff row lists, counts and marks read for its own recipient only', () => {
  const OTHER = '5a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6e';
  it('listed and counted unread for its recipient, and for nobody else', async () => {
    const w = storedRowWorld();
    const mine = w.store(STAFF_A, 1);
    expect((await w.notifications.listNotifications(STAFF_A, {})).items.map((r: { id: string }) => r.id)).toEqual([mine.id]);
    expect((await w.notifications.listNotifications(STAFF_A, {})).unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(STAFF_A)).toBe(1);
    for (const someone of [STAFF_B, OTHER]) {
      expect((await w.notifications.listNotifications(someone, {})).items).toEqual([]);
      expect(await w.notifications.getUnreadCount(someone)).toBe(0);
    }
  });

  it('markRead and markAllRead reach it for its recipient; another account gets a 404 and leaves it unread', async () => {
    const w = storedRowWorld();
    const mine = w.store(STAFF_A, 1);
    const theirs = w.store(STAFF_B, 2);
    await expect(w.notifications.markRead(String(theirs.id), STAFF_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(theirs.read_at).toBeNull();
    await w.notifications.markRead(String(mine.id), STAFF_A);
    expect(mine.read_at).toBeInstanceOf(Date);
    expect(await w.notifications.getUnreadCount(STAFF_A)).toBe(0);
    expect(await w.notifications.markAllRead(STAFF_B)).toEqual({ updated: 1 });
    expect(theirs.read_at).toBeInstanceOf(Date);
    expect(await w.notifications.markAllRead(OTHER)).toEqual({ updated: 0 });
  });
});

// The safety service the table builds is the one under test (a guard against a world that bypasses it).
it('the world drives the real CommunitySafetyService', () => {
  expect(world().safety).toBeInstanceOf(CommunitySafetyService);
});
