import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
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
import {
  ONBOARDING_COMPLETION_HOOKS,
  type OnboardingCompletionHook,
} from './onboarding-completion-hooks';

/** Machine codes returned in 409 bodies: `{ code, message, missing? }`. */
export type OnboardingConflictCode =
  | 'not_attached'
  | 'consultation_incomplete'
  | 'consent_missing'
  | 'clinic_not_configured'
  | 'completion_in_progress'
  | 'save_conflict';

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

/** Bounded optimistic-concurrency retries for PUT /me/onboarding/consultation. */
export const SAVE_MAX_ATTEMPTS = 5;

/** Thrown inside a save transaction when the compare-and-swap lost a race. */
class StaleRevisionError extends Error {
  constructor() {
    super('stale intake revision');
    this.name = 'StaleRevisionError';
  }
}

/** Thrown inside the completion transaction when this worker's claim was fenced off. */
class FencedClaimError extends Error {
  constructor() {
    super('completion claim no longer held');
    this.name = 'FencedClaimError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Stable fingerprint of everything that shapes the assigned prescription.
 * A different fingerprint means a previously materialised clone is stale and
 * must never be reused (A607-2).
 */
export function selectionFingerprint(
  sel: ProgramSelection,
  masterProgramId: string,
  startDate: string,
): string {
  const canonical = JSON.stringify([
    sel.program_key,
    sel.selected_days,
    sel.equipment_variant,
    sel.overlay,
    sel.rule_priority,
    sel.coach_review_required,
    masterProgramId,
    startDate,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

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
    @Optional()
    @Inject(ONBOARDING_COMPLETION_HOOKS)
    private readonly completionHooks: OnboardingCompletionHook[] = [],
  ) {}

  // ─── GET /coach/clients/:clientId/consultation ─────────────────────────
  /**
   * The client's coach (head coach owning the roster), a sub-coach with an
   * open assignment to the client, or the head coach of the client's coach
   * may read. Everyone else, including the client, gets 404 (no existence
   * oracle).
   */
  async canCoachRead(readerId: string, clientId: string): Promise<boolean> {
    // A607-1: one CURRENT-tenancy predicate, evaluated from live rows on every
    // request. Nothing is cached and no assignment row is trusted on its own:
    // a sub-coach assignment only counts when its head is the client's
    // current head AND the reader is currently on that head's team. The same
    // predicate is implemented in SQL as app.can_read_client_consultation()
    // and used by the intake RLS policies (API/RLS audience parity, B607-3).
    if (readerId === clientId) return false;
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true, role: true, deleted_at: true },
    });
    if (!client || client.role !== 'student' || client.deleted_at || !client.coach_id) return false;
    const [reader, clientCoach] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: readerId },
        select: { id: true, role: true, coach_id: true, deleted_at: true },
      }),
      this.prisma.user.findUnique({
        where: { id: client.coach_id },
        select: { id: true, role: true, coach_id: true, deleted_at: true },
      }),
    ]);
    if (!reader || reader.deleted_at) return false;
    if (!clientCoach || clientCoach.deleted_at) return false;
    const coachRoles = ['coach', 'owner', 'sub_coach'];
    if (!coachRoles.includes(reader.role) || !coachRoles.includes(clientCoach.role)) return false;

    // 1) The client's current coach.
    if (clientCoach.id === reader.id) return true;
    // 2) The current head coach of the client's current coach.
    if (clientCoach.coach_id && clientCoach.coach_id === reader.id && !reader.coach_id) return true;
    // 3) A sub-coach currently on the client's head's team with an open
    //    assignment issued by that same head for this client.
    const head = clientCoach.coach_id ?? clientCoach.id;
    if (!reader.coach_id || reader.coach_id !== head) return false;
    const open = await this.prisma.subCoachAssignment.findFirst({
      where: {
        sub_coach_id: reader.id,
        client_id: clientId,
        head_coach_id: head,
        unassigned_at: null,
      },
      select: { id: true },
    });
    return Boolean(open);
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

    // B607-1: optimistic concurrency. Each attempt reads the head, merges the
    // patch onto THAT revision, and commits only if the head is still at the
    // same revision (compare-and-swap inside one transaction that also
    // appends the revision and syncs the profile). A lost race re-reads and
    // re-merges, so concurrent disjoint chapter saves both survive. Two
    // simultaneous FIRST saves race on the unique client_id; the loser gets
    // P2002, re-reads and merges onto the winner (never a 500).
    for (let attempt = 0; attempt < SAVE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.saveConsultationOnce(clientId, body.answers, now);
      } catch (err) {
        if (err instanceof StaleRevisionError || isUniqueViolation(err)) continue;
        throw err;
      }
    }
    throw conflict('save_conflict', 'Your answers changed on another device. Please try again');
  }

  private async saveConsultationOnce(
    clientId: string,
    patch: Record<string, unknown>,
    now: Date,
  ): Promise<{ saved_at: string; completed_chapters: string[]; revision: number }> {
    const existing = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });

    // A607-2: while a completion attempt holds a live claim, the answers it
    // is assigning from are frozen. Edits wait (409, retry) instead of
    // racing the assignment. An expired claim does not block; its worker is
    // fenced off at finalisation because the revision moves.
    if (
      existing &&
      !existing.completed_at &&
      existing.completion_claim_token &&
      existing.completion_claimed_at &&
      existing.completion_claimed_at.getTime() > now.getTime() - COMPLETION_CLAIM_TTL_MS
    ) {
      throw conflict(
        'completion_in_progress',
        'Your plan is being prepared. Try again in a moment',
      );
    }

    // Privacy (operator ruling 2026-09-30 18:24): consent is recorded BEFORE
    // any answer is stored. Without a current-version consent on file, the
    // only accepted request is the P0 acknowledgement on its own. Checked
    // before any write, so rejected answers are never stored.
    // Dependency: #601's combined consent table is unmerged; the consent
    // record verified here is the server-stamped P0 acknowledgement on the
    // intake (disclaimer_version + disclaimer_accepted_at).
    const accepted = acceptedConsentVersions();
    const patchP0 = patch.P0;
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
      const otherKeys = Object.keys(patch).filter((k) => k !== 'P0');
      if (!isRecord(patchP0) || otherKeys.length > 0) {
        throw conflict('consent_missing', 'Please accept the agreement before answering');
      }
    }
    const stored: Answers = isRecord(existing?.answers)
      ? (JSON.parse(JSON.stringify(existing?.answers)) as Answers)
      : {};
    const merged = mergeAnswers(stored, patch);
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
      let head: { id: string; current_revision: number };
      if (!existing) {
        head = await tx.clientOnboardingIntake.create({
          data: { client_id: clientId, ...data, current_revision: 1 },
          select: { id: true, current_revision: true },
        });
      } else {
        const cas = await tx.clientOnboardingIntake.updateMany({
          where: {
            client_id: clientId,
            current_revision: existing.current_revision,
            completion_claim_token: existing.completion_claim_token,
          },
          data: { ...data, current_revision: existing.current_revision + 1 },
        });
        if (cas.count !== 1) throw new StaleRevisionError();
        head = { id: existing.id, current_revision: existing.current_revision + 1 };
      }
      await tx.clientOnboardingIntakeRevision.create({
        data: {
          intake_id: head.id,
          client_id: clientId,
          revision: head.current_revision,
          cause: 'save',
          ...snapshot,
        },
      });
      // Profile sync is bound to the committed revision: it runs in the same
      // transaction as the CAS, so an older save can never overwrite fields
      // derived from a newer one.
      await this.writeProfileFromAnswers(tx, clientId, merged, now);
      return head.current_revision;
    });

    return { saved_at: now.toISOString(), completed_chapters: chapters, revision };
  }

  /** Map answers onto the profile (never screening) and refresh profile targets. */
  private async writeProfileFromAnswers(
    tx: Prisma.TransactionClient,
    clientId: string,
    answers: Answers,
    now: Date,
  ) {
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
    await tx.userProfile.upsert({
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

    // A607-2: the selection is ALWAYS recomputed from the answers being
    // completed. Nothing from an earlier, failed attempt (program key, clone,
    // days, overlay) is replayed; a stale clone is retired in the fenced
    // final transaction below.
    const sel: ProgramSelection = selectProgram(selectionAnswersFrom(answers));
    const entry = readProgramEntry(set.programs, sel.program_key);
    if (!entry) throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");
    const startDate = String(answers.C1);
    const fingerprint = selectionFingerprint(sel, entry.program_id, startDate);
    const claimRevision = intake.current_revision;
    const masterIds = PROGRAM_KEYS.map((k) => readProgramEntry(set.programs, k)?.program_id).filter(
      (id): id is string => typeof id === 'string',
    );

    // B607-2: concurrency claim with a fencing token. The claim is bound to
    // the exact revision being completed; every later write of this attempt
    // is conditional on still holding (token, revision).
    const token = randomUUID();
    const claim = await this.prisma.clientOnboardingIntake.updateMany({
      where: {
        client_id: clientId,
        completed_at: null,
        current_revision: claimRevision,
        OR: [
          { completion_claimed_at: null },
          { completion_claimed_at: { lt: new Date(now.getTime() - COMPLETION_CLAIM_TTL_MS) } },
        ],
      },
      data: {
        completion_claimed_at: now,
        completion_claim_token: token,
        completion_claim_revision: claimRevision,
        selected_program_key: sel.program_key,
      },
    });
    if (claim.count === 0) return this.replayOrInProgress(clientId, now);

    let assigned: { program_id: string; name: string; assignment_ids: string[] } | null = null;
    try {
      // Idempotency is scoped to (revision, selection): a plain retry of the
      // same answers reuses the clone; any edit yields a fresh one.
      assigned = await this.workoutBuilder.withIdempotency(
        coach.id,
        'onboarding:complete:program',
        `client:${clientId}:rev:${claimRevision}:sel:${fingerprint}`,
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
      const program = assigned;

      const flagCoach =
        screeningAnyYes(answers) || injuryFlag(answers) || sel.coach_review_required;
      const cohortIds = [set.all_members_cohort_id, entry.cohort_id];

      const result = await this.prisma.$transaction(async (tx) => {
        // FENCE FIRST: completing the row is the first statement and is
        // conditional on this worker's token and the claimed revision. It
        // takes the row lock, so a second worker (lease expired) serialises
        // here and fails the same predicate; on failure the transaction rolls
        // back and none of the effects below (macro target, spaces, coach
        // alert, completion hooks) are written.
        const fenced = await tx.clientOnboardingIntake.updateMany({
          where: {
            client_id: clientId,
            completed_at: null,
            completion_claim_token: token,
            current_revision: claimRevision,
          },
          data: {
            completed_at: now,
            screening_flagged_at: flagCoach ? now : null,
            completion_claim_token: null,
            current_revision: claimRevision + 1,
          },
        });
        if (fenced.count !== 1) throw new FencedClaimError();

        // Retire any other onboarding clone assigned to this client (an older
        // attempt with different answers, or a fenced-off worker's clone).
        await this.retireOnboardingClones(
          tx,
          coach.id,
          clientId,
          masterIds,
          program.program_id,
          now,
        );

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
            id: program.program_id,
            key: sel.program_key,
            name: program.name,
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
          // opens the client's intake for the answers.
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
        await tx.clientOnboardingIntake.update({
          where: { client_id: clientId },
          data: { completion_result: toJson(out) },
        });
        // The submitted form, frozen as its own immutable revision.
        await tx.clientOnboardingIntakeRevision.create({
          data: {
            intake_id: intake.id,
            client_id: clientId,
            revision: claimRevision + 1,
            cause: 'complete',
            version: intake.version,
            answers: toJson(answers),
            completed_chapters: intake.completed_chapters,
            disclaimer_version: intake.disclaimer_version,
            disclaimer_accepted_at: intake.disclaimer_accepted_at,
            screening_any_yes: intake.screening_any_yes,
          },
        });
        // Engagement hooks (welcome message scheduling, reminders) run inside
        // the same fenced transaction, so they happen exactly once.
        for (const hook of this.completionHooks) {
          await hook.onCompleted(tx, {
            client_id: clientId,
            coach_id: coach.id,
            completed_at: now,
            first_session_date: startDate,
            preferred_training_time: typeof answers.S2 === 'string' ? answers.S2 : null,
          });
        }
        return out;
      });
      return result;
    } catch (err) {
      // Release only OUR claim (never a newer worker's).
      await this.prisma.clientOnboardingIntake
        .updateMany({
          where: { client_id: clientId, completed_at: null, completion_claim_token: token },
          data: { completion_claimed_at: null, completion_claim_token: null },
        })
        .catch((releaseErr: unknown) => {
          this.logger.warn(
            `onboarding claim release failed client=${clientId} (${releaseErr instanceof Error ? releaseErr.name : 'unknown'})`,
          );
        });
      if (err instanceof FencedClaimError) {
        // Another worker finalised (or the answers moved on). If someone
        // completed with a different clone, retire ours so the client keeps
        // exactly one onboarding program.
        const done = await this.prisma.clientOnboardingIntake.findUnique({
          where: { client_id: clientId },
        });
        const winner = done?.completed_at ? this.resultProgramId(done.completion_result) : null;
        if (winner && assigned && winner !== assigned.program_id) {
          await this.prisma
            .$transaction((tx) =>
              this.retireOnboardingClones(tx, coach.id, clientId, masterIds, winner, now),
            )
            .catch((retireErr: unknown) => {
              this.logger.warn(
                `onboarding stale clone retire failed client=${clientId} (${retireErr instanceof Error ? retireErr.name : 'unknown'})`,
              );
            });
        }
        return this.replayOrInProgress(clientId, now);
      }
      throw err;
    }
  }

  private async replayOrInProgress(clientId: string, now: Date): Promise<CompletionResult> {
    const again = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: clientId },
    });
    if (again?.completed_at && isRecord(again.completion_result)) {
      return this.replay(again.completion_result, now);
    }
    throw conflict('completion_in_progress', 'Your plan is being prepared. Try again in a moment');
  }

  private resultProgramId(stored: unknown): string | null {
    if (!isRecord(stored) || !isRecord(stored.program)) return null;
    return typeof stored.program.id === 'string' ? stored.program.id : null;
  }

  /**
   * Remove every not-yet-started onboarding assignment for this client that
   * belongs to a clone of the coach's clinic masters other than `keepProgramId`,
   * and archive those clones. Never touches started/completed workouts,
   * templates, or programs that are not clinic-master clones.
   */
  private async retireOnboardingClones(
    tx: Prisma.TransactionClient,
    coachId: string,
    clientId: string,
    masterIds: string[],
    keepProgramId: string,
    now: Date,
  ): Promise<void> {
    if (masterIds.length === 0) return;
    const stale = await tx.clientWorkoutAssignment.findMany({
      where: {
        client_id: clientId,
        assigned_by_coach_id: coachId,
        started_at: null,
        completed_at: null,
        workout_plan: {
          program: {
            id: { not: keepProgramId },
            owner_user_id: coachId,
            is_template: false,
            cloned_from_id: { in: masterIds },
          },
        },
      },
      select: { id: true, workout_plan: { select: { program_id: true } } },
    });
    if (stale.length === 0) return;
    await tx.clientWorkoutAssignment.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
    const programIds = [
      ...new Set(
        stale
          .map((r) => r.workout_plan.program_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (programIds.length > 0) {
      await tx.workoutProgram.updateMany({
        where: { id: { in: programIds }, archived_at: null },
        data: { archived_at: now },
      });
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
