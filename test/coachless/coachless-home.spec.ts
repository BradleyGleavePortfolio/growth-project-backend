// A1-COACHLESS — coachless Home (banner + featured offer), the scripted Roman
// card rules (accepting-only, frequency cap, persisted "Not now"), the owner
// featured-coach config (server-validated references, audited) and the
// FEATURE_COACHLESS_HOME kill switch.
import 'reflect-metadata';
import { addRowCode, addUser } from '../support/attach-fixture';
import { CoachlessFeatureGuard } from '../../src/coachless/coachless-feature.guard';
import { decideRomanCard, NOT_NOW_DEBOUNCE_MS } from '../../src/coachless/coachless-prompt.service';
import { DEFAULT_COACHLESS_BANNER_TITLE } from '../../src/coachless/featured-coach.service';
import {
  COACH_A,
  COACH_B,
  PKG_A,
  PKG_B,
  buildCoachless,
  featuredRow,
  pkg,
} from './coachless-fixture';

const STUDENT = { id: 'stu', role: 'student', coach_id: null };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function withOffer(over: Record<string, unknown> = {}) {
  const ctx = await buildCoachless();
  ctx.db.state.featuredCoachConfig.push(featuredRow(over));
  addUser(ctx.db, { id: 'stu' });
  return ctx;
}

describe('GET /coachless/home', () => {
  it('no owner config: neutral banner title only, no offer, no Roman card (coachless is still complete)', async () => {
    const { home, db } = await buildCoachless();
    addUser(db, { id: 'stu' });
    expect(await home.home(STUDENT)).toEqual({
      eligible: true,
      coach_attached: false,
      banner: { title: DEFAULT_COACHLESS_BANNER_TITLE, offer_text: null, code: null },
      roman_card: null,
      roman_card_hidden_reason: 'offer_off',
      featured_coach: null,
    });
  });

  it('featured coach accepting: banner carries the server offer text and code; Roman card shows the server copy', async () => {
    const { home } = await withOffer();
    const r = await home.home(STUDENT);
    expect(r.banner).toEqual({
      title: 'Enter coach code for coaching and programs',
      offer_text: '$49/mo with our top coach; use code GP-BBBBBB',
      code: 'GP-BBBBBB',
    });
    expect(r.roman_card).toEqual({ text: featuredRow().roman_pitch_text, code: 'GP-BBBBBB' });
    expect(r.featured_coach).toMatchObject({
      name: 'Coach B',
      photo_url: 'https://cdn.example.test/b.jpg',
      package: { id: PKG_B },
    });
  });

  it('the banner disappears once a coach is attached; coaches and owners never see it', async () => {
    const { home } = await withOffer();
    for (const u of [
      { id: 'stu', role: 'student', coach_id: COACH_A },
      { id: 'c', role: 'coach', coach_id: null },
      { id: 'o', role: 'owner', coach_id: null },
    ]) {
      const r = await home.home(u);
      expect(r).toMatchObject({
        eligible: false,
        banner: null,
        roman_card: null,
        featured_coach: null,
      });
    }
  });

  it.each([
    [
      'owner paused the offer',
      (db: any) => (db.state.featuredCoachConfig[0].accepting_clients = false),
    ],
    [
      'coach subscription canceled',
      (db: any) =>
        (db.state.coachSubscription.find((s: any) => s.coach_id === COACH_B).status = 'canceled'),
    ],
    [
      'code belongs to another coach',
      (db: any) => (db.state.featuredCoachConfig[0].code = 'GP-AAAAAA'),
    ],
    [
      'code revoked',
      (db: any) => {
        db.state.featuredCoachConfig[0].code = 'GP-ROWB99';
        addRowCode(db, { code: 'GP-ROWB99', coach_id: COACH_B, revoked: true });
      },
    ],
  ])(
    'not accepting (%s): offer line, code and Roman card are hidden; the code-entry banner stays',
    async (_l, mutate) => {
      const { home, db, featured } = await withOffer();
      mutate(db);
      featured.invalidate();
      const r = await home.home(STUDENT);
      expect(r.banner).toEqual({
        title: 'Enter coach code for coaching and programs',
        offer_text: null,
        code: null,
      });
      expect(r.roman_card).toBeNull();
      expect(r.roman_card_hidden_reason).toBe('not_accepting');
      expect(r.featured_coach).toBeNull();
    },
  );

  it('a package of another coach is never offered as the featured package', async () => {
    const { home } = await withOffer({ package_id: PKG_A });
    expect((await home.home(STUDENT)).featured_coach).toMatchObject({ package: null });
  });
});

