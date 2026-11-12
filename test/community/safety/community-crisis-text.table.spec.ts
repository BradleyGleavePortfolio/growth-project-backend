/**
 * CRISIS-TEXT-BE (agent 203, owner #200-S1 op 1): one table over the 8 community writes that store text a member
 * typed (every call site of the word list). A text Roman's crisis check marks emergency or self_harm, in any field,
 * gives the poster's own answer `crisis_flag: true` and pages staff once for that write; anything else gives neither.
 *
 * Sample messages are stored ROT13-encoded (as community-content-filter.ts stores its terms) and are described,
 * never quoted. Rows run the real services, the real word list, the real classifier and the real notifications stack.
 */
import { randomUUID } from 'crypto';
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import * as photoCheck from '../../../src/community/images/community-photo-check';
import { classifySafety } from '../../../src/roman/guardrails/safety-router';
import { COMMUNITY_CRISIS_ALERT_KEY, SAFETY_ALERT_PUSH_BODY } from '../../../src/notifications/push/lock-screen-copy';
import { muteAllStops } from '../../../src/notifications/push/push-preferences';
import {
  stub,
  SELF_HARM,
  EMERGENCY,
  ORDINARY,
  GYM_SUPPLEMENT,
  GYM_ACTIVITY,
  URGENT,
  EATING,
  REFUSED_TERM,
  REFUSED_MATCH,
  REFUSED_ORDINARY,
  NIGHT,
  STAFF_A,
  STAFF_B,
  POSTER,
  MEMBER,
  WS,
  SPACE,
  POSTER_NAME,
  type Row,
  type WorldOptions,
  world,
  type World,
  poster,
  answer,
  settled,
  pushesOf,
  PATHS,
  eachPath,
  eachKeyed,
  FIELDS,
  asSent,
} from './crisis-text-world';

const SWITCH = 'COMMUNITY_CRISIS_CHECK_ENABLED';
beforeEach(() => {
  delete process.env[SWITCH];
  delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env[SWITCH];
});

