import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';

// Phase 6D — Coach Onboarding Wizard.
//
// The wizard walks a newly-promoted coach through six steps:
//   1. profile           — business_name / bio / timezone
//   2. invite_code       — show default invite code, copy reminder
//   3. first_invite      — log that the coach has shared their code
//   4. message_template  — create the first message draft template
//   5. guidelines        — set the coach's default client guidelines
//   6. confirm           — confirm completion (terminal)
//
// Step ordering is enforced server-side: advanceStep(n) requires
// n === current_step (resume on the same step) OR n === current_step + 1
// (forward one). A second call to step N after step N+1 has been recorded
// returns 400 — there is no "rewind".
//
// Once `completed_at` is set the row freezes. Subsequent advance/start calls
// return 409 so a wizard is not accidentally re-opened by a stale UI.

export const COACH_ONBOARDING_TOTAL_STEPS = 6;

export const COACH_ONBOARDING_STEPS = [
  'profile',
  'invite_code',
  'first_invite',
  'message_template',
  'guidelines',
  'confirm',
] as const;

export type CoachOnboardingStepName =
  (typeof COACH_ONBOARDING_STEPS)[number];

export interface CoachOnboardingProgressDto {
  id: string;
  coach_id: string;
  started_at: string;
  completed_at: string | null;
  current_step: number;
  current_step_name: CoachOnboardingStepName;
  total_steps: number;
  step_data: Record<string, unknown>;
  is_complete: boolean;
}

export interface AdvanceStepInput {
  // The step the caller claims to be completing (1-indexed). Server enforces
  // it equals current_step (resume) or current_step + 1 (forward).
  step: number;
  // Per-step opaque payload. The service does NOT validate the inner shape
  // beyond "is a JSON object" so that callers can iterate on the wizard UI
  // without a schema migration.
  data?: Record<string, unknown>;
}

@Injectable()
export class CoachOnboardingService {
  private readonly logger = new Logger(CoachOnboardingService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
  ) {}

  // Whether AdminService.promoteUser should auto-start the wizard. Default
  // true; set COACH_ONBOARDING_AUTO_START=false to disable (e.g. during
  // bulk back-fills where we don't want a flood of analytics events).
  static autoStartEnabled(): boolean {
    const raw = (process.env.COACH_ONBOARDING_AUTO_START ?? '').trim().toLowerCase();
    if (raw === '') return true;
    return raw !== 'false' && raw !== '0' && raw !== 'no';
  }

  private toDto(row: {
    id: string;
    coach_id: string;
    started_at: Date;
    completed_at: Date | null;
    current_step: number;
    step_data: Prisma.JsonValue | null;
  }): CoachOnboardingProgressDto {
    const stepData =
      row.step_data && typeof row.step_data === 'object' && !Array.isArray(row.step_data)
        ? (row.step_data as Record<string, unknown>)
        : {};
    const idx = Math.min(
      Math.max(row.current_step, 1),
      COACH_ONBOARDING_TOTAL_STEPS,
    );
    return {
      id: row.id,
      coach_id: row.coach_id,
      started_at: row.started_at.toISOString(),
      completed_at: row.completed_at ? row.completed_at.toISOString() : null,
      current_step: row.current_step,
      current_step_name: COACH_ONBOARDING_STEPS[idx - 1],
      total_steps: COACH_ONBOARDING_TOTAL_STEPS,
      step_data: stepData,
      is_complete: row.completed_at != null,
    };
  }