describe('Roman card frequency rules', () => {
  const offer = {
    roman_enabled: true,
    roman_pitch_text: 'pitch',
    code: 'GP-BBBBBB',
    accepting_clients: true,
    roman_caps: { min_hours_between: 24, max_per_week: 3, snooze_days: 14, max_not_now: 2 },
  };
  const now = new Date('2026-10-05T12:00:00Z');
  const state = (o: Record<string, unknown> = {}) => ({
    roman_seen_count: 0,
    roman_window_started_at: null,
    roman_last_seen_at: null,
    roman_not_now_count: 0,
    roman_not_now_at: null,
    ...o,
  });

  it('shows on first visit and stays for the rest of the impression window', () => {
    expect(decideRomanCard(offer, null, now)).toEqual({ show: true });
    const seen = state({
      roman_seen_count: 3,
      roman_window_started_at: new Date(now.getTime() - 2 * DAY),
      roman_last_seen_at: new Date(now.getTime() - HOUR),
    });
    expect(decideRomanCard(offer, seen, now)).toEqual({ show: true });
  });

  it('weekly cap: no new impression after max_per_week in a rolling 7 days; resets after', () => {
    const capped = state({
      roman_seen_count: 3,
      roman_window_started_at: new Date(now.getTime() - 3 * DAY),
      roman_last_seen_at: new Date(now.getTime() - 25 * HOUR),
    });
    expect(decideRomanCard(offer, capped, now)).toEqual({ show: false, reason: 'weekly_cap' });
    const later = new Date(now.getTime() + 5 * DAY);
    expect(decideRomanCard(offer, capped, later)).toEqual({ show: true });
  });

  it('"Not now" snoozes for snooze_days, then the card may return; max_not_now hides it for good', () => {
    const once = state({ roman_not_now_count: 1, roman_not_now_at: new Date(now.getTime() - DAY) });
    expect(decideRomanCard(offer, once, now)).toEqual({ show: false, reason: 'snoozed' });
    expect(decideRomanCard(offer, once, new Date(now.getTime() + 14 * DAY))).toEqual({
      show: true,
    });
    const twice = state({
      roman_not_now_count: 2,
      roman_not_now_at: new Date(now.getTime() - 100 * DAY),
    });
    expect(decideRomanCard(offer, twice, now)).toEqual({ show: false, reason: 'not_now_final' });
  });

  it('never shows while the featured coach is not accepting or the owner switched Roman off', () => {
    expect(decideRomanCard({ ...offer, accepting_clients: false }, null, now)).toEqual({
      show: false,
      reason: 'not_accepting',
    });
    expect(decideRomanCard({ ...offer, roman_enabled: false }, null, now)).toEqual({
      show: false,
      reason: 'offer_off',
    });
    expect(decideRomanCard({ ...offer, roman_pitch_text: null }, null, now)).toEqual({
      show: false,
      reason: 'offer_off',
    });
  });

  it('recordSeen counts one impression per window even when called repeatedly', async () => {
    const { prompts, db } = await withOffer();
    const t0 = new Date('2026-10-05T08:00:00Z');
    await prompts.recordSeen('stu', offer.roman_caps, t0);
    await prompts.recordSeen('stu', offer.roman_caps, new Date(t0.getTime() + HOUR));
    expect(db.state.coachlessPromptState[0]).toMatchObject({ roman_seen_count: 1 });
    await prompts.recordSeen('stu', offer.roman_caps, new Date(t0.getTime() + 25 * HOUR));
    expect(db.state.coachlessPromptState[0]).toMatchObject({ roman_seen_count: 2 });
    await prompts.recordSeen('stu', offer.roman_caps, new Date(t0.getTime() + 8 * DAY));
    expect(db.state.coachlessPromptState[0]).toMatchObject({ roman_seen_count: 1 });
  });

  it('"Not now" persists server-side, a double tap counts once, and Home then hides the card', async () => {
    const { prompts, home, db } = await withOffer();
    const t0 = new Date();
    await prompts.recordNotNow('stu', t0);
    await prompts.recordNotNow('stu', new Date(t0.getTime() + NOT_NOW_DEBOUNCE_MS / 2));
    expect(db.state.coachlessPromptState[0]).toMatchObject({ roman_not_now_count: 1 });
    const r = await home.home(STUDENT);
    expect(r.roman_card).toBeNull();
    expect(r.roman_card_hidden_reason).toBe('snoozed');
    expect(r.banner?.offer_text).toBeTruthy(); // the banner itself is not nagging; it stays
  });
});

