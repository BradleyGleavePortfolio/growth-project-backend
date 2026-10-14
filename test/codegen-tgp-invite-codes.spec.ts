// CODEGEN (owner 138-8, decision 26; AUTHA-07) — new coach invite codes are
// TGP- plus 7 characters with no look-alikes, and every code minted before
// (GP- plus 6) or chosen by the owner (vanity codes) keeps working on every
// path: preview, the /join and /invite pages behind deep links, sign-up and
// attach, the coachless Home sheet and rotation. Real services over the
// stateful DB double.
import 'reflect-metadata';
import { InternalServerErrorException } from '@nestjs/common';
import type { Response } from 'express';
import {
  InviteCodesService,
  generateInviteCodeCandidate,
  inviteCodeLookupCandidates,
} from '../src/invite-codes/invite-codes.service';
import { InviteLandingController } from '../src/invite-landing/invite-landing.controller';
import { InviteLandingService } from '../src/invite-landing/invite-landing.service';
import { LoginThrottleResetService } from '../src/throttler/login-throttle-reset.service';
import { addRowCode, addUser, code, outcome, user } from './support/attach-fixture';
import { COACH_A, COACH_B, buildCoachless } from './coachless/coachless-fixture';

const NEW_FORMAT = /^TGP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{7}$/;
const cast = <T>(value: unknown): T => value as T;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const service = (prisma: unknown) =>
  new InviteCodesService(cast(prisma), cast({ capture: jest.fn() }), cast({}), cast({}));

async function world() {
  const f = await buildCoachless();
  addRowCode(f.db, { code: 'GP-BRADLEY', coach_id: COACH_A });
  addRowCode(f.db, { code: 'STRONG2026', coach_id: COACH_B });
  addRowCode(f.db, { code: 'TGP-K7M2QX3', coach_id: COACH_A });
  const landing = new InviteLandingController(
    new InviteLandingService(f.invites),
    new LoginThrottleResetService(undefined),
  );
  return { ...f, landing };
}

