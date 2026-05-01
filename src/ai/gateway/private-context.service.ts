import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { ProvenanceRef } from './data-quality.types';
import { canCoachActOnClient } from '../../common/scope';

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
  role: string;
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
  ): Promise<ClientContextResult> {
    const subject = await this.prisma.user.findUnique({
      where: { id: subjectUserId },
      include: {
        profile: true,
        coach_messages_as_client: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });
    if (!subject) throw new ForbiddenException('Subject not found');

    if (!this.callerMaySee(caller, subject)) {
      throw new ForbiddenException('Caller is not permitted to read this client context');
    }

    const profile = subject.profile;
    const lastMessage = subject.coach_messages_as_client[0];

    // Sanitized, structured block. NEVER include email, phone,
    // supabase_id, or any internal-only IDs. The gateway will further
    // redact free-text inputs before sending them to a provider.
    const block = {
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
      { id: caller.id, role: caller.role as any, coach_id: caller.coach_id ?? null },
      { coach_id: subject.coach_id },
    );
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}
