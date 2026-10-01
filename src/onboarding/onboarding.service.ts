import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { computeMacros, resolveMacroInputs, type MacroResult } from '../macros/macro-calculator';
import { WorkoutBuilderService } from '../workout-builder/workout-builder.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { buildConsultationView, type ConsultationView } from './consultation-view';
import {
  CONSULTATION_VERSION,
  acceptedConsentVersions,
  consentCopyVersion,
  macroDisplayFor,
  selectionAnswersFrom,
  completedChapters,
  injuryFlag,
  macroRawFromAnswers,
  mergeAnswers,
  missingRequired,
  profileFieldsFromAnswers,
  screeningAnyYes,
  validateAnswerPatch,
  type Answers,
} from './consultation-answers';
import {
  selectProgram,
  whyReasons,
  PROGRAM_KEYS,
  type ProgramKey,
  type ProgramSelection,
} from './program-rules';
import {
  materialiseClientPlans,
  type ExerciseRow,
  type Materialisation,
  type PlanContent,
} from './clinic-programs';
import { writeProgramTree } from './program-writer';

/** Machine codes returned in 409 bodies: `{ code, message, missing? }`. */
export type OnboardingConflictCode =
  | 'not_attached'
  | 'consultation_incomplete'
  | 'consent_missing'
  | 'clinic_not_configured'
  | 'completion_in_progress';

export interface CompletionResult {
  macros: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    method: MacroResult['method'];
    floor_applied: boolean;
  };
  program: {
    id: string;
    key: ProgramKey;
    name: string;
    days_per_week: number;
    weeks: number;
    start_date: string;
    why: string[];
  };
  spaces: Array<{ id: string; name: string }>;
  coach: { id: string; display_name: string };
  /** C05 item 8: 'simple' (calories + protein only) for 7 days when N4 = never. */
  macro_display_mode: 'simple' | 'full';
  simple_until: string | null;
}

/** Stale completion claims (crashed worker) can be re-taken after this. */
export const COMPLETION_CLAIM_TTL_MS = 120_000;

const COACH_FLAG_BODY =
  'A new client finished their consultation and asked for extra care. Please review before their first session.';

