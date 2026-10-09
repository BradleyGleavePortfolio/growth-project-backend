import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CoachConsultationController } from '../src/coach/consultation/coach-consultation.controller';
import { CoachConsultationAnswersDto } from '../src/coach/consultation/coach-consultation.dto';
import { CoachConsultationService } from '../src/coach/consultation/coach-consultation.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';
import type { AuthedRequest } from '../src/auth/auth-request';
import { PrismaService } from '../src/prisma.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { AnalyticsService } from '../src/analytics/analytics.service';

// Typed test double: an object with the class's prototype and only the
// members the code under test calls.
function double<T extends object>(cls: { prototype: T }, members: object): T {
  return Object.assign(Object.create(cls.prototype), members);
}

// COACH-CONSULT-BE-134 (B02 B03) — the coach consultation K0-K8 backend.
// In-memory Prisma: one coach "c1" (signed up as "Jordan Reyes") and a second
// coach "c2" whose rows must never change when c1 calls the service.

function makeWorld() {
  const users: Record<string, any> = {
    c1: { id: 'c1', name: 'Jordan Reyes', profile: { avatar_url: null } },
    c2: { id: 'c2', name: 'Other Coach', profile: { avatar_url: 'https://cdn.example.com/c2.png' } },
  };
  const profiles: Record<string, any> = {
    c1: { user_id: 'c1', invite_code: 'GP-RS7K2Q', business_name: null, bio: null, headline: null,
      years_coaching: null, specialties: [], clients_today: null, coaching_touch: null, programming_style: null },
    c2: { user_id: 'c2', invite_code: 'GP-OTHER1', business_name: 'Other Biz', bio: 'Other bio', headline: null,
      years_coaching: 3, specialties: ['strength'], clients_today: '1_10', coaching_touch: null, programming_style: null },
  };
  const progress: Record<string, any> = {};
  const pick = (row: any) => (row ? { ...row } : null);
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => pick(users[where.id])),
      update: jest.fn(async ({ where, data }: any) => Object.assign(users[where.id], data)),
    },
    coachProfile: {
      update: jest.fn(async ({ where, data }: any) => ({ ...Object.assign(profiles[where.user_id], data) })),
    },
    coachOnboardingProgress: {
      findUnique: jest.fn(async ({ where }: any) => pick(progress[where.coach_id])),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const id = where.coach_id;
        progress[id] = progress[id]
          ? Object.assign(progress[id], update)
          : { completed_at: null, consultation_completed_at: null, consultation_draft: null, ...create };
        return { ...progress[id] };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const inviteCodes = {
    getOrCreateDefaultForCoach: jest.fn(async (id: string) => ({ ...profiles[id] })),
  };
  const analytics = { capture: jest.fn() };
  const service = new CoachConsultationService(
    double(PrismaService, prisma),
    double(InviteCodesService, inviteCodes),
    double(AnalyticsService, analytics),
  );
  return { service, prisma, users, profiles, progress, analytics, inviteCodes };
}