function page() {
  const res = { setHeader: jest.fn(), status: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  const view = () => ({
    status: res.status.mock.calls[0]?.[0],
    html: String(res.send.mock.calls[0]?.[0]),
  });
  return { res, view };
}

describe('format: TGP- plus 7 characters, no look-alikes', () => {
  it('2,000 new codes all match, and every position draws from all 31 characters', () => {
    const codes = Array.from({ length: 2000 }, () => generateInviteCodeCandidate());
    for (const c of codes) expect(c).toMatch(NEW_FORMAT);
    // 31^7 ≈ 2.75×10^10 (~34.7 bits) only if each of the 7 positions uses the
    // whole alphabet; no 0, O, 1, I or L can appear (the regex above).
    for (let pos = 4; pos < 11; pos++) expect(new Set(codes.map((c) => c[pos])).size).toBe(31);
  });

  it('every minting path issues it: code rows, a new coach link and a rotation', async () => {
    const { db, invites } = await world();
    const row = await invites.createForCoach(COACH_A, { invited_by_user_id: null });
    expect(row.code).toMatch(NEW_FORMAT);
    db.state.user.push({
      id: 'coach-c',
      email: 'c@example.test',
      name: 'Coach C',
      role: 'coach',
      coach_id: null,
    });
    db.state.coachSubscription.push({
      id: 'sub-c',
      coach_id: 'coach-c',
      status: 'active',
      tier: 'free',
    });
    const link = await invites.getOrCreateDefaultForCoach('coach-c');
    expect(link.invite_code).toMatch(NEW_FORMAT);
    expect(await invites.previewCode(link.invite_code)).toMatchObject({
      valid: true,
      coach_id: 'coach-c',
    });
    expect((await invites.rotateDefaultCode('coach-c', 0)).profile.invite_code).toMatch(NEW_FORMAT);
  });
});

describe('uniqueness', () => {
  it('a new code never reuses one already stored as a coach link or a code row', async () => {
    const asked: string[] = [];
    const seen = (c: string) => (asked.includes(c) ? asked.indexOf(c) : asked.push(c) - 1);
    // The first candidate is a stored coach link, the second a stored code row.
    const takenAt = (n: number) => async (a: { where: Record<string, string> }) =>
      seen(Object.values(a.where)[0]) === n ? { id: 'taken' } : null;
    const prisma = {
      coachProfile: { findUnique: jest.fn(takenAt(0)) },
      inviteCode: { findUnique: jest.fn(takenAt(1)) },
    };
    const fresh = await service(prisma).generateCodeUniqueAcrossTables();
    expect(asked).toHaveLength(3);
    expect(fresh).toBe(asked[2]);
    expect(fresh).toMatch(NEW_FORMAT);
  });

  it('if every candidate is taken it stops with a 500 instead of reusing a code', async () => {
    const taken = { findUnique: jest.fn(async () => ({ id: 'x' })) };
    const svc = service({ coachProfile: taken, inviteCode: taken });
    await expect(svc.generateCodeUniqueAcrossTables()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('typed forms', () => {
  it('exact first, then upper case, then the dash restored after TGP or GP', () => {
    expect(inviteCodeLookupCandidates(' tgpk7m2qx3 ')).toEqual([
      'tgpk7m2qx3',
      'TGPK7M2QX3',
      'TGP-K7M2QX3',
    ]);
    const old = ['gpbradley', 'GPBRADLEY', 'GP-BRADLEY'];
    expect(inviteCodeLookupCandidates('gpbradley')).toEqual(old);
    expect(inviteCodeLookupCandidates('TGP-K7M2QX3')).toEqual(['TGP-K7M2QX3']);
    expect(inviteCodeLookupCandidates('STRONG2026')).toEqual(['STRONG2026']);
    expect(inviteCodeLookupCandidates('tgp k7m2qx3')).toEqual([]);
  });
});

// [stored code, how a client types it, coach]
describe.each([
  ['GP-BBBBBB', 'gpbbbbbb', COACH_B], // old GP- coach link, no dash
  ['GP-BRADLEY', 'gp-bradley', COACH_A], // owner vanity row, lower case
  ['STRONG2026', 'strong2026', COACH_B], // vanity code with no prefix
  ['TGP-K7M2QX3', 'tgpk7m2qx3', COACH_A], // new format, lower case, no dash
])('%s typed as %s keeps working everywhere', (stored, typed, coachId) => {
  it('preview resolves it as stored and as typed', async () => {
    const { invites } = await world();
    for (const c of [stored, typed])
      expect(await invites.previewCode(c)).toMatchObject({ valid: true, coach_id: coachId });
  });

  it('the /join and /invite pages behind a deep link open the coach page', async () => {
    const { landing } = await world();
    for (const route of ['joinHtml', 'inviteHtml'] as const) {
      const { res, view } = page();
      await landing[route](typed, cast<Response>(res), IPHONE, {});
      expect(view().status).toBe(200);
      expect(view().html).toContain(coachId === COACH_A ? 'Coach A' : 'Coach B');
      expect(view().html).toContain(`href="tgp://join/${typed}"`);
    }
  });

  it('sign-up and attach pair the client and record the stored code', async () => {
    const { db, invites } = await world();
    addUser(db, { id: 'stu' });
    expect(await outcome(invites.attachUserToCoachByCode('stu', typed))).toMatchObject({
      ok: { coach_id: coachId, already_attached: false },
    });
    expect(user(db, 'stu').coach_id).toBe(coachId);
    expect(db.state.inviteRedemption).toEqual([
      expect.objectContaining({ client_user_id: 'stu', code: stored }),
    ]);
  });

  it('the coachless Home sheet finds the coach', async () => {
    const { db, redemption } = await world();
    addUser(db, { id: 'stu' });
    expect(await redemption.check(user(db, 'stu'), typed)).toMatchObject({
      valid: true,
      coach: { id: coachId },
    });
  });
});

describe('rotation and unknown codes', () => {
  it('an old GP- link rotated with grace gets a TGP- link; the old code still joins', async () => {
    const { db, invites } = await world();
    const { profile, previous } = await invites.rotateDefaultCode(COACH_B, 24 * 3_600_000);
    expect(profile.invite_code).toMatch(NEW_FORMAT);
    expect(previous.code).toBe('GP-BBBBBB');
    addUser(db, { id: 'late' });
    addUser(db, { id: 'new' });
    const late = await outcome(invites.attachUserToCoachByCode('late', 'gp-bbbbbb'));
    expect(late).toMatchObject({ ok: { coach_id: COACH_B } });
    expect(code(db, 'GP-BBBBBB').used_count).toBe(1);
    const typedNew = profile.invite_code.toLowerCase().replace('-', '');
    const joined = await outcome(invites.attachUserToCoachByCode('new', typedNew));
    expect(joined).toMatchObject({ ok: { coach_id: COACH_B } });
  });

  it('an unknown code of either shape is still refused everywhere', async () => {
    const { db, invites, redemption } = await world();
    addUser(db, { id: 'stu' });
    for (const c of ['TGP-ZZZZZZZ', 'gpzzzzzz']) {
      expect(await invites.previewCode(c)).toEqual({ valid: false });
      expect(await outcome(invites.attachUserToCoachByCode('stu', c))).toMatchObject({
        status: 400,
        body: { code: 'invite_code_invalid' },
      });
      expect(await redemption.check(user(db, 'stu'), c)).toMatchObject({
        valid: false,
        code: 'code_invalid',
      });
    }
    expect(user(db, 'stu').coach_id).toBeNull();
  });
});