  // Idempotent — if a row already exists for this coach we return it as-is.
  // Returns the DTO either way so callers (admin promote, controller) get
  // a uniform shape.
  async startWizard(coachId: string): Promise<CoachOnboardingProgressDto> {
    const existing = await this.prisma.coachOnboardingProgress.findUnique({
      where: { coach_id: coachId },
    });
    if (existing) return this.toDto(existing);

    try {
      const created = await this.prisma.coachOnboardingProgress.create({
        data: { coach_id: coachId, current_step: 1 },
      });
      this.analytics.capture(coachId, Events.COACH_ONBOARDING_STARTED, {});
      return this.toDto(created);
    } catch (err) {
      // Race: another request raced us between the findUnique and the
      // create. Re-read and return the winner so the caller still gets a
      // DTO instead of a 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const racer = await this.prisma.coachOnboardingProgress.findUnique({
          where: { coach_id: coachId },
        });
        if (racer) return this.toDto(racer);
      }
      throw err;
    }
  }

  async getProgress(coachId: string): Promise<CoachOnboardingProgressDto> {
    const row = await this.prisma.coachOnboardingProgress.findUnique({
      where: { coach_id: coachId },
    });
    if (!row) throw new NotFoundException('Onboarding not started');
    return this.toDto(row);
  }

  async advanceStep(
    coachId: string,
    input: AdvanceStepInput,
  ): Promise<CoachOnboardingProgressDto> {
    if (
      !Number.isInteger(input.step) ||
      input.step < 1 ||
      input.step > COACH_ONBOARDING_TOTAL_STEPS
    ) {
      throw new BadRequestException({
        error: 'STEP_OUT_OF_RANGE',
        max_step: COACH_ONBOARDING_TOTAL_STEPS,
      });
    }

    const row = await this.prisma.coachOnboardingProgress.findUnique({
      where: { coach_id: coachId },
    });
    if (!row) throw new NotFoundException('Onboarding not started');
    if (row.completed_at) {
      throw new ConflictException({ error: 'ONBOARDING_COMPLETED' });
    }

    // Allow same-step (resume) or next-step (forward). Reject jumps and
    // rewinds — the UX is strictly sequential.
    if (input.step !== row.current_step && input.step !== row.current_step + 1) {
      throw new BadRequestException({
        error: 'STEP_OUT_OF_ORDER',
        expected: [row.current_step, row.current_step + 1],
        received: input.step,
      });
    }

    const merged: Record<string, unknown> =
      row.step_data && typeof row.step_data === 'object' && !Array.isArray(row.step_data)
        ? { ...(row.step_data as Record<string, unknown>) }
        : {};
    if (input.data && typeof input.data === 'object') {
      merged[String(input.step)] = input.data;
    }

    const advancedTo = Math.min(input.step + 1, COACH_ONBOARDING_TOTAL_STEPS);

    const updated = await this.prisma.coachOnboardingProgress.update({
      where: { coach_id: coachId },
      data: {
        current_step: advancedTo,
        step_data: merged as Prisma.InputJsonValue,
      },
    });

    this.analytics.capture(coachId, Events.COACH_ONBOARDING_STEP_COMPLETED, {
      step_number: input.step,
      step_name: COACH_ONBOARDING_STEPS[input.step - 1],
    });

    return this.toDto(updated);
  }

  async completeWizard(coachId: string): Promise<CoachOnboardingProgressDto> {
    const row = await this.prisma.coachOnboardingProgress.findUnique({
      where: { coach_id: coachId },
    });
    if (!row) throw new NotFoundException('Onboarding not started');
    if (row.completed_at) {
      // Idempotent terminal call — return the existing completion as-is.
      return this.toDto(row);
    }
    // Coaches can only complete from the final step (step 6 confirm). This
    // matches the UI's last-screen button. We don't require the data blob to
    // include any specific keys — that's a UI concern.
    if (row.current_step < COACH_ONBOARDING_TOTAL_STEPS) {
      throw new BadRequestException({
        error: 'STEP_OUT_OF_ORDER',
        expected: COACH_ONBOARDING_TOTAL_STEPS,
        received: row.current_step,
      });
    }

    const updated = await this.prisma.coachOnboardingProgress.update({
      where: { coach_id: coachId },
      data: {
        completed_at: new Date(),
        current_step: COACH_ONBOARDING_TOTAL_STEPS,
      },
    });
    this.analytics.capture(coachId, Events.COACH_ONBOARDING_COMPLETED, {});
    return this.toDto(updated);
  }

  // OWNER-only listing for the admin console. Filter is applied in SQL so a
  // 10k-coach roster is bounded; the response is capped server-side.
  async listAllProgress(opts?: {
    completed?: 'true' | 'false';
    limit?: number;
  }): Promise<{ items: CoachOnboardingProgressDto[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const where: Prisma.CoachOnboardingProgressWhereInput = {};
    if (opts?.completed === 'true') {
      where.completed_at = { not: null };
    } else if (opts?.completed === 'false') {
      where.completed_at = null;
    }
    const [rows, total] = await Promise.all([
      this.prisma.coachOnboardingProgress.findMany({
        where,
        orderBy: { started_at: 'desc' },
        take: limit,
      }),
      this.prisma.coachOnboardingProgress.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r)),
      total,
    };
  }
}
