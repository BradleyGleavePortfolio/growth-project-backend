import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { Events } from '../../analytics/events';
import { InviteCodesService } from '../../invite-codes/invite-codes.service';
import { COACH_ONBOARDING_TOTAL_STEPS } from '../coach-onboarding.service';
import type { CoachConsultationAnswersDto } from './coach-consultation.dto';
import {
  CLIENTS_TODAY,
  COACH_SPECIALTIES,
  COACHING_TOUCH,
  CONSULTATION_STEPS,
  MAX_SPECIALTIES,
  PROGRAMMING_STYLE,
  type ClientsToday,
  type CoachSpecialty,
  type CoachingTouch,
  type ConsultationStep,
  type ProgrammingStyle,
} from './coach-consultation.vocab';

// COACH-CONSULT-BE-134 (B02 B03, decision 134-1) — the coach consultation
// K0-K8 (prototype screens 77-85). The only onboarding a new coach sees.
//
//   GET  /coach/consultation           the draft (or a prefill) + the coach's link
//   PUT  /coach/consultation           save a partial draft and the resume step
//   POST /coach/consultation/complete  validate, write the card, finish onboarding
//
// Tenancy: every method takes the caller's own user id (the controller passes
// req.user.id, no path params), so a coach only ever reads or writes their own
// profile. Money is never involved: no Stripe, package or subscription check
// (B02: profile first, money last). Completing also sets
// CoachOnboardingProgress.completed_at, the gate every app build routes on, so
// the old money steps are never forced before the coach reaches the app.

export interface CoachConsultationAnswers {
  display_name: string;
  business_name: string | null;
  headline: string | null;
  bio: string | null;
  years_coaching: number | null;
  specialties: CoachSpecialty[];
  clients_today: ClientsToday | null;
  coaching_touch: CoachingTouch | null;
  programming_style: ProgrammingStyle | null;
}

export interface CoachConsultationView {
  status: 'not_started' | 'in_progress' | 'complete';
  step: ConsultationStep | null;
  answers: CoachConsultationAnswers;
  // Read-only: UserProfile.avatar_url. null = monogram tile (decision D9).
  photo_url: string | null;
  // The coach's permanent /join/<invite_code> link (K6).
  link: { code: string; url: string };
  completed_at: string | null;
  updated_at: string | null;
}

interface StoredDraft {
  answers: CoachConsultationAnswers;
  step: ConsultationStep | null;
  updated_at: string;
}

type ProfileRow = {
  invite_code: string;
  business_name: string | null;
  bio: string | null;
  headline: string | null;
  years_coaching: number | null;
  specialties: string[];
  clients_today: string | null;
  coaching_touch: string | null;
  programming_style: string | null;
};