describe('CoachConsultationService', () => {
  it('GET before any save: not_started, prefilled with the sign-up name, the real /join link', async () => {
    const w = makeWorld();
    const v = await w.service.get('c1');
    expect(v.status).toBe('not_started');
    expect(v.step).toBeNull();
    expect(v.answers.display_name).toBe('Jordan Reyes');
    expect(v.answers.specialties).toEqual([]);
    expect(v.link.code).toBe('GP-RS7K2Q');
    expect(v.link.url).toMatch(/\/join\/GP-RS7K2Q$/);
    expect(v.photo_url).toBeNull();
    expect(w.inviteCodes.getOrCreateDefaultForCoach).toHaveBeenCalledWith('c1');
  });

  it('PUT saves a partial draft with the resume step and keeps earlier answers', async () => {
    const w = makeWorld();
    await w.service.save('c1', { step: 'K1', display_name: '  Jordan R  ', business_name: 'Reyes Strength' });
    const v = await w.service.save('c1', { step: 'K2', specialties: ['strength', 'fat_loss', 'strength'] });
    expect(v.status).toBe('in_progress');
    expect(v.step).toBe('K2');
    expect(v.answers.display_name).toBe('Jordan R');
    expect(v.answers.business_name).toBe('Reyes Strength');
    expect(v.answers.specialties).toEqual(['strength', 'fat_loss']);
    // Resume from a fresh GET.
    const again = await w.service.get('c1');
    expect(again.step).toBe('K2');
    expect(again.answers.business_name).toBe('Reyes Strength');
    // Nothing client-facing is written before complete.
    expect(w.prisma.coachProfile.update).not.toHaveBeenCalled();
    expect(w.prisma.user.update).not.toHaveBeenCalled();
  });

  it('PUT with null or "" clears an optional field', async () => {
    const w = makeWorld();
    await w.service.save('c1', { bio: 'I help busy parents get strong.', coaching_touch: 'close' });
    const v = await w.service.save('c1', { bio: '', coaching_touch: null });
    expect(v.answers.bio).toBeNull();
    expect(v.answers.coaching_touch).toBeNull();
  });

  it('complete refuses without a name or clients today, naming what is missing', async () => {
    const w = makeWorld();
    await w.service.save('c1', { display_name: ' ' });
    await expect(w.service.complete('c1', {})).rejects.toBeInstanceOf(BadRequestException);
    try {
      await w.service.complete('c1', {});
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toEqual({
        error: 'CONSULTATION_INCOMPLETE',
        missing: ['display_name', 'clients_today'],
      });
    }
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('complete writes the card, finishes onboarding (the app gate) and touches no money', async () => {
    const w = makeWorld();
    await w.service.save('c1', { step: 'K4', display_name: 'Jordan Reyes', business_name: 'Reyes Strength',
      specialties: ['strength'], coaching_touch: 'balanced' });
    const v = await w.service.complete('c1', { clients_today: 'none', programming_style: 'help', years_coaching: 6 });
    expect(v.status).toBe('complete');
    expect(v.step).toBe('K8');
    expect(v.completed_at).not.toBeNull();
    expect(v.answers).toMatchObject({ display_name: 'Jordan Reyes', business_name: 'Reyes Strength',
      specialties: ['strength'], clients_today: 'none', coaching_touch: 'balanced', programming_style: 'help',
      years_coaching: 6 });
    expect(w.users.c1.name).toBe('Jordan Reyes');
    expect(w.profiles.c1).toMatchObject({ business_name: 'Reyes Strength', specialties: ['strength'],
      clients_today: 'none', coaching_touch: 'balanced', programming_style: 'help', years_coaching: 6 });
    expect(w.progress.c1.completed_at).toBeInstanceOf(Date);
    expect(w.progress.c1.consultation_completed_at).toBeInstanceOf(Date);
    // Only these three writes happen: no Stripe, package or invite call exists on this path.
    expect(Object.keys(w.prisma).sort()).toEqual(['$transaction', 'coachOnboardingProgress', 'coachProfile', 'user']);
    expect(w.analytics.capture).toHaveBeenCalledWith('c1', 'coach_onboarding_completed',
      expect.objectContaining({ via: 'consultation', clients_today: 'none' }));
    // The other coach is untouched (tenancy).
    expect(w.users.c2.name).toBe('Other Coach');
    expect(w.profiles.c2.business_name).toBe('Other Biz');
    expect(w.progress.c2).toBeUndefined();
  });

  it('complete keeps an earlier wizard completion time', async () => {
    const w = makeWorld();
    const earlier = new Date('2026-09-01T10:00:00Z');
    w.progress.c1 = { completed_at: earlier, consultation_completed_at: null, consultation_draft: null };
    await w.service.complete('c1', { clients_today: '11_25' });
    expect(w.progress.c1.completed_at).toBe(earlier);
    expect(w.progress.c1.consultation_completed_at).toBeInstanceOf(Date);
  });

  it('complete is idempotent and PUT after complete is a 409', async () => {
    const w = makeWorld();
    await w.service.complete('c1', { clients_today: '1_10' });
    const calls = w.prisma.$transaction.mock.calls.length;
    const again = await w.service.complete('c1', { display_name: 'Someone Else', clients_today: 'none' });
    expect(again.status).toBe('complete');
    expect(again.answers.clients_today).toBe('1_10');
    expect(w.prisma.$transaction.mock.calls.length).toBe(calls);
    await expect(w.service.save('c1', { bio: 'late edit' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CoachConsultationAnswersDto', () => {
  const check = async (body: object) =>
    (await validate(plainToInstance(CoachConsultationAnswersDto, body), { whitelist: true, forbidNonWhitelisted: true }))
      .map((e) => e.property);

  it('accepts a full valid body', async () => {
    expect(await check({ step: 'K5', display_name: 'Jordan', business_name: null, headline: 'Strength coach',
      bio: 'x'.repeat(280), years_coaching: 0, specialties: ['fat_loss', 'other'], clients_today: '50_plus',
      coaching_touch: 'light', programming_style: 'templates' })).toEqual([]);
  });

  it('rejects unknown values, over-long text, six specialties and extra keys', async () => {
    expect(await check({ specialties: ['strength', 'yoga'] })).toEqual(['specialties']);
    expect(await check({ specialties: ['fat_loss', 'strength', 'muscle', 'beginners', 'older', 'sports'] }))
      .toEqual(['specialties']);
    expect(await check({ display_name: 'x'.repeat(81) })).toEqual(['display_name']);
    expect(await check({ bio: 'x'.repeat(281) })).toEqual(['bio']);
    expect(await check({ years_coaching: 61 })).toEqual(['years_coaching']);
    expect(await check({ clients_today: '0' })).toEqual(['clients_today']);
    expect(await check({ step: 'K9' })).toEqual(['step']);
    expect(await check({ coach_id: 'c2' })).toEqual(['coach_id']);
  });
});

describe('CoachConsultationController', () => {
  it('is coach-guarded with no money guard and passes only the caller id', async () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CoachConsultationController);
    expect(guards).toEqual([JwtAuthGuard, CoachGuard]);
    const svc = { get: jest.fn(), save: jest.fn(), complete: jest.fn() };
    const ctl = new CoachConsultationController(double(CoachConsultationService, svc));
    const req = { user: { id: 'c1' } } as AuthedRequest;
    await ctl.get(req);
    await ctl.save(req, { bio: 'b' });
    await ctl.complete(req, {});
    expect(svc.get).toHaveBeenCalledWith('c1');
    expect(svc.save).toHaveBeenCalledWith('c1', { bio: 'b' });
    expect(svc.complete).toHaveBeenCalledWith('c1', {});
  });
});