const expectOneAlertEach = (w: World, surface: string) => {
  expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
  expect(w.inbox.every((r) => r.kind === NotificationKind.COACH_ALERT && r.channel === 'inapp')).toBe(true);
  expect(w.inbox.every((r) => (r.payload as Row).surface === surface)).toBe(true);
  expect(pushesOf(w).map((p) => p.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
  // FIX-1232R1 (#203-E21 "Op 1: normal push"): the owner overruled the urgent page; the push is a normal one.
  expect(pushesOf(w).every((p) => p.urgent === false && p.kind === NotificationKind.COACH_ALERT)).toBe(true);
};
const expectNoAlert = (w: World) => {
  expect(w.inbox).toEqual([]);
  expect(pushesOf(w)).toEqual([]);
};

// ─── The samples are what they say ───────────────────────────────────────────────────────

describe('the samples', () => {
  it.each([
    ['the self-harm sample', SELF_HARM, 'self_harm'],
    ['the emergency sample', EMERGENCY, 'emergency'],
    ['the urgent-symptoms sample', URGENT, 'urgent_symptoms'],
    ['the eating-disorder sample', EATING, 'eating_disorder_risk'],
  ])('%s has its class', (_n, text, cls) => expect(classifySafety(text).class).toBe(cls));

  it.each([
    ['supplement talk', GYM_SUPPLEMENT],
    ['activity talk', GYM_ACTIVITY],
    ['ordinary chat', ORDINARY],
  ])('%s is not a crisis class', (_n, text) => {
    expect(['emergency', 'self_harm']).not.toContain(classifySafety(text).class);
  });

  it('the refused samples are refused by the word list and the crisis sample still matches', async () => {
    const w = world();
    expect(() => w.safety.screenText('dm', POSTER, [REFUSED_ORDINARY])).toThrow(UnprocessableEntityException);
    expect(['emergency', 'self_harm']).toContain(classifySafety(REFUSED_MATCH).class);
  });
});

// ─── A. Every path ───────────────────────────────────────────────────────────────────────

describe('A. a matching text is stored and pages staff once; an ordinary text is untouched', () => {
  it.each(eachPath)('%s: a match is stored, the answer has the flag, one row and one normal push per recipient', async (_n, p) => {
    const w = world();
    const before = p.stored(w);
    const a = await p.write(w, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expect(p.stored(w)).toBeGreaterThan(before);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachPath)('%s: the emergency class pages too', async (_n, p) => {
    const w = world();
    const a = await p.write(w, EMERGENCY);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(FIELDS)('%s alone is enough', async (_n, p, f) => {
    const w = world();
    const a = await f.write(w, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachPath)('%s: an ordinary text gets no field, no row, no push', async (_n, p) => {
    const w = world();
    const a = await p.write(w, ORDINARY);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it.each(eachPath)('%s: the answer is the ordinary answer plus the one key', async (_n, p) => {
    const ordinary = await p.write(world(), ORDINARY);
    const matching = await p.write(world(), SELF_HARM);
    expect(Object.keys(matching).sort()).toEqual([...Object.keys(ordinary), 'crisis_flag'].sort());
  });
});

// ─── B. Negatives by kind ────────────────────────────────────────────────────────────────

describe('B. negatives by kind: no flag and no alert', () => {
  const KINDS = [
    ['supplement talk', GYM_SUPPLEMENT],
    ['activity talk', GYM_ACTIVITY],
    ['urgent symptoms', URGENT],
    ['eating disorder risk', EATING],
  ] as const;
  const table = PATHS.flatMap((p) => KINDS.map(([kind, text]) => [p.id, kind, p, text] as const));
  it.each(table)('%s, %s', async (_n, _k, p, text) => {
    const w = world();
    const a = await p.write(w, text);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });
});

// ─── C. Who sees it ──────────────────────────────────────────────────────────────────────

describe('C. the field exists only on the write\'s own answer', () => {
  it.each(eachPath)('%s: the stored row, the realtime event and the push to other members carry no field and no flag', async (_n, p) => {
    const w = world();
    await p.write(w, SELF_HARM);
    await settled();
    const elsewhere = JSON.stringify({
      rows: [...w.messages.values(), ...w.postRows.values()],
      realtime: w.realtime.broadcastCommunityEvent.mock.calls,
      member: w.memberPush.sendCommunityPush.mock.calls,
    });
    expect(elsewhere).not.toContain('crisis_flag');
  });

  it('S1: GET and list for that row equal an ordinary row, the poster reading too', async () => {
    const w = world();
    jest.spyOn(w.safety, 'filterBlocked').mockImplementation(async (_v: string, rows: unknown[]) => rows as never);
    jest.spyOn(w.safety, 'assertVisibleTo').mockResolvedValue(undefined);
    const sent = answer(await w.chat.send(poster, SPACE, SELF_HARM));
    const id = (sent.message as Row).id as string;
    const one = answer(await w.chat.getOne(poster, id));
    expect(one).not.toHaveProperty('crisis_flag');
    expect(one.message).not.toHaveProperty('crisis_flag');
    const list = answer(await w.chat.list(poster, SPACE, {}));
    expect((list.messages as Row[]).map((m) => m.id)).toEqual([id]);
    expect(JSON.stringify(list)).not.toContain('crisis_flag');
    expect(Object.keys(one)).toEqual(['message']);
  });

  it('crisis_flag is written only by the safety service and let through only by the error allowlist', () => {
    const SRC = join(__dirname, '../../../src');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    const holders = walk(SRC)
      .filter((f) => !/\.spec\.ts$/.test(f) && readFileSync(f, 'utf8').includes('crisis_flag'))
      .map((f) => relative(SRC, f))
      .sort();
    // Each write's return type names the key; no row view, DTO, schema, realtime or push file does.
    expect(holders).toEqual(
      [
        'community/challenges/community-challenges.service.ts',
        'community/community.service.ts',
        'community/dms/community-dms.service.ts',
        'community/messages/community-messages.service.ts',
        'community/posts/community-posts.service.ts',
        'community/safety/community-safety.service.ts',
        'filters/error-details.ts',
      ].sort(),
    );
  });
});

// ─── D. Send once ────────────────────────────────────────────────────────────────────────

describe('D. send once', () => {
  it.each(eachKeyed)('%s: the same key twice answers the field again and pages once', async (_n, p) => {
    const w = world();
    const key = randomUUID();
    const first = await p.write(w, SELF_HARM, key);
    const again = await p.write(w, SELF_HARM, key);
    await settled();
    expect(first.crisis_flag).toBe(true);
    expect(again.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachKeyed)('%s: a race that lands on replayed is the same', async (_n, p) => {
    const w = world();
    w.race.landed = { title: SELF_HARM, body: p.surface === 'post' ? ORDINARY : SELF_HARM };
    const a = await p.write(w, SELF_HARM, randomUUID());
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  // FIX-1232R1 (#203-E21): a second unkeyed send is a new row for every staff account, but the same poster's
  // second match that UTC day is no second push (the daily cap, community_crisis:<poster>:<day>).
  it.each(eachKeyed)('%s: no key, a second send is a new row for each staff account and no second push', async (_n, p) => {
    const w = world();
    await p.write(w, SELF_HARM, null);
    await p.write(w, SELF_HARM, null);
    await settled();
    expect(w.inbox).toHaveLength(4);
    expect(pushesOf(w)).toHaveLength(2);
  });
});

// ─── E. Edits ────────────────────────────────────────────────────────────────────────────

describe('E. edits', () => {
  const editChat = async (w: World, from: string, to: string) => {
    const m = w.stamp({ body: from });
    return answer(await w.chat.edit(poster, String(m.id), to));
  };
  const editPost = async (w: World, from: [string, string], to: { title?: string; body?: string }) =>
    answer(await w.posts.edit(poster, w.seedPost(from[0], from[1]), to));

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: ordinary to matching: field and one alert', async (_n, edit) => {
    const w = world();
    const a = await edit(w, ORDINARY, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expect(w.inbox).toHaveLength(2);
  });

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: matching to matching: field, no new alert', async (_n, edit) => {
    const w = world();
    const a = await edit(w, SELF_HARM, EMERGENCY);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: matching to ordinary: neither', async (_n, edit) => {
    const w = world();
    const a = await edit(w, SELF_HARM, ORDINARY);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it('S4: a title-only edit on a matching body carries the field and pages nobody new', async () => {
    const w = world();
    const a = await editPost(w, [ORDINARY, SELF_HARM], { title: 'Monday crew' });
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  it('S4: the word list still reads only what was sent: an untouched refused body does not refuse a title edit', async () => {
    const w = world();
    const a = await editPost(w, ['Monday', `${ORDINARY} ${REFUSED_TERM}`], { title: 'Tuesday' });
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
  });

  it('S2: the edit window refuses after the word list, and a window refusal carries neither', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, created_at: new Date(Date.now() - 6 * 60_000) });
    await expect(w.chat.edit(poster, String(m.id), SELF_HARM)).rejects.toMatchObject({
      response: { code: 'community.message.edit_window_closed' },
    });
    await settled();
    expect(JSON.stringify([...w.messages.values()])).not.toContain('crisis_flag');
    expectNoAlert(w);
  });

  it('S2: not the author: refused, neither', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, sender_id: MEMBER });
    await expect(w.chat.edit(poster, String(m.id), SELF_HARM)).rejects.toMatchObject({
      response: { code: 'community.message.not_author' },
    });
    await settled();
    expectNoAlert(w);
  });

  it('S4: not the author: refused, neither', async () => {
    const w = world();
    const id = w.seedPost(ORDINARY, ORDINARY);
    w.postRows.get(id)!.author_id = MEMBER;
    await expect(w.posts.edit(poster, id, { body: SELF_HARM })).rejects.toMatchObject({
      response: { code: 'community.post.not_author' },
    });
    await settled();
    expectNoAlert(w);
  });

  it('S2: word list refusal outside the window is main\'s order: 422 with the flag and one alert', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, created_at: new Date(Date.now() - 6 * 60_000) });
    await expect(w.chat.edit(poster, String(m.id), REFUSED_MATCH)).rejects.toMatchObject({
      response: { code: 'community.content.rejected', crisis_flag: true },
    });
    await settled();
    expect(w.inbox).toHaveLength(2);
  });
});


describe('F. refused text stays refused', () => {
  it.each(eachPath)('%s: a matching text the word list refuses: 422, nothing stored, the flag beside the keys, one alert, no row id', async (_n, p) => {
    const w = world();
    const before = p.stored(w);
    let caught: unknown;
    await p.write(w, REFUSED_MATCH).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    const { status, body } = asSent(caught);
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: 'community.content.rejected', error: 'content_rejected', crisis_flag: true });
    expect(typeof body.message).toBe('string');
    expect(p.stored(w)).toBe(before);
    expectOneAlertEach(w, p.surface);
    expect(w.inbox.every((r) => !('row_id' in (r.payload as Row)) && (r.payload as Row).poster_id === POSTER)).toBe(true);
  });

  it.each(eachPath)('%s: an ordinary refused text is today\'s 422, no flag, no alert', async (_n, p) => {
    const w = world();
    let caught: unknown;
    await p.write(w, REFUSED_ORDINARY).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    const { status, body } = asSent(caught);
    expect(status).toBe(422);
    expect(body.code).toBe('community.content.rejected');
    expect(body).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  describe('a photo refused on a matching caption', () => {
    const ON = { FEATURE_COMMUNITY_IMAGES: 'true', VOICE_KEY_SIGNING_SECRET: 'crisis-test-secret' };
    beforeEach(() => Object.assign(process.env, ON));
    afterEach(() => {
      for (const k of Object.keys(ON)) delete process.env[k];
    });
    const key = (w: World) => {
      // The real key check is covered by community-photo-check.e2e.spec.ts; this table reaches the refusal.
      return jest.requireActual<typeof import('../../../src/community/images/community-image-store')>('../../../src/community/images/community-image-store').mintImageKey(POSTER, SPACE);
    };
    it.each([
      ['PHOTO_NOT_ALLOWED', 'invalid_image'],
      ['CAPTION_NOT_ALLOWED', 'invalid_caption'],
    ])('S1 %s: stays a 422 with its own code, the flag beside it, one alert; nothing stored', async (code, error) => {
      const w = world();
      const coachAlert = jest.fn(async () => undefined);
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockImplementation(async (..._a) => {
        const onSelfHarm = _a[6];
        await onSelfHarm?.();
        throw new UnprocessableEntityException({ error, code });
      });
      jest.spyOn(w.chat as never, 'alertCoachOfPhotoSafety' as never).mockImplementation(coachAlert as never);
      let caught: unknown;
      await w.chat
        .send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 })
        .catch((e: unknown) => {
          caught = e;
        });
      await settled();
      const { status, body } = asSent(caught);
      expect(status).toBe(422);
      expect(body).toMatchObject({ code, crisis_flag: true });
      expect(w.messages.size).toBe(0);
      expect(w.inbox).toHaveLength(2);
      expect(coachAlert).toHaveBeenCalledTimes(1);
    });

    it('S2: a refused caption edit with a matching text does the same', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertCaptionAllowed').mockImplementation(async () => {
        throw new UnprocessableEntityException({ error: 'invalid_caption', code: 'CAPTION_NOT_ALLOWED' });
      });
      const m = w.stamp({ body: ORDINARY, kind: 'image' });
      let caught: unknown;
      await w.chat.edit(poster, String(m.id), SELF_HARM).catch((e: unknown) => {
        caught = e;
      });
      await settled();
      expect(asSent(caught).body).toMatchObject({ code: 'CAPTION_NOT_ALLOWED', crisis_flag: true });
      expect(w.messages.get(String(m.id))!.body).toBe(ORDINARY);
      expect(w.inbox).toHaveLength(2);
    });

    it('S1: the photo check being unavailable is not a refusal: 503, no field, no alert', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockImplementation(async () => {
        throw new ServiceUnavailableException({ error: 'unavailable', code: 'PHOTO_CHECK_UNAVAILABLE' });
      });
      let caught: unknown;
      await w.chat
        .send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 })
        .catch((e: unknown) => {
          caught = e;
        });
      await settled();
      expect(asSent(caught).status).toBe(503);
      expect(asSent(caught).body).not.toHaveProperty('crisis_flag');
      expectNoAlert(w);
    });

    it('S1: a clean photo with a matching caption is stored with the field and pages once', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockResolvedValue(undefined);
      const a = answer(await w.chat.send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 }));
      await settled();
      expect(a.crisis_flag).toBe(true);
      expect(w.inbox).toHaveLength(2);
    });
  });
});