describe('featured-coach config (owner)', () => {
  const owner = { id: 'owner-1', email: 'owner@example.test' };
  const base = {
    coach_user_id: COACH_B,
    code: 'GP-BBBBBB',
    package_id: PKG_B,
    banner_title: null,
    offer_text: '$49/mo with our top coach; use code GP-BBBBBB',
    roman_pitch_text: 'pitch',
    accepting_clients: true,
    roman_enabled: true,
  };

  it('saves, audits in the same transaction and invalidates the cache', async () => {
    const { featured, audit, db } = await buildCoachless();
    expect((await featured.get()).configured).toBe(false); // cached "not configured"
    const r = await featured.update(owner, base);
    expect(r.resolved).toMatchObject({
      configured: true,
      accepting_clients: true,
      banner_title: DEFAULT_COACHLESS_BANNER_TITLE,
    });
    expect(audit.writeTx).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: 'featured_coach_config.updated', actorId: 'owner-1' }),
    );
    expect((await featured.get()).configured).toBe(true);
  });

  it('refuses a code of another coach, a non-coach, and a package the coach does not own', async () => {
    const { featured } = await buildCoachless();
    await expect(featured.update(owner, { ...base, code: 'GP-AAAAAA' })).rejects.toMatchObject({
      response: { code: 'featured_code_other_coach' },
    });
    await expect(
      featured.update(owner, { ...base, coach_user_id: 'nobody' }),
    ).rejects.toMatchObject({ response: { code: 'featured_coach_invalid' } });
    await expect(featured.update(owner, { ...base, package_id: PKG_A })).rejects.toMatchObject({
      response: { code: 'featured_package_invalid' },
    });
  });

  it('an unknown vanity code needs create_code_if_missing, which mints it for the featured coach', async () => {
    const { featured, db } = await buildCoachless();
    await expect(featured.update(owner, { ...base, code: 'GP-VANITY' })).rejects.toMatchObject({
      response: { code: 'featured_code_unknown' },
    });
    const r = await featured.update(owner, {
      ...base,
      code: 'GP-VANITY',
      create_code_if_missing: true,
    });
    expect(r.code_created).toBe(true);
    expect(db.state.inviteCode.find((c) => c.code === 'GP-VANITY')).toMatchObject({
      coach_id: COACH_B,
    });
    expect(r.resolved.accepting_clients).toBe(true);
  });

  it('lists every coach account with only the packages the PUT accepts (owner editor picker)', async () => {
    const { featured, db } = await buildCoachless();
    addUser(db, { id: 'stu-x' });
    addUser(db, { id: 'owner-1', role: 'owner' });
    db.state.user.push({
      id: 'coach-gone',
      email: 'gone@example.test',
      name: 'Gone',
      role: 'coach',
      coach_id: null,
      deleted_at: new Date(),
    });
    db.state.coachPackage.push(
      { ...pkg('pkg-b-off', COACH_B, 100), is_active: false },
      { ...pkg('pkg-b-arch', COACH_B, 200), archived_at: new Date() },
    );
    const { coaches } = await featured.listCandidates();
    expect(coaches.map((c) => c.id)).toEqual([COACH_A, COACH_B]);
    const b = coaches.find((c) => c.id === COACH_B);
    expect(b).toMatchObject({
      name: 'Coach B',
      email: `${COACH_B}@example.test`,
      business_name: 'B Training',
    });
    expect(b?.packages.map((p) => p.id)).toEqual([PKG_B]);
    expect(b?.packages[0]).not.toHaveProperty('coach_id');
    // Every listed package is one the PUT accepts for that coach.
    for (const c of coaches)
      for (const p of c.packages) expect(await featured.activePackageOf(p.id, c.id)).not.toBeNull();
  });

  it('caches the resolution: two reads inside the TTL hit the database once', async () => {
    const { featured, db } = await withOffer();
    const before = db.calls.filter((c) => c.model === 'featuredCoachConfig').length;
    await Promise.all([featured.get(), featured.get()]);
    await featured.get();
    expect(db.calls.filter((c) => c.model === 'featuredCoachConfig').length - before).toBe(1);
  });
});

describe('FEATURE_COACHLESS_HOME kill switch', () => {
  const saved = process.env.FEATURE_COACHLESS_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.FEATURE_COACHLESS_HOME;
    else process.env.FEATURE_COACHLESS_HOME = saved;
  });

  it('defaults OFF: every client route answers 404 coachless_disabled unless the value is exactly "true"', () => {
    const guard = new CoachlessFeatureGuard();
    for (const v of [undefined, 'false', 'TRUE', '1', 'on']) {
      if (v === undefined) delete process.env.FEATURE_COACHLESS_HOME;
      else process.env.FEATURE_COACHLESS_HOME = v;
      let caught: any;
      try {
        guard.canActivate();
      } catch (e) {
        caught = e;
      }
      expect([v, caught?.getStatus?.(), caught?.getResponse?.().code]).toEqual([
        v,
        404,
        'coachless_disabled',
      ]);
    }
    process.env.FEATURE_COACHLESS_HOME = 'true';
    expect(guard.canActivate()).toBe(true);
  });
});