type ProgressRow = {
  completed_at: Date | null;
  consultation_draft: Prisma.JsonValue | null;
  consultation_completed_at: Date | null;
} | null;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function optText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function specialtyList(v: unknown): CoachSpecialty[] {
  if (!Array.isArray(v)) return [];
  const out: CoachSpecialty[] = [];
  for (const s of v) {
    const k = oneOf(COACH_SPECIALTIES, s);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.slice(0, MAX_SPECIALTIES);
}

function yearsValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

// One normaliser for every source (profile columns, stored draft, request
// body): trims text, drops unknown keys and values, dedupes specialties.
function normalizeAnswers(src: Record<string, unknown>): CoachConsultationAnswers {
  return {
    display_name: typeof src.display_name === 'string' ? src.display_name.trim() : '',
    business_name: optText(src.business_name),
    headline: optText(src.headline),
    bio: optText(src.bio),
    years_coaching: yearsValue(src.years_coaching),
    specialties: specialtyList(src.specialties),
    clients_today: oneOf(CLIENTS_TODAY, src.clients_today),
    coaching_touch: oneOf(COACHING_TOUCH, src.coaching_touch),
    programming_style: oneOf(PROGRAMMING_STYLE, src.programming_style),
  };
}

// Plain JSON for the consultation_draft column.
function draftJson(d: StoredDraft): Prisma.InputJsonObject {
  const a = d.answers;
  return {
    answers: {
      display_name: a.display_name,
      business_name: a.business_name,
      headline: a.headline,
      bio: a.bio,
      years_coaching: a.years_coaching,
      specialties: [...a.specialties],
      clients_today: a.clients_today,
      coaching_touch: a.coaching_touch,
      programming_style: a.programming_style,
    },
    step: d.step,
    updated_at: d.updated_at,
  };
}

export function inviteUrl(code: string): string {
  return `${process.env.PUBLIC_INVITE_BASE_URL || 'https://app.trygrowthproject.com/join'}/${code}`;
}

@Injectable()
export class CoachConsultationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inviteCodes: InviteCodesService,
    private readonly analytics: AnalyticsService,
  ) {}

  async get(coachId: string): Promise<CoachConsultationView> {
    const ctx = await this.load(coachId);
    return this.view(ctx);
  }

  async save(coachId: string, body: CoachConsultationAnswersDto): Promise<CoachConsultationView> {
    const ctx = await this.load(coachId);
    if (ctx.progress?.consultation_completed_at) {
      throw new ConflictException({ error: 'CONSULTATION_COMPLETED' });
    }
    const draft = this.merge(ctx, body);
    const json = draftJson(draft);
    const progress = await this.prisma.coachOnboardingProgress.upsert({
      where: { coach_id: coachId },
      create: { coach_id: coachId, current_step: 1, consultation_draft: json },
      update: { consultation_draft: json },
    });
    return this.view({ ...ctx, progress });
  }

  async complete(coachId: string, body: CoachConsultationAnswersDto): Promise<CoachConsultationView> {
    const ctx = await this.load(coachId);
    // Idempotent: a second call (double tap, retry after a lost response)
    // returns the saved state and changes nothing.
    if (ctx.progress?.consultation_completed_at) return this.view(ctx);

    const draft = this.merge(ctx, body);
    const a = draft.answers;
    const missing: string[] = [];
    if (a.display_name === '') missing.push('display_name');
    if (a.clients_today === null) missing.push('clients_today');
    if (missing.length > 0) {
      throw new BadRequestException({ error: 'CONSULTATION_INCOMPLETE', missing });
    }

    const now = new Date();
    const json = draftJson(draft);
    const card = {
      business_name: a.business_name,
      headline: a.headline,
      bio: a.bio,
      years_coaching: a.years_coaching,
      specialties: a.specialties,
      clients_today: a.clients_today,
      coaching_touch: a.coaching_touch,
      programming_style: a.programming_style,
    };
    const [, profile, progress] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: coachId }, data: { name: a.display_name } }),
      this.prisma.coachProfile.update({ where: { user_id: coachId }, data: card }),
      this.prisma.coachOnboardingProgress.upsert({
        where: { coach_id: coachId },
        create: {
          coach_id: coachId,
          current_step: COACH_ONBOARDING_TOTAL_STEPS,
          completed_at: now,
          consultation_draft: json,
          consultation_completed_at: now,
        },
        update: {
          // Keep an earlier wizard completion time; otherwise finish now.
          completed_at: ctx.progress?.completed_at ?? now,
          current_step: COACH_ONBOARDING_TOTAL_STEPS,
          consultation_draft: json,
          consultation_completed_at: now,
        },
      }),
    ]);

    this.analytics.capture(coachId, Events.COACH_ONBOARDING_COMPLETED, {
      via: 'consultation',
      clients_today: a.clients_today,
      specialties_count: a.specialties.length,
      coaching_touch: a.coaching_touch,
      programming_style: a.programming_style,
    });

    return this.view({ ...ctx, name: a.display_name, profile: { ...ctx.profile, ...profile }, progress });
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async load(
    coachId: string,
  ): Promise<{ name: string; photoUrl: string | null; profile: ProfileRow; progress: ProgressRow }> {
    // Lazily creates the CoachProfile + invite code exactly like
    // GET /coaches/me/invite-link, so K6 always has a real link.
    const base = await this.inviteCodes.getOrCreateDefaultForCoach(coachId);
    const [user, progress] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: coachId },
        select: { name: true, profile: { select: { avatar_url: true } } },
      }),
      this.prisma.coachOnboardingProgress.findUnique({
        where: { coach_id: coachId },
        select: { completed_at: true, consultation_draft: true, consultation_completed_at: true },
      }),
    ]);
    return {
      name: user?.name ?? '',
      photoUrl: user?.profile?.avatar_url ?? null,
      profile: base,
      progress,
    };
  }

  // The answers saved on the account (sign-up name + profile columns).
  private saved(ctx: { name: string; profile: ProfileRow }): CoachConsultationAnswers {
    return normalizeAnswers({ ...ctx.profile, display_name: ctx.name });
  }

  private storedDraft(progress: ProgressRow): StoredDraft | null {
    const raw = progress?.consultation_draft;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const d = raw as Record<string, unknown>;
    const ans = d.answers && typeof d.answers === 'object' ? (d.answers as Record<string, unknown>) : {};
    return {
      answers: normalizeAnswers(ans),
      step: oneOf(CONSULTATION_STEPS, d.step),
      updated_at: typeof d.updated_at === 'string' ? d.updated_at : new Date(0).toISOString(),
    };
  }

  // Draft (or the saved answers when there is none) with the body applied.
  // Keys the body does not send are kept; null or "" clears an optional field.
  private merge(
    ctx: { name: string; profile: ProfileRow; progress: ProgressRow },
    body: CoachConsultationAnswersDto,
  ): StoredDraft {
    const prior = this.storedDraft(ctx.progress);
    const sent = Object.entries(body ?? {}).filter(([, v]) => v !== undefined);
    const answers = normalizeAnswers({ ...(prior?.answers ?? this.saved(ctx)), ...Object.fromEntries(sent) });
    const step = oneOf(CONSULTATION_STEPS, body?.step) ?? prior?.step ?? null;
    return { answers, step, updated_at: new Date().toISOString() };
  }

  private view(ctx: {
    name: string;
    photoUrl: string | null;
    profile: ProfileRow;
    progress: ProgressRow;
  }): CoachConsultationView {
    const done = ctx.progress?.consultation_completed_at ?? null;
    const draft = this.storedDraft(ctx.progress);
    const link = { code: ctx.profile.invite_code, url: inviteUrl(ctx.profile.invite_code) };
    if (done) {
      return {
        status: 'complete',
        step: 'K8',
        answers: this.saved(ctx),
        photo_url: ctx.photoUrl,
        link,
        completed_at: done.toISOString(),
        updated_at: draft?.updated_at ?? done.toISOString(),
      };
    }
    return {
      status: draft ? 'in_progress' : 'not_started',
      step: draft?.step ?? null,
      answers: draft?.answers ?? this.saved(ctx),
      photo_url: ctx.photoUrl,
      link,
      completed_at: null,
      updated_at: draft?.updated_at ?? null,
    };
  }
}