// ─── G. Alert content ────────────────────────────────────────────────────────────────────

describe('G. the alert', () => {
  const words = (text: string) => text.toLowerCase().split(/\W+/).filter((t) => t.length >= 4);
  it.each(eachPath)('%s: no row, push or payload holds a word of the text, the pattern, the class or a name', async (_n, p) => {
    const w = world();
    await p.write(w, EMERGENCY);
    await settled();
    const rendered = JSON.stringify({ inbox: w.inbox, pushes: pushesOf(w).map((r) => ({ title: r.title, body: r.body, data: r.data, context: r.context })) }).toLowerCase();
    for (const t of words(EMERGENCY)) expect(rendered).not.toContain(t);
    expect(rendered).not.toContain(classifySafety(EMERGENCY).matched!.toLowerCase());
    expect(rendered).not.toContain('self_harm');
    expect(rendered).not.toContain('emergency');
    expect(rendered).not.toContain(POSTER_NAME.split(' ')[0].toLowerCase());
    expect(rendered).not.toContain(POSTER_NAME.split(' ')[1].toLowerCase());
  });

  it('the row and push carry the fixed words and ids only', async () => {
    const w = world();
    const sent = await w.posts.addComment(poster, w.POST, SELF_HARM);
    await settled();
    expect(w.inbox[0].body).toBe('Urgent safety alert in the community.');
    // FIX-1232R1 B1: one key more, `type`, which the inbox rule lists the row by (current-coach-inbox.ts).
    expect(w.inbox[0].payload).toEqual({
      type: 'community_crisis_text',
      title: 'Safety alert',
      severity: 'critical',
      surface: 'post_comment',
      poster_id: POSTER,
      row_id: sent.comment.id,
    });
    expect(w.inbox[0].deep_link).toBeUndefined();
    // Operator ruling 22:3x (#203-E15): a normal push no longer says "Urgent".
    expect(pushesOf(w)[0].body).toBe('Safety alert in the community. Open TGP to see it.');
    // No alertId, so no tap to an alert that does not exist: the push opens the inbox like any other.
    expect(pushesOf(w)[0].data).not.toHaveProperty('actionParams');
    expect(pushesOf(w)[0].data).not.toMatchObject({ actionScreen: 'CoachSafetyAlert' });
    expect(w.inbox[0].payload).not.toHaveProperty('actionScreen');
    expect(pushesOf(w)[0].context).toEqual({ safetyAlert: 'community_crisis_text' });
  });

  // FIX-1232R1 (#203-E21 "Op 1: normal push"): the owner overruled both cases below as they were (Mute all at night
  // went now; two matches in a minute were two pushes).
  it('Mute all on and inside 21:00-08:00: the rows are written and Mute all stops the push', async () => {
    const w = world({ at: NIGHT, prefs: { muted: true } });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox).toHaveLength(2);
    expect(pushesOf(w)).toHaveLength(0);
  });

  it('two matches in one minute are two rows and one push (the daily cap; rows never fold)', async () => {
    const w = world({ owners: [STAFF_A] });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox).toHaveLength(2);
    expect(pushesOf(w)).toHaveLength(1);
  });

  it('the poster\'s coach gets no CoachAlert: this path has no coach alert service', async () => {
    const w = world();
    const moduleGets: unknown[] = [];
    Object.defineProperty(w.safety, 'moduleRef', {
      value: { get: (t: unknown) => (moduleGets.push(t), w.notifications) },
    });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(moduleGets).toEqual([NotificationsService]);
    expect(w.inbox.map((r) => r.user_id)).not.toContain('coach-1');
  });

  it('a poster who is staff gets no copy', async () => {
    const w = world({ owners: [POSTER, STAFF_A] });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox.map((r) => r.user_id)).toEqual([STAFF_A]);
    expect(pushesOf(w).map((r) => r.user_id)).toEqual([STAFF_A]);
  });
});

