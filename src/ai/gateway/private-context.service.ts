import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { User, UserProfile } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { ProvenanceRef } from './data-quality.types';
import { canCoachActOnClient } from '../../common/scope';
import { CREATE_WORKOUT_PLAN_CAPABILITY } from './materialisers/create-workout-plan.materialiser';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from './materialisers/edit-workout-plan.materialiser';
import { toInjuryAreas } from './workout-builder/training-substitutions';

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

  constructor(private prisma: PrismaService) {}

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
    const block = workout ? workoutBlock(subject.role, profile) : fullBlock;

    const systemPrompt =
      `You are an AI assistant operating inside The Growth Project.\n` +
      `Treat the CLIENT_CONTEXT block as the only source of truth about the client.\n` +
      `Outputs about consequential actions are drafts and require human approval.\n\n` +
      `CLIENT_CONTEXT:\n${JSON.stringify(block, null, 2)}`;

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

  // Self-context shortcut for the chat surface: same shape as
  // loadClientContext but the caller is implicitly the subject. Used by
  // the `chat.client_self` capability so a logged-in client can ask the
  // AI about their own state without involving a coach.
  async loadSelfContext(caller: CallerScope): Promise<ClientContextResult> {
    return this.loadClientContext(caller, caller.id);
  }

  private callerMaySee(
    caller: CallerScope,
    subject: { id: string; coach_id: string | null },
  ): boolean {
    if (caller.id === subject.id) return true; // self
    return canCoachActOnClient(
      { id: caller.id, role: caller.role, coach_id: caller.coach_id ?? null },
      { coach_id: subject.coach_id },
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

function hash(s: string): string {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}
