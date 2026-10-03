// A5-COACH-BRIEF — kill switch and scope of /coach/brief/drafts.
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { PrismaService } from '../../src/prisma.service';
import type { CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import type { RomanReplyDraftsService } from '../../src/coach/brief/roman/roman-reply-drafts.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { CoachBriefEnabledGuard } from '../../src/coach/brief/coach-brief-enabled.guard';
import { CoachGuard } from '../../src/auth/coach.guard';
import { RomanBriefFlagGuard } from '../../src/coach/brief/roman/roman-brief-flag.guard';
import { FEATURE_COACH_BRIEF_ROMAN_ENV } from '../../src/coach/brief/roman/roman-brief.feature';
import { RomanDraftsController } from '../../src/coach/brief/roman/roman-drafts.controller';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

describe('RomanBriefFlagGuard — default OFF kill switch', () => {
  const prev = process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
    else process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = prev;
  });

  it.each([undefined, '', 'false', 'TRUE', '1', 'on', ' true'])(
    '404 with a stable code when the flag is %p',
    (v) => {
      if (v === undefined) delete process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
      else process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = v;
      const err = (() => {
        try {
          new RomanBriefFlagGuard().canActivate();
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'coach_brief.roman_unavailable',
      });
    },
  );

  it('passes only for exactly "true"', () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    expect(new RomanBriefFlagGuard().canActivate()).toBe(true);
  });

  it('every drafts route sits behind the brief switch, the Roman flag and the coach guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, RomanDraftsController);
    expect(guards).toEqual([CoachBriefEnabledGuard, RomanBriefFlagGuard, CoachGuard]);
  });
});

describe('RomanDraftsController — scope', () => {
  it('a head coach never gets drafts for clients delegated to a sub-coach', async () => {
    const listQueue = jest.fn().mockResolvedValue({ drafts: [], manual: [], summary: {} });
    const ctrl = new RomanDraftsController(
      fakeOf<RomanReplyDraftsService>({ listQueue }),
      fakeOf<CoachBriefService>({
        detectBriefMode: async () => 'head_coach',
        resolveClientScope: async () => ['own-1', 'delegated-1', 'own-2'],
      }),
      fakeOf<PrismaService>({
        subCoachAssignment: { findMany: async () => [{ client_id: 'delegated-1' }] },
        user: { findUnique: async () => ({ name: 'Head Coach' }) },
      }),
    );
    await ctrl.queue(fakeOf<AuthedRequest>({ user: { id: 'head-1' } }));
    expect(listQueue).toHaveBeenCalledWith('head-1', 'Head Coach', ['own-1', 'own-2'], {
      prepare: true,
    });
  });

  it('send passes the coach id from the token and a valid Idempotency-Key only', async () => {
    const send = jest.fn().mockResolvedValue({ status: 'sent' });
    const ctrl = new RomanDraftsController(
      fakeOf<RomanReplyDraftsService>({ send }),
      fakeOf<CoachBriefService>({}),
      fakeOf<PrismaService>({}),
    );
    const req = fakeOf<AuthedRequest>({ user: { id: 'coach-1' }, headers: {}, ip: '10.0.0.1' });
    await ctrl.send(req, 'd1', { body: 'Edited' }, 'not-a-uuid');
    expect(send).toHaveBeenCalledWith(
      'coach-1',
      'd1',
      expect.objectContaining({ body: 'Edited', idempotencyKey: null }),
    );
  });
});
