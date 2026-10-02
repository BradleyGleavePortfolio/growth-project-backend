import { randomUUID } from 'crypto';
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
import { writeProfileWithTargets } from '../profile/profile.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { buildConsultationView, type ConsultationView } from './consultation-view';
import {
  CONSULTATION_VERSION,
  consentCopyVersion,
  currentConsentVersionOf,
  isCurrentConsentAnswer,
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

/**
 * Thrown inside the completion transaction when the client's attachment (or
 * the coach) changed after the pre-checks. Rolled back; the completion is
 * re-run against the current attachment (A607-3).
 */
class TenancyChangedError extends Error {
  constructor() {
    super('client attachment changed during completion');
    this.name = 'TenancyChangedError';
  }
}

/** Attempts of POST complete when the attachment changes underneath it. */
export const COMPLETE_TENANCY_ATTEMPTS = 2;

/**
 * Interactive-transaction timeout for the fenced completion (clone, fan-out,
 * effects). Well under COMPLETION_CLAIM_TTL_MS so a live claim always
 * outlasts its own transaction.
 */
export const COMPLETION_TX_TIMEOUT_MS = 30_000;

interface LockedUserRow {
  id: string;
  coach_id: string | null;
  role: string;
  deleted_at: Date | null;
}

/**
 * A607-3 tenancy fence: read a User row FOR SHARE inside the caller's
 * transaction. Conflicts with every UPDATE/DELETE of that row (coach
 * transfer, detach, deletion, role change) until the transaction ends.
 */
export async function lockUserRow(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<LockedUserRow | null> {
  const rows = await tx.$queryRaw<LockedUserRow[]>`
    SELECT "id", "coach_id", "role"::text AS "role", "deleted_at"
    FROM "User" WHERE "id" = ${userId} FOR SHARE`;
  return rows[0] ?? null;
}

/**
 * C-607-3: Postgres aborted the transaction to resolve a lock conflict.
 * P2034 is Prisma's code for a write conflict or deadlock; a raw statement
 * (the FOR SHARE fences) surfaces the SQLSTATE in P2010's meta or the message.
 */
export function isLockConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2034') return true;
  if (err.code !== 'P2010') return false;
  const meta = err.meta ?? {};
  const sqlState = typeof meta.code === 'string' ? meta.code : '';
  return (
    ['40P01', '40001', '55P03'].includes(sqlState) ||
    /deadlock detected|could not serialize access/i.test(err.message)
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const COACH_FLAG_BODY =
  'A new client finished their consultation and was flagged for extra care. Please review before their first session.';

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

/**
 * The P0 copy version a stored intake holds current consent for, or null.
 * Current = server-stamped (`disclaimer_accepted_at`), the stamp names an
 * accepted version, and the stored P0 proves that same version's exact text
 * (copy_version + text_sha256, consult-consent-copy.ts). Used by the save
 * gate, GET `consent_recorded` and completion, so all three agree.
 */
function onFileConsentVersion(
  intake: {
    disclaimer_accepted_at: Date | null;
    disclaimer_version: string | null;
    answers: unknown;
  } | null,
): string | null {
  if (!intake?.disclaimer_accepted_at || !intake.disclaimer_version) return null;
  const answers = intake.answers;
  const version = currentConsentVersionOf(isRecord(answers) ? answers.P0 : undefined);
  return version !== null && version === intake.disclaimer_version ? version : null;
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

  /**
   * Main's team-membership rule (#597, C13 Opus A1). The consultation read
   * asks it one question only, "is this coach an EXPLICIT member of a head
   * coach's team, and of which head?" (getHeadCoachIdForSubCoach), so the API
   * and every other tenant surface share one definition. SubCoachModule is
   * @Global, so production always injects it; the fallback builds the same
   * service over the same PrismaService (tests, standalone construction).
   */
  private readonly membership: SubCoachScopeService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workoutBuilder: WorkoutBuilderService,
    @Optional() subCoachScope?: SubCoachScopeService,
    @Optional()
    @Inject(ONBOARDING_COMPLETION_HOOKS)
    private readonly completionHooks: OnboardingCompletionHook[] = [],
  ) {
    this.membership = subCoachScope ?? new SubCoachScopeService(prisma);
  }

  // ─── GET /coach/clients/:clientId/consultation ─────────────────────────
  /**
   * The client's coach (head coach owning the roster), a sub-coach with an
   * open assignment to the client, or the head coach of the client's coach
   * may read. Everyone else, including the client, gets 404 (no existence
   * oracle).
   *
   * INT-607-1: "head coach of" and "sub-coach on the team of" use main's
   * explicit membership rule (#597 C13 Opus A1, SubCoachScopeService): a coach
   * is on head H's team only when role = 'coach', coach_id = H AND an active
   * TeamSubCoachAssignment(H, coach) or an open SubCoachAssignment(H, coach)
   * exists. A bare coach_id is NOT membership: old guest checkouts stamped
   * coach_id onto coach buyers (phantom sub-coaches), and the phantom "head"
   * must never read the buyer coach's clients' screening answers.
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
    // coach_id is deliberately not read here: team membership comes only from
    // the explicit-membership rule below (INT-607-1).
    const [reader, clientCoach] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: readerId },
        select: { id: true, role: true, deleted_at: true },
      }),
      this.prisma.user.findUnique({
        where: { id: client.coach_id },
        select: { id: true, role: true, deleted_at: true },
      }),
    ]);
    if (!reader || reader.deleted_at) return false;
    if (!clientCoach || clientCoach.deleted_at) return false;
    const coachRoles = ['coach', 'owner', 'sub_coach'];
    if (!coachRoles.includes(reader.role) || !coachRoles.includes(clientCoach.role)) return false;

    // 1) The client's current coach.
    if (clientCoach.id === reader.id) return true;
    // Explicit team membership (main's rule; null = not a member of any
    // team, i.e. head of their own roster). Read live on every request.
    const [clientCoachHead, readerHead] = await Promise.all([
      this.membership.getHeadCoachIdForSubCoach(clientCoach.id),
      this.membership.getHeadCoachIdForSubCoach(reader.id),
    ]);
    // The client's current head: the head of the client's coach when that
    // coach is an explicit team member, otherwise the client's coach itself.
    const head = clientCoachHead ?? clientCoach.id;
    // 2) The current head coach of the client's current coach: the client's
    //    coach is an explicit member of the reader's team, and the reader is
    //    not itself a member of another team.
    if (clientCoachHead !== null && clientCoachHead === reader.id && readerHead === null)
      return true;
    // 3) An explicit member of the client's head's team with an open
    //    assignment issued by that same head for this client.
    if (readerHead === null || readerHead !== head) return false;
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
    // D2 (operator ruling 2026-10-01): P0 is box 1 only (waiver + collection
    // and use for coaching); its record is the server-stamped
    // disclaimer_version + disclaimer_accepted_at on the intake. Box 2 (AI
    // processing) lives in the AI consent ledger and is never read here.
    const patchP0 = patch.P0;
    if (patchP0 === null) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'invalid_answers',
        message: 'Consent cannot be withdrawn through this endpoint',
        errors: [{ key: 'P0', message: 'consent cannot be cleared here' }],
      });
    }
    // A P0 counts only with an accepted copy version AND the sha256 of that
    // version's exact screen text (consult-consent-copy.ts): the record must
    // prove which text the client agreed to.
    if (isRecord(patchP0) && !isCurrentConsentAnswer(patchP0)) {
      throw conflict('consent_missing', 'Please accept the current version of the agreement');
    }
    // On file = a server stamp for an accepted version whose stored P0 still
    // proves that exact version's text.
    const consentOnFile = onFileConsentVersion(existing) !== null;
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

    // P0: server-stamped acknowledgement. Re-stamped when the copy version
    // changes, or when the stored stamp is not provable (Opus C-607-5: a
    // stored v3 whose P0 no longer proves the v3 text keeps no unproven
    // time), so a resume of a proven consent does not move the accepted time.
    const p0 = isRecord(merged.P0) ? merged.P0 : null;
    const p0Version = p0 ? consentCopyVersion(p0) : null;
    const disclaimer_version = p0Version;
    const disclaimer_accepted_at = p0Version
      ? consentOnFile &&
        existing?.disclaimer_version === p0Version &&
        existing.disclaimer_accepted_at
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

  /**
   * Map answers onto the profile (never screening) and refresh the profile
   * targets through the single profile write path (#606 B606-3): row lock,
   * merge onto the COMMITTED profile, compute from the merged row. The stored
   * targets therefore always equal the calculator applied to the stored row,
   * even when a PUT /profile races this save.
   */
  private async writeProfileFromAnswers(
    tx: Prisma.TransactionClient,
    clientId: string,
    answers: Answers,
    now: Date,
  ) {
    const fields = profileFieldsFromAnswers(answers);
    if (Object.keys(fields).length === 0) return;
    await writeProfileWithTargets(tx, clientId, fields, now, 'allow_incomplete');
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
      // True only while a CURRENT consent is on file (see onFileConsentVersion);
      // a stale or unprovable P0 reads false, so the app sends P0 first.
      consent_recorded: onFileConsentVersion(intake) !== null,
      saved_at: intake?.saved_at?.toISOString() ?? null,
      completed: Boolean(intake?.completed_at),
      completed_at: intake?.completed_at?.toISOString() ?? null,
      result: intake?.completed_at && intake.completion_result ? intake.completion_result : null,
    };
  }

  // ─── POST /me/onboarding/complete ──────────────────────────────────────
  async complete(clientId: string, now = new Date()): Promise<CompletionResult> {
    // A607-3: if the client's coach changes between the pre-checks and the
    // fenced final transaction, the attempt is rolled back (no write under
    // the former coach) and re-run once against the CURRENT attachment.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.completeOnce(clientId, now);
      } catch (err) {
        // C-607-3: a lock conflict the database resolved by aborting this
        // attempt (deadlock, serialization failure) rolled everything back;
        // it is re-run like an attachment change, then answered with the
        // retryable 409 below, never a bare 500.
        if (!(err instanceof TenancyChangedError) && !isLockConflict(err)) throw err;
        if (attempt >= COMPLETE_TENANCY_ATTEMPTS) {
          throw conflict(
            'completion_in_progress',
            'Your plan is being prepared. Try again in a moment',
          );
        }
      }
    }
  }

  private async completeOnce(clientId: string, now: Date): Promise<CompletionResult> {
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
      select: { id: true, name: true, role: true, coach_id: true, deleted_at: true },
    });
    if (!coach || coach.deleted_at || (coach.role !== 'coach' && coach.role !== 'owner')) {
      throw conflict('not_attached', 'This account is not attached to a coach yet');
    }
    // INT-607-1: the client clone's tenant is the coach's head ONLY when the
    // coach is an explicit member of that head's team (main's #597 rule); a
    // bare coach_id stamped by an old guest checkout keeps the clone in the
    // coach's own tenant, so a phantom head never lists the client's plans.
    const coachTeamHead = await this.membership.getHeadCoachIdForSubCoach(coach.id);

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
    // D2 box 1 only: the training waiver plus collection and use for
    // coaching, recorded on the intake as the server-stamped P0. The
    // optional AI box (box 2, #601 / R2a ledger) is never consulted here.
    // The stamp must name an accepted version AND the stored P0 must prove
    // that version's exact text (copy_version + text_sha256).
    if (onFileConsentVersion(intake) === null) {
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
    // completed. Nothing from an earlier attempt is replayed.
    const sel: ProgramSelection = selectProgram(selectionAnswersFrom(answers));
    const entry = readProgramEntry(set.programs, sel.program_key);
    if (!entry) throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");
    const startDate = String(answers.C1);
    const claimRevision = intake.current_revision;
    const masterIds = PROGRAM_KEYS.map((k) => readProgramEntry(set.programs, k)?.program_id).filter(
      (id): id is string => typeof id === 'string',
    );

    // B607-2: concurrency claim with a fencing token, bound to the exact
    // revision being completed.
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

    try {
      const flagCoach =
        screeningAnyYes(answers) || injuryFlag(answers) || sel.coach_review_required;
      const cohortIds = [set.all_members_cohort_id, entry.cohort_id];

      // EVERY completion effect, including the program clone, its
      // assignments and their snapshots, is written in this ONE transaction
      // (A607-2-R1): a stale or fenced-off attempt rolls back and nothing it
      // prepared ever becomes visible to the client or the coach. The
      // assignment push is sent only after the commit.
      const { out, push } = await this.prisma.$transaction(
        async (tx) => {
          // TENANCY FENCE (A607-3), first: lock the coach row, then the
          // client row, FOR SHARE. Any concurrent change of the attachment
          // (attach-code transfer, detach, deletion, role change) UPDATEs
          // one of these rows, so it either committed before this read (and
          // is seen here) or waits until this transaction ends. The coach
          // every effect below is written for is the one verified here.
          const liveCoach = await lockUserRow(tx, coach.id);
          const liveClient = await lockUserRow(tx, clientId);
          if (
            !liveCoach ||
            liveCoach.deleted_at ||
            (liveCoach.role !== 'coach' && liveCoach.role !== 'owner') ||
            !liveClient ||
            liveClient.deleted_at ||
            liveClient.role !== 'student' ||
            liveClient.coach_id !== coach.id
          ) {
            throw new TenancyChangedError();
          }
          // A-607-4: the clone's tenant is decided HERE, from the locked coach
          // row and the membership row that proves it (also locked FOR SHARE),
          // never from the read before this transaction: main retires a seat
          // or the last delegation without touching User. If the decision
          // differs from the pre-read, the attempt rolls back and re-runs
          // against the current team (same path as an attachment change).
          const tenantHead = await this.membership.lockMembershipHeadCoachIdInTx(
            tx,
            coach.id,
            liveCoach,
          );
          if (tenantHead !== coachTeamHead) throw new TenancyChangedError();

          // CLAIM FENCE: complete the row only while this worker still holds
          // (token, revision). Takes the intake row lock; a second worker
          // (lease expired) or a newer save serialises here and fails.
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

          const program = await this.materialiseAndAssignInTx(
            tx,
            { id: coach.id, tenant_id: tenantHead ?? coach.id },
            clientId,
            entry.program_id,
            sel,
            materialisation,
            startDate,
          );

          // Defence in depth: no other onboarding clone may stay assigned.
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

          const result: CompletionResult = {
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
            // In-app coach item. The body carries no screening details; the
            // coach opens the client's intake for the answers.
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
            data: { completion_result: toJson(result) },
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
          // Engagement hooks (welcome message scheduling, reminders) run
          // inside the same fenced transaction, under the verified coach, so
          // they happen exactly once and never for a former coach.
          for (const hook of this.completionHooks) {
            await hook.onCompleted(tx, {
              client_id: clientId,
              coach_id: coach.id,
              completed_at: now,
              first_session_date: startDate,
              preferred_training_time: typeof answers.S2 === 'string' ? answers.S2 : null,
            });
          }
          return {
            out: result,
            push: { assignment_id: program.assignment_ids[0], plan_id: program.first_plan_id },
          };
        },
        { maxWait: 10_000, timeout: COMPLETION_TX_TIMEOUT_MS },
      );
      // Only after the commit: one WORKOUT_ASSIGNED push for the program.
      this.workoutBuilder.notifyProgramAssigned(clientId, push.assignment_id, push.plan_id);
      return out;
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
      // Fenced off: another worker finalised or the answers moved on. This
      // attempt wrote nothing; report the winner or "in progress".
      if (err instanceof FencedClaimError) return this.replayOrInProgress(clientId, now);
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
   * tenancy) with frequency/equipment/extra-care applied, then fan the
   * program out to the client, all inside the caller's fenced completion
   * transaction. Nothing here is visible unless that transaction commits.
   */
  private async materialiseAndAssignInTx(
    tx: Prisma.TransactionClient,
    coach: { id: string; tenant_id: string },
    clientId: string,
    masterId: string,
    sel: ProgramSelection,
    m: Materialisation,
    startDate: string,
  ): Promise<{
    program_id: string;
    name: string;
    assignment_ids: string[];
    first_plan_id: string;
  }> {
    const tenantId = coach.tenant_id;
    const master = await tx.workoutProgram.findUnique({ where: { id: masterId } });
    // Tenancy: the master must be the attached coach's own live template.
    if (!master || master.owner_user_id !== coach.id || !master.is_template || master.archived_at) {
      throw conflict('clinic_not_configured', "Your coach's programs are not set up yet");
    }

    const masterPlans = await tx.workoutPlan.findMany({
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

    const clone = await writeProgramTree(tx, {
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
    });

    const assigned = await this.workoutBuilder.writeProgramAssignmentsInTx(
      tx,
      coach.id,
      clone.id,
      clientId,
      startDate,
    );
    return {
      program_id: clone.id,
      name: clone.name,
      assignment_ids: assigned.assignments.map((a) => a.id),
      first_plan_id: assigned.first_plan_id,
    };
  }
}