// ─── H. Failure ──────────────────────────────────────────────────────────────────────────

describe('H. the alert never fails the write', () => {
  const logs = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const ALERT_LINE = /^community\.crisis_alert outcome=/;
  it.each([
    ['createNotification throws', { failNotification: true }],
    ['sendPush throws', { failPush: true }],
    ['no staff account', { owners: [] }],
  ])('%s: the write answers with the field; one closed-code log line, no text', async (_n, o) => {
    const log = logs();
    const w = world(o as WorldOptions);
    const a = answer(await w.dms.send(poster, WS, MEMBER, SELF_HARM));
    await settled();
    expect(a.crisis_flag).toBe(true);
    const lines = log.mock.calls.map(([m]) => String(m)).filter((m) => ALERT_LINE.test(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SELF_HARM.split(' ')[1]);
  });
});

// ─── I. Both fields, the switch ──────────────────────────────────────────────────────────

describe('I. together with High alert, and the switch', () => {
  it('a coach\'s High alert send that matches has both fields', async () => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    const w = world();
    const spacePush = {
      highAlertAllowance: jest.fn(async () => ({ used_today: 0, limit: 3, reach: 7 })),
      markHighAlert: jest.fn(async () => undefined),
    };
    Object.assign(w.chat as unknown as Row, { spacePush });
    const coach = stub<User>({ id: POSTER, role: 'coach' });
    const a = answer(await w.chat.send(coach, SPACE, SELF_HARM, undefined, undefined, undefined, true));
    await settled();
    expect(a.high_alert_reach).toBe(7);
    expect(a.crisis_flag).toBe(true);
    expect(w.inbox).toHaveLength(2);
  });

  it.each(eachPath)('%s: switch "false": a match reads as main', async (_n, p) => {
    process.env[SWITCH] = 'false';
    const w = world();
    const a = await p.write(w, SELF_HARM);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it.each(eachPath)('%s: switch "false": a refused text is today\'s 422 with no flag', async (_n, p) => {
    process.env[SWITCH] = 'false';
    const w = world();
    let caught: unknown;
    await p.write(w, REFUSED_MATCH).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    expect(asSent(caught).body).not.toHaveProperty('crisis_flag');
    expect(asSent(caught).status).toBe(422);
    expectNoAlert(w);
  });

  it('any other value leaves it on', () => {
    process.env[SWITCH] = 'true';
    const w = world();
    expect(w.safety.screenText('dm', POSTER, [SELF_HARM]).flag).toBe(true);
    process.env[SWITCH] = '0';
    expect(w.safety.screenText('dm', POSTER, [SELF_HARM]).flag).toBe(true);
  });
});

// ─── J. Speed ────────────────────────────────────────────────────────────────────────────

describe('J. speed', () => {
  it('classifySafety on a 20,000-character ordinary body stays under the 100 ms planning number', () => {
    const body = (`${ORDINARY}. `).repeat(Math.ceil(20_000 / (ORDINARY.length + 2))).slice(0, 20_000);
    const runs = 5;
    let worst = 0;
    for (let i = 0; i < runs; i += 1) {
      const t0 = process.hrtime.bigint();
      expect(classifySafety(body).class).toBe('normal');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      worst = Math.max(worst, ms);
    }
    process.stdout.write(`CRISIS-TEXT-BE J: classifySafety 20000 chars worst of ${runs}: ${worst.toFixed(2)} ms\n`);
    expect(worst).toBeLessThan(100);
  });
});

// ─── FIX-1232R1 (agent 203): the owner's normal push (#203-E21), the lost page, the unlogged page ─────────────────

describe('FIX-1232R1 K4. the push opens the notification center (green at the head too)', () => {
  it('the tap data is actionScreen NotificationCenter with no deep link, no params and no alert tap', async () => {
    const w = world();
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    for (const r of pushesOf(w)) {
      expect(r.data).toMatchObject({ actionScreen: 'NotificationCenter' });
      expect(r.data).not.toHaveProperty('deepLink');
      expect(r.data).not.toHaveProperty('actionParams');
    }
  });
});

describe('FIX-1232R1 P. a normal push: Mute all, quiet hours, the daily cap', () => {
  it('P2: Mute all on: every row is written and no push is queued', async () => {
    const w = world({ prefs: { muted: true } });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
    expect(pushesOf(w)).toEqual([]);
  });

  it('P2: a push queued while unmuted is dropped at send once the account mutes (preference-off)', async () => {
    const w = world();
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(pushesOf(w)).toHaveLength(2);
    for (const o of [STAFF_A, STAFF_B]) w.out.prefs[o].muted = true;
    await w.delivery.drain();
    expect(pushesOf(w).map((r) => [r.status, r.result_code])).toEqual([
      ['dropped', 'preference-off'],
      ['dropped', 'preference-off'],
    ]);
  });

  it('P3: 23:30 New York, Mute all off: queued for 08:00 local as quiet_hours; a send at 23:45 defers it again', async () => {
    const w = world({ at: NIGHT });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    const MORNING = new Date('2026-06-03T12:00:00Z'); // 08:00 in New York (EDT)
    expect(pushesOf(w).map((r) => [r.not_before.toISOString(), r.deferred_reason])).toEqual([
      [MORNING.toISOString(), 'quiet_hours'],
      [MORNING.toISOString(), 'quiet_hours'],
    ]);
    w.clock.at = new Date(NIGHT.getTime() + 15 * 60_000);
    for (const r of pushesOf(w)) r.not_before = w.clock.at; // due now, as if a sweep had picked it up at 23:45
    await w.delivery.drain();
    expect(pushesOf(w).map((r) => [r.status, r.not_before.toISOString(), r.sent_at])).toEqual([
      ['pending', MORNING.toISOString(), null],
      ['pending', MORNING.toISOString(), null],
    ]);
  });

  describe('P4: at most one push per staff account per poster per UTC day; every match writes its rows', () => {
    const REAL = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
    afterEach(() => jest.useRealTimers());
    it('two matches on one UTC day on two surfaces, a second poster that day, then the next UTC day', async () => {
      jest.useFakeTimers({ now: new Date('2026-06-02T10:00:00Z'), doNotFake: [...REAL] });
      const w = world();
      const member = stub<User>({ id: MEMBER, role: 'student', coach_id: 'coach-1' });
      const perStaff = () => [STAFF_A, STAFF_B].map((s) => [w.inbox.filter((r) => r.user_id === s).length, pushesOf(w).filter((r) => r.user_id === s).length]);
      await w.dms.send(poster, WS, MEMBER, SELF_HARM);
      await w.posts.addComment(poster, w.POST, EMERGENCY);
      await settled();
      expect(perStaff()).toEqual([[2, 1], [2, 1]]);
      await w.dms.send(member, WS, POSTER, SELF_HARM);
      await settled();
      expect(perStaff()).toEqual([[3, 2], [3, 2]]);
      jest.setSystemTime(new Date('2026-06-03T00:05:00Z'));
      await w.dms.send(poster, WS, MEMBER, SELF_HARM);
      await settled();
      expect(perStaff()).toEqual([[4, 3], [4, 3]]);
      expect(pushesOf(w).map((r) => r.dedupe_key).sort()).toEqual(
        [
          `community_crisis:${POSTER}:2026-06-02`,
          `community_crisis:${POSTER}:2026-06-02`,
          `community_crisis:${MEMBER}:2026-06-02`,
          `community_crisis:${MEMBER}:2026-06-02`,
          `community_crisis:${POSTER}:2026-06-03`,
          `community_crisis:${POSTER}:2026-06-03`,
        ].sort(),
      );
    });
  });

  // P5: one row per SAFETY_ALERT_PUSH_BODY key; every Roman key, the photo key and the space copy keep the pass.
  it.each(Object.keys(SAFETY_ALERT_PUSH_BODY).map((k) => [k, k !== COMMUNITY_CRISIS_ALERT_KEY] as const))(
    'P5: safety key %s passes Mute all: %s',
    (key, passes) => {
      expect(muteAllStops({ muted: true }, NotificationKind.COACH_ALERT, 'push', { safetyAlert: key })).toBe(!passes);
    },
  );

  it('P6 (green at the head too; Found, not fixed): a staff account with no usable zone gets the push at once', async () => {
    const w = world({ at: NIGHT, prefs: { timezone: null } });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(pushesOf(w).map((r) => [r.not_before.getTime(), r.deferred_reason])).toEqual([
      [NIGHT.getTime(), null],
      [NIGHT.getTime(), null],
    ]);
  });
});

describe('FIX-1232R1 L1. a stored write pages staff before any later step can throw', () => {
  const coach = stub<User>({ id: POSTER, role: 'coach' });
  const L1: Array<[string, (w: World) => void, (w: World, key: string) => Promise<unknown>]> = [
    [
      'S1, markHighAlert throws',
      (w) => {
        process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
        const spacePush = {
          highAlertAllowance: jest.fn(async () => ({ used_today: 0, limit: 3, reach: 7 })),
          markHighAlert: jest.fn(async () => {
            throw new Error('mark failed');
          }),
        };
        Object.assign(w.chat as unknown as Row, { spacePush });
      },
      (w, key) => w.chat.send(coach, SPACE, SELF_HARM, undefined, undefined, undefined, true, key),
    ],
    [
      'S1, markCohortClientMessagesReplied throws for a coach sender',
      (w) => {
        w.messageRepo.markCohortClientMessagesReplied = jest.fn(async () => {
          throw new Error('stamp failed');
        });
      },
      (w, key) => w.chat.send(coach, SPACE, SELF_HARM, undefined, undefined, undefined, undefined, key),
    ],
    [
      'S5, readersOf throws',
      (w) => {
        w.postRows.get(w.POST)!.author_id = MEMBER;
        w.access.readersOf = jest.fn(async () => {
          throw new Error('readers failed');
        });
      },
      (w, key) => w.posts.addComment(poster, w.POST, SELF_HARM, key),
    ],
  ];
  it.each(L1)('%s: the row is stored, the request errors as today, staff got their rows; a keyed resend replays and pages nobody again', async (_n, arrange, write) => {
    const w = world();
    arrange(w);
    const key = randomUUID();
    await expect(write(w, key)).rejects.toThrow();
    await settled();
    expect(w.messages.size).toBe(1);
    expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
    const again = answer(await write(w, key).catch(() => ({ resend: 'failed' })));
    await settled();
    expect(again.crisis_flag).toBe(true);
    expect(w.messages.size).toBe(1);
    expect(w.inbox).toHaveLength(2);
  });
});

describe('FIX-1232R1 G1-G2. a page that reached nobody is one closed-code line', () => {
  const NONE = /^community\.crisis_alert outcome=none_delivered/;
  const linesOf = (log: jest.SpyInstance) => log.mock.calls.map(([m]) => String(m)).filter((m) => NONE.test(m));
  it('G1: every staff account has coach_alert in-app and push off: one line, by code and counts only', async () => {
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const w = world({ prefs: { coach_alert_inapp: false, coach_alert_push: false } });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox).toEqual([]);
    expect(pushesOf(w)).toEqual([]);
    expect(linesOf(log)).toEqual(['community.crisis_alert outcome=none_delivered staff=2']);
  });

  it.each([
    ['a row written, every push muted', { prefs: { muted: true } }, 1],
    ['a row written, every push deferred to 08:00', { at: NIGHT }, 1],
    ['in-app off, the second push a duplicate', { prefs: { coach_alert_inapp: false } }, 2],
  ] as const)('G2 (green at the head too): %s: no such line', async (_n, o, sends) => {
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const w = world(o as WorldOptions);
    for (let i = 0; i < sends; i += 1) await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(linesOf(log)).toEqual([]);
  });
});