function conflict(
  code: OnboardingConflictCode,
  message: string,
  extra: Record<string, unknown> = {},
): ConflictException {
  return new ConflictException({ statusCode: 409, code, message, ...extra });
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ProgramSetEntry {
  program_id: string;
  cohort_id: string;
  name: string;
}

function readProgramEntry(programs: unknown, key: ProgramKey): ProgramSetEntry | null {
  if (!isRecord(programs)) return null;
  const e = programs[key];
  if (!isRecord(e)) return null;
  if (
    typeof e.program_id !== 'string' ||
    typeof e.cohort_id !== 'string' ||
    typeof e.name !== 'string'
  )
    return null;
  return { program_id: e.program_id, cohort_id: e.cohort_id, name: e.name };
}

function readMaterialisation(v: unknown): Materialisation | null {
  if (!isRecord(v)) return null;
  if (!isRecord(v.frequency_variants) || !isRecord(v.equipment_overrides) || !isRecord(v.overlays))
    return null;
  if (!isRecord(v.why_templates)) return null;
  // Written only by the seed script after parseFixture validation.
  return JSON.parse(JSON.stringify(v));
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workoutBuilder: WorkoutBuilderService,
    @Optional() private readonly subCoachScope?: SubCoachScopeService,
  ) {}

  // ─── GET /coach/clients/:clientId/consultation ─────────────────────────
  /**
   * The client's coach (head coach owning the roster), a sub-coach with an
   * open assignment to the client, or the head coach of the client's coach
   * may read. Everyone else, including the client, gets 404 (no existence
   * oracle).
   */
  async canCoachRead(readerId: string, clientId: string): Promise<boolean> {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true, role: true },
    });
    if (!client || client.role !== 'student' || !client.coach_id || readerId === clientId)
      return false;
    if (client.coach_id === readerId) return true;
    const clientCoach = await this.prisma.user.findUnique({
      where: { id: client.coach_id },
      select: { coach_id: true },
    });
    if (clientCoach?.coach_id === readerId) return true;
    return this.subCoachScope ? this.subCoachScope.canAccessClient(readerId, clientId) : false;
  }

  async getCoachConsultation(
    readerId: string,
    clientId: string,
    revision?: number,
    now = new Date(),
  ): Promise<ConsultationView> {
    if (!(await this.canCoachRead(readerId, clientId)))
      throw new NotFoundException('Consultation not found');
    const intake = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });
    if (!intake) throw new NotFoundException('Consultation not found');
    const wanted = revision ?? intake.current_revision;
    const rev = await this.prisma.clientOnboardingIntakeRevision.findUnique({
      where: { intake_id_revision: { intake_id: intake.id, revision: wanted } },
    });
    if (!rev) throw new NotFoundException('Consultation not found');
    const answers: Answers = isRecord(rev.answers)
      ? (JSON.parse(JSON.stringify(rev.answers)) as Answers)
      : {};
    return buildConsultationView(
      {
        version: rev.version,
        revision: rev.revision,
        cause: rev.cause,
        answers,
        disclaimer_version: rev.disclaimer_version,
        disclaimer_accepted_at: rev.disclaimer_accepted_at,
        screening_any_yes: rev.screening_any_yes,
        created_at: rev.created_at,
      },
      { submitted_at: intake.completed_at, saved_at: rev.created_at },
      now,
    );
  }

  /** Revision list for the coach view (newest first). */
  async listCoachConsultationRevisions(readerId: string, clientId: string) {
    if (!(await this.canCoachRead(readerId, clientId)))
      throw new NotFoundException('Consultation not found');
    const rows = await this.prisma.clientOnboardingIntakeRevision.findMany({
      where: { client_id: clientId },
      orderBy: { revision: 'desc' },
      select: { revision: true, cause: true, created_at: true, screening_any_yes: true },
      take: 200,
    });
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }

  // ─── PUT /me/onboarding/consultation ────────────────────────────────────
  async saveConsultation(
    clientId: string,
    body: { version: string; answers: Record<string, unknown> },
    now = new Date(),
  ) {
    if (body.version !== CONSULTATION_VERSION) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'unsupported_version',
        message: `version must be ${CONSULTATION_VERSION}`,
      });
    }
    const errors = validateAnswerPatch(body.answers, now);
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'invalid_answers',
        message: 'Some answers are invalid',
        errors,
      });
    }

    const existing = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });

    // Privacy (operator ruling 2026-09-30 18:24): consent is recorded BEFORE
    // any answer is stored. Without a current-version consent on file, the
    // only accepted request is the P0 acknowledgement on its own. Checked
    // before any write, so rejected answers are never stored.
    // Dependency: #601's combined consent table is unmerged; the consent
    // record verified here is the server-stamped P0 acknowledgement on the
    // intake (disclaimer_version + disclaimer_accepted_at).
    const accepted = acceptedConsentVersions();
    const patchP0 = body.answers.P0;
    if (patchP0 === null) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'invalid_answers',
        message: 'Consent cannot be withdrawn through this endpoint',
        errors: [{ key: 'P0', message: 'consent cannot be cleared here' }],
      });
    }
    if (isRecord(patchP0) && !accepted.includes(consentCopyVersion(patchP0) ?? '')) {
      throw conflict('consent_missing', 'Please accept the current version of the agreement');
    }
    const consentOnFile = Boolean(
      existing?.disclaimer_accepted_at &&
      existing.disclaimer_version &&
      accepted.includes(existing.disclaimer_version),
    );
    if (!consentOnFile) {
      const otherKeys = Object.keys(body.answers).filter((k) => k !== 'P0');
      if (!isRecord(patchP0) || otherKeys.length > 0) {
        throw conflict('consent_missing', 'Please accept the agreement before answering');
      }
    }
    const stored: Answers = isRecord(existing?.answers)
      ? (JSON.parse(JSON.stringify(existing?.answers)) as Answers)
      : {};
    const merged = mergeAnswers(stored, body.answers);
    const chapters = completedChapters(merged);

    // P0: server-stamped acknowledgement. Re-stamped only when the copy
    // version changes, so a resume does not move the accepted time.
    const p0 = isRecord(merged.P0) ? merged.P0 : null;
    const p0Version = p0 ? consentCopyVersion(p0) : null;
    const disclaimer_version = p0Version;
    const disclaimer_accepted_at = p0Version
      ? existing?.disclaimer_version === p0Version && existing.disclaimer_accepted_at
        ? existing.disclaimer_accepted_at
        : now
      : null;

    const snapshot = {
      version: CONSULTATION_VERSION,
      answers: toJson(merged),
      completed_chapters: chapters,
      disclaimer_version,
      disclaimer_accepted_at,
      screening_any_yes: screeningAnyYes(merged),
    };
    const data = {
      ...snapshot,
      saved_at: now,
      first_session_date:
        typeof merged.C1 === 'string' ? new Date(`${merged.C1}T00:00:00.000Z`) : null,
      preferred_training_time: typeof merged.S2 === 'string' ? merged.S2 : null,
    };
    // Owner ruling: forms are kept as submitted. Every save appends an
    // immutable revision; the intake row is only the head pointer.
    const revision = await this.prisma.$transaction(async (tx) => {
      const head = await tx.clientOnboardingIntake.upsert({
        where: { client_id: clientId },
        create: { client_id: clientId, ...data, current_revision: 1 },
        update: { ...data, current_revision: { increment: 1 } },
      });
      await tx.clientOnboardingIntakeRevision.create({
        data: {
          intake_id: head.id,
          client_id: clientId,
          revision: head.current_revision,
          cause: 'save',
          ...snapshot,
        },
      });
      return head.current_revision;
    });

    await this.writeProfileFromAnswers(clientId, merged, now);
    return { saved_at: now.toISOString(), completed_chapters: chapters, revision };
  }

  /** Map answers onto the profile (never screening) and refresh profile targets. */
  private async writeProfileFromAnswers(clientId: string, answers: Answers, now: Date) {
    const fields = profileFieldsFromAnswers(answers);
    const resolved = resolveMacroInputs(macroRawFromAnswers(answers), now);
    if (resolved.ok) {
      const m = computeMacros(resolved.inputs);
      Object.assign(fields, {
        macro_target_calories: m.calories,
        macro_target_protein_g: m.protein_g,
        macro_target_carbs_g: m.carbs_g,
        macro_target_fat_g: m.fat_g,
      });
    }
    if (Object.keys(fields).length === 0) return;
    await this.prisma.userProfile.upsert({
      where: { user_id: clientId },
      create: { user_id: clientId, ...fields },
      update: fields,
    });
  }

  // ─── GET /me/onboarding ────────────────────────────────────────────────
  async getOnboarding(clientId: string) {
    const intake = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });
    const answers: Answers = isRecord(intake?.answers)
      ? (JSON.parse(JSON.stringify(intake?.answers)) as Answers)
      : {};
    return {
      version: intake?.version ?? CONSULTATION_VERSION,
      answers,
      completed_chapters: intake?.completed_chapters ?? [],
      missing_required: missingRequired(answers),
      consent_recorded: Boolean(intake?.disclaimer_accepted_at),
      saved_at: intake?.saved_at?.toISOString() ?? null,
      completed: Boolean(intake?.completed_at),
      completed_at: intake?.completed_at?.toISOString() ?? null,
      result: intake?.completed_at && intake.completion_result ? intake.completion_result : null,
    };
  }

  // ─── POST /me/onboarding/complete ──────────────────────────────────────
  async complete(clientId: string, now = new Date()): Promise<CompletionResult> {
    const intake = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });
    // Idempotent replay: the frozen result, never a second assignment.
    if (intake?.completed_at && isRecord(intake.completion_result)) {
      return this.replay(intake.completion_result, now);
    }

    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, coach_id: true },
    });
    if (!client?.coach_id)
      throw conflict('not_attached', 'This account is not attached to a coach yet');
    const coach = await this.prisma.user.findUnique({
      where: { id: client.coach_id },
      select: { id: true, name: true, role: true, coach_id: true },
    });
    if (!coach || (coach.role !== 'coach' && coach.role !== 'owner')) {
      throw conflict('not_attached', 'This account is not attached to a coach yet');
    }

    const answers: Answers = isRecord(intake?.answers)
      ? (JSON.parse(JSON.stringify(intake?.answers)) as Answers)
      : {};
    if (!intake) {
      throw conflict('consultation_incomplete', 'The consultation has not been saved', {
        missing: missingRequired({}),
      });
    }
    const missing = missingRequired(answers);
    if (missing.length > 0)
      throw conflict('consultation_incomplete', 'Some required answers are missing', { missing });
    if (
      !intake.disclaimer_accepted_at ||
      !isRecord(answers.P0) ||
      !acceptedConsentVersions().includes(intake.disclaimer_version ?? '')
    ) {
      throw conflict('consent_missing', 'The training agreement has not been accepted');
    }
    const resolved = resolveMacroInputs(macroRawFromAnswers(answers), now);
    if (!resolved.ok) {
      throw conflict('consultation_incomplete', 'Some required answers are missing', {
        missing: resolved.missing,
      });
    }
    const macros = computeMacros(resolved.inputs);

    const set = await this.prisma.clinicProgramSet.findFirst({
      where: { coach_id: coach.id, active: true },
      orderBy: { created_at: 'desc' },
    });
    const materialisation = set ? readMaterialisation(set.materialisation) : null;
    if (!set || !materialisation) {
      throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");
    }

    // A previous failed attempt froze its program choice; reuse it so a retry
    // can never produce a second, different assignment.
    const fresh = selectProgram(selectionAnswersFrom(answers));
    const frozenKey = (PROGRAM_KEYS as readonly string[]).includes(
      intake.selected_program_key ?? '',
    )
      ? (intake.selected_program_key as ProgramKey)
      : null;
    const sel: ProgramSelection =
      frozenKey && frozenKey !== fresh.program_key ? { ...fresh, program_key: frozenKey } : fresh;
    const entry = readProgramEntry(set.programs, sel.program_key);
    if (!entry) throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");

    // Concurrency claim: one in-flight completion per client.
    const claim = await this.prisma.clientOnboardingIntake.updateMany({
      where: {
        client_id: clientId,
        completed_at: null,
        OR: [
          { completion_claimed_at: null },
          { completion_claimed_at: { lt: new Date(now.getTime() - COMPLETION_CLAIM_TTL_MS) } },
        ],
      },
      data: { completion_claimed_at: now, selected_program_key: sel.program_key },
    });
    if (claim.count === 0) {
      const again = await this.prisma.clientOnboardingIntake.findUnique({
        where: { client_id: clientId },
      });
      if (again?.completed_at && isRecord(again.completion_result)) {
        return this.replay(again.completion_result, now);
      }
      throw conflict(
        'completion_in_progress',
        'Your plan is being prepared. Try again in a moment',
      );
    }

    try {
      const startDate = String(answers.C1);
      const assigned = await this.workoutBuilder.withIdempotency(
        coach.id,
        'onboarding:complete:program',
        `client:${clientId}`,
        () =>
          this.materialiseAndAssign(
            coach,
            clientId,
            entry.program_id,
            sel,
            materialisation,
            startDate,
          ),
      );

      const flagCoach =
        screeningAnyYes(answers) || injuryFlag(answers) || sel.coach_review_required;
      const cohortIds = [set.all_members_cohort_id, entry.cohort_id];

      const result = await this.prisma.$transaction(async (tx) => {
        await tx.macroTarget.create({
          data: {
            coach_id: coach.id,
            client_id: clientId,
            calories_kcal: macros.calories,
            protein_g: macros.protein_g,
            carbs_g: macros.carbs_g,
            fats_g: macros.fat_g,
            notes: `Initial target from the consultation (${macros.method}${macros.floor_applied ? ', calorie floor applied' : ''}).`,
            effective_from: now,
          },
        });

        const spaces: Array<{ id: string; name: string }> = [];
        for (const cohortId of cohortIds) {
          const cohort = await tx.communityCohort.findFirst({
            where: {
              id: cohortId,
              workspace_id: set.workspace_id,
              archived_at: null,
              workspace: { coach_id: coach.id },
            },
            select: { id: true, name: true },
          });
          if (!cohort)
            throw conflict(
              'clinic_not_configured',
              "Your coach's community spaces are not set up yet",
            );
          // joined_at is the member's join date so the coach can divide the
          // space by signup date; a re-join keeps the original date.
          await tx.communityMembership.upsert({
            where: { cohort_id_user_id: { cohort_id: cohortId, user_id: clientId } },
            create: {
              workspace_id: set.workspace_id,
              cohort_id: cohortId,
              user_id: clientId,
              role: 'student',
              status: 'active',
              joined_at: now,
            },
            update: { status: 'active', removed_at: null },
          });
          spaces.push(cohort);
        }

        const out: CompletionResult = {
          macros: {
            calories: macros.calories,
            protein_g: macros.protein_g,
            carbs_g: macros.carbs_g,
            fat_g: macros.fat_g,
            method: macros.method,
            floor_applied: macros.floor_applied,
          },
          program: {
            id: assigned.program_id,
            key: sel.program_key,
            name: assigned.name,
            days_per_week: sel.selected_days,
            weeks: 4,
            start_date: startDate,
            why: whyReasons(sel, materialisation.why_templates),
          },
          spaces,
          coach: { id: coach.id, display_name: coach.name },
          ...macroDisplayFor(answers, now, now),
        };

        if (flagCoach) {
          // In-app coach item. The body carries no screening details; the coach
          // opens the client's intake (RLS: current coach only) for the answers.
          await tx.notification.create({
            data: {
              user_id: coach.id,
              kind: 'coach_alert',
              channel: 'inapp',
              body: COACH_FLAG_BODY,
              payload: { type: 'onboarding_screening_review', client_id: clientId },
            },
          });
        }

        await tx.userProfile.upsert({
          where: { user_id: clientId },
          create: { user_id: clientId, onboardingCompleted: true },
          update: { onboardingCompleted: true },
        });
        const head = await tx.clientOnboardingIntake.update({
          where: { client_id: clientId },
          data: {
            completed_at: now,
            completion_result: toJson(out),
            screening_flagged_at: flagCoach ? now : null,
            current_revision: { increment: 1 },
          },
        });
        // The submitted form, frozen as its own immutable revision.
        await tx.clientOnboardingIntakeRevision.create({
          data: {
            intake_id: head.id,
            client_id: clientId,
            revision: head.current_revision,
            cause: 'complete',
            version: intake.version,
            answers: toJson(answers),
            completed_chapters: intake.completed_chapters,
            disclaimer_version: intake.disclaimer_version,
            disclaimer_accepted_at: intake.disclaimer_accepted_at,
            screening_any_yes: intake.screening_any_yes,
          },
        });
        return out;
      });
      return result;
    } catch (err) {
      await this.prisma.clientOnboardingIntake
        .updateMany({
          where: { client_id: clientId, completed_at: null },
          data: { completion_claimed_at: null },
        })
        .catch((releaseErr: unknown) => {
          this.logger.warn(
            `onboarding claim release failed client=${clientId} (${releaseErr instanceof Error ? releaseErr.name : 'unknown'})`,
          );
        });
      throw err;
    }
  }

  /** Stored result with the display mode re-evaluated against `now`. */
  private replay(stored: unknown, now: Date): CompletionResult {
    const r = JSON.parse(JSON.stringify(stored)) as CompletionResult;
    const until = typeof r.simple_until === 'string' ? new Date(r.simple_until) : null;
    r.macro_display_mode = until && now < until ? 'simple' : 'full';
    if (r.simple_until === undefined) r.simple_until = null;
    return r;
  }

  /**
   * Read model for the engagement jobs (C05 items 6-7, separate builder):
   * completion time, first session date (C1), preferred time (S2) and the
   * attached coach. Returns null until onboarding is complete.
   */
  async getEngagementInputs(clientId: string): Promise<{
    client_id: string;
    coach_id: string | null;
    onboarding_completed_at: string;
    first_session_date: string | null;
    preferred_training_time: string | null;
  } | null> {
    const intake = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
      select: { completed_at: true, first_session_date: true, preferred_training_time: true },
    });
    if (!intake?.completed_at) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    return {
      client_id: clientId,
      coach_id: user?.coach_id ?? null,
      onboarding_completed_at: intake.completed_at.toISOString(),
      first_session_date: intake.first_session_date
        ? intake.first_session_date.toISOString().slice(0, 10)
        : null,
      preferred_training_time: intake.preferred_training_time,
    };
  }

  /**
   * Build the client clone (owned by the attached coach, under the coach's
   * tenancy) with frequency/equipment/extra-care applied, then assign it via
   * the existing assignProgramToClient path. Runs under withIdempotency so a
   * replay returns the cached clone and never assigns twice.
   */
  private async materialiseAndAssign(
    coach: { id: string; coach_id: string | null },
    clientId: string,
    masterId: string,
    sel: ProgramSelection,
    m: Materialisation,
    startDate: string,
  ): Promise<{ program_id: string; name: string; assignment_ids: string[] }> {
    const tenantId = coach.coach_id ?? coach.id;
    const master = await this.prisma.workoutProgram.findUnique({ where: { id: masterId } });
    // Tenancy: the master must be the attached coach's own template.
    if (!master || master.owner_user_id !== coach.id || !master.is_template || master.archived_at) {
      throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");
    }
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    if (client?.coach_id !== coach.id)
      throw conflict('not_attached', 'This account is not attached to a coach yet');

    const masterPlans = await this.prisma.workoutPlan.findMany({
      where: { program_id: master.id, archived_at: null },
      orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
      include: { exercises: { where: { archived_at: null }, orderBy: { order: 'asc' } } },
    });
    const content: PlanContent[] = masterPlans.map((p) => ({
      source_plan_id: p.id,
      data: {
        name: p.name,
        type: p.type,
        duration_estimate_minutes: p.duration_estimate_minutes,
        week_index: p.week_index ?? 0,
        day_index: p.day_index ?? 0,
      },
      exercises: p.exercises.map((e): ExerciseRow => ({
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs,
        rest_seconds: e.rest_seconds,
        superset_group_id: e.superset_group_id,
        notes: e.notes,
      })),
    }));
    const plans = materialiseClientPlans(content, sel.program_key, sel, m);

    const clone = await this.prisma.$transaction((tx) =>
      writeProgramTree(tx, {
        tenantCoachId: tenantId,
        ownerUserId: coach.id,
        name: master.name,
        description: master.description,
        weeks: master.weeks,
        daysPerWeek: sel.selected_days,
        goalTag: master.goal_tag,
        isTemplate: false,
        clonedFromId: master.id,
        plans,
        revisionMeta: {
          materialised: {
            program_key: sel.program_key,
            selected_days: sel.selected_days,
            equipment_variant: sel.equipment_variant,
            overlay: sel.overlay,
            rule_priority: sel.rule_priority,
            client_id: clientId,
          },
        },
      }),
    );

    try {
      const assigned = await this.workoutBuilder.assignProgramToClient(
        coach.id,
        clone.id,
        { client_id: clientId, start_date: startDate },
        `onboarding:${clientId}`,
      );
      return {
        program_id: clone.id,
        name: clone.name,
        assignment_ids: assigned.assignments.map((a) => a.id),
      };
    } catch (err) {
      // Never leave an unassigned orphan clone behind.
      await this.prisma.workoutProgram
        .update({ where: { id: clone.id }, data: { archived_at: new Date() } })
        .catch((archiveErr: unknown) => {
          this.logger.warn(
            `orphan clone archive failed program=${clone.id} (${archiveErr instanceof Error ? archiveErr.name : 'unknown'})`,
          );
        });
      throw err;
    }
  }
}
