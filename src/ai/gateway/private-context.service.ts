import { ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { User, UserProfile } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { ProvenanceRef } from './data-quality.types';
import { canCoachActOnClient } from '../../common/scope';
import { CREATE_WORKOUT_PLAN_CAPABILITY } from './materialisers/create-workout-plan.materialiser';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from './materialisers/edit-workout-plan.materialiser';
import { toInjuryAreas } from './workout-builder/training-substitutions';
import { UNTRUSTED_TEXT_RULE, fenceUntrusted } from '../utils/untrusted-text';
import { ConsentScope, ConsentService } from '../../consent/consent.service';
import { seesWeight, weightIfShared } from '../../consent/coach-sharing-gate';
import { notInBlockWith } from '../../messaging/block-pair';
import { authorReadableBy } from '../../common/count-rule';
import { classifySafety } from '../../roman/guardrails/safety-router';
import { CHECK_IN_SOURCE } from './roman-message-draft';

// B-AIB3-126 (plan section 1, SAFE 2): the workout capabilities get the minimised block — no name, body weight, height,
// preferred snacks or coach message excerpt (the message row is not even read).
const WORKOUT_CAPABILITIES: ReadonlySet<string> = new Set([CREATE_WORKOUT_PLAN_CAPABILITY, EDIT_WORKOUT_PLAN_CAPABILITY]);

// Permissioned context retrieval for the AI gateway. The gateway never
// reads the database directly: capability-specific services call into
// PrivateContextService with the authenticated caller, and this service
// enforces the tenant boundary BEFORE returning any context.
//
// The contract is deliberately minimal in this PR — `loadClientContext`
// is the only fetch surface. New capabilities add new methods here, so
// every retrieval path lives behind one tenant-scoping checkpoint
// instead of being scattered across feature modules.

export interface ClientContextResult {
  systemPrompt: string;
  provenance: ProvenanceRef[];
}

export interface CheckInDraftRequest {
  /** Server-written; the check-in is inside the fence, so the gateway's redaction reaches it. */
  userMessage: string;
  provenance: ProvenanceRef;
}

/** The app's own words for "Roman will not draft this" (mobile DraftSheets.tsx). */
export const CHECK_IN_CANNOT_DRAFT = "Roman can't write this right now. Nothing was sent.";

const CHECK_IN_DRAFT_ASK =
  "Write a short, warm reply from me, their coach, to this client's check-in. " +
  'Speak to them directly and ask at most one easy question. ' +
  'The check-in is inside the client_data tags below. Use only what it says. ' +
  'Mood and energy, when present, are scores from one to five. ' +
  'Do not invent a feeling, a score, a comparison with other days, or an answer to a question they were not asked. ' +
  'If a field is missing, do not mention it. Reply with the message text only.';

interface CallerScope {
  id: string;
  // Tightened from `string` so callerMaySee can pass straight through to
  // canCoachActOnClient (which expects the Prisma Role enum, not a free
  // string). Real callers pass req.user.role which already has this
  // narrower type; tests pass the same string literals.
  role: User['role'];
  // For coach callers we use the User row's coach_id linkage to verify
  // ownership of the client. Owners bypass the tenant check.
  coach_id?: string | null;
}

@Injectable()
export class PrivateContextService {
  private readonly logger = new Logger(PrivateContextService.name);

  constructor(
    private prisma: PrismaService,
    // C8-S: the client's Weigh-ins switch for a coach caller. Deliberately NOT @Optional:
    // ConsentModule is @Global, so DI always injects it. Only positional unit tests omit it.
    private readonly consent?: ConsentService,
  ) {}

  // Loads a sanitized, structured snapshot of a client's coaching state
  // for AI consumption. Throws ForbiddenException if the caller is not
  // permitted to see the client's data.
  //
  // The returned `systemPrompt` contains only fields safe to send to a
  // provider — raw email/phone/auth identifiers are deliberately
  // excluded. Provenance refs cover every source the gateway should
  // attribute the call to.
  async loadClientContext(
    caller: CallerScope,
    subjectUserId: string,
    opts: { capability?: string } = {},
  ): Promise<ClientContextResult> {
    const workout = WORKOUT_CAPABILITIES.has(opts.capability ?? '');
    const subject = await this.prisma.user.findUnique({
      where: { id: subjectUserId },
      include: {
        profile: true,
        coach_messages_as_client: {
          // Owner 4b (HIST3): only the thread with the client's CURRENT coach;
          // a former coach's chat never reaches the new coach's AI context.
          // FX-1141 (Sol B2): and not a chat in a block either way.
          // ACTUAL-AUTHOR-READS-BE (LS-1197R2 B2): and none by an author in a
          // block with the caller, before `take` picks the newest.
          where: {
            coach: { students: { some: { id: subjectUserId } }, ...notInBlockWith(subjectUserId) },
            AND: [authorReadableBy(caller.id)],
          },
          orderBy: { created_at: 'desc' },
          take: workout ? 0 : 1,
        },
      },
    });
    if (!subject) throw new ForbiddenException('Subject not found');

    if (!this.callerMaySee(caller, subject)) {
      throw new ForbiddenException('Caller is not permitted to read this client context');
    }

    const profile = subject.profile;
    // C8-S: the client always reads their own weight; a coach only while Weigh-ins is shared.
    const weighIns = await seesWeight(this.consent, caller.id, subject.id, caller.role);
    const lastMessage = workout ? undefined : subject.coach_messages_as_client[0];

    // Sanitized, structured block. NEVER include email, phone,
    // supabase_id, or any internal-only IDs. The gateway will further
    // redact free-text inputs before sending them to a provider.
    const fullBlock = {
      identity: {
        first_name: subject.name?.split(' ')[0] ?? 'Client',
        role: subject.role,
      },
      profile: profile
        ? {
            goal_type: profile.goal_type,
            activity_level: profile.activity_level,
            workout_experience: profile.workout_experience,
            current_weight_lbs: profile.current_weight_lbs,
            target_weight_lbs: profile.target_weight_lbs,
            height_cm: profile.height_cm,
            preferred_snacks: profile.preferred_snacks,
            equipment_access: profile.equipment_access,
          }
        : null,
      last_coach_message_excerpt: lastMessage?.body?.slice(0, 240) ?? null,
    };
    const block = workout
      ? workoutBlock(subject.role, profile)
      : { ...fullBlock, profile: fullBlock.profile && weightIfShared(fullBlock.profile, weighIns) };

    const systemPrompt =
      `You are an AI assistant operating inside The Growth Project.\n` +
      `Treat the CLIENT_CONTEXT block as the only source of truth about the client.\n` +
      `Outputs about consequential actions are drafts and require human approval.\n` +
      `${UNTRUSTED_TEXT_RULE}\n\n` +
      `CLIENT_CONTEXT:\n${fenceUntrusted(block, 2)}`;

    const provenance: ProvenanceRef[] = [
      { source: 'user', ref: subject.id, count: 1, hash: hash(subject.id), origin: 'local' },
    ];
    if (profile) {
      provenance.push({
        source: 'user_profile',
        ref: profile.id,
        count: 1,
        hash: hash(JSON.stringify(profile)),
        origin: 'local',
      });
    }
    if (lastMessage) {
      provenance.push({
        source: 'coach_messages',
        ref: lastMessage.id,
        count: 1,
        hash: hash(lastMessage.body ?? ''),
        origin: 'local',
      });
    }
    return { systemPrompt, provenance };
  }

  /**
   * CHECKIN-DRAFT-BE: one check-in, as a server-written request for its reply draft. The caller has already
   * passed loadClientContext. Unknown, another client's and not shared are one identical 404 (no probing).
   * Sends only the note, mood, energy and sleep that are present; weight (its own switch) and soreness are not read.
   */
  async loadCheckInDraft(caller: CallerScope, clientId: string, checkInId: string): Promise<CheckInDraftRequest> {
    const row = clientId === caller.id
      ? null
      : await this.prisma.checkIn.findFirst({
          where: { id: checkInId, user_id: clientId },
          select: { id: true, date: true, notes: true, mood: true, energy: true, sleep_hours: true },
        });
    const shared = this.consent
      ? await this.consent.coachCanAccess(caller.id, clientId, ConsentScope.FITNESS_HABITS_PROGRESS, caller.role)
      : false;
    if (!row || !shared) throw new NotFoundException({ code: 'CHECK_IN_NOT_FOUND', message: 'Check-in not found' });

    const note = row.notes?.trim() || null;
    const numbers = { mood: row.mood, energy: row.energy, sleep_hours: row.sleep_hours };
    if (!note && Object.values(numbers).every((n) => n === null)) {
      throw new UnprocessableEntityException({ code: 'CHECK_IN_NOTHING_TO_DRAFT', message: CHECK_IN_CANNOT_DRAFT });
    }
    // The two checks Roman's own path makes: such a note gets the coach's own words, never a draft.
    if (note) {
      const safety = classifySafety(note);
      if (safety.short_circuit || safety.class === 'eating_disorder_risk') {
        throw new UnprocessableEntityException({ code: 'CHECK_IN_NEEDS_COACH', message: CHECK_IN_CANNOT_DRAFT });
      }
    }
    const sent = {
      ...(note ? { note: flatForRedaction(note) } : {}),
      ...Object.fromEntries(Object.entries(numbers).filter(([, n]) => n !== null)),
    };
    return {
      userMessage: `${CHECK_IN_DRAFT_ASK}\n\n${fenceUntrusted(sent, 2)}`,
      provenance: {
        source: CHECK_IN_SOURCE,
        ref: row.id,
        count: 1,
        hash: hash(JSON.stringify(sent)),
        origin: 'local',
        date: row.date.toISOString().slice(0, 10),
      },
    };
  }

  // Self-context shortcut for the chat surface: same shape as
  // loadClientContext but the caller is implicitly the subject. Used by
  // the `chat.client_self` capability so a logged-in client can ask the
  // AI about their own state without involving a coach.
  async loadSelfContext(caller: CallerScope): Promise<ClientContextResult> {
    return this.loadClientContext(caller, caller.id);
  }

  private callerMaySee(
    caller: CallerScope,
    subject: Pick<User, 'id' | 'role' | 'coach_id'>,
  ): boolean {
    if (caller.id === subject.id) return true; // self
    // Only a current client of the caller (or any subject for an owner).
    return canCoachActOnClient(
      { id: caller.id, role: caller.role, coach_id: caller.coach_id ?? null },
      subject,
    );
  }
}

function workoutBlock(role: User['role'], profile: UserProfile | null) {
  return {
    identity: { first_name: 'the client', role },
    profile: profile
      ? {
          goal_type: profile.goal_type,
          activity_level: profile.activity_level,
          workout_experience: profile.workout_experience,
          workout_days_per_week: profile.workout_days_per_week,
          equipment_access: profile.equipment_access,
          injuries: toInjuryAreas(profile.injuries),
        }
      : null,
  };
}

/**
 * The fence writes a newline as `\\n` and `<` as `\\u003c`, which glues the escape's last letter to the next word, so
 * the redaction patterns that start at a word boundary would miss a number there. One line, and < > & set apart.
 */
function flatForRedaction(note: string): string {
  return note.replace(/[<>&]/g, ' $& ').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

function hash(s: string): string {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}
