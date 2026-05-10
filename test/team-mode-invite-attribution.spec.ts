// test/team-mode-invite-attribution.spec.ts
//
// ADR-0001 §10 Q5: sub-coaches may invite clients directly. The
// invite_codes.service auto-detects whether the calling coach is
// actually a sub-coach (via TeamSubCoachAssignment), redirects
// coach_id to the head coach so existing tenancy + signup flows
// keep working, and stamps invited_by_user_id with the sub-coach's
// id. A matching invite_sent_by_sub_coach team audit event is
// written best-effort.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

interface MockPrisma {
  inviteCode: {
    create: jest.Mock;
    findUnique?: jest.Mock;
    findMany?: jest.Mock;
  };
  teamSubCoachAssignment: {
    findFirst: jest.Mock;
  };
  teamAuditEvent: {
    create: jest.Mock;
  };
}

function buildPrisma(opts: {
  isSubCoach: boolean;
  headCoachId?: string;
}): MockPrisma {
  return {
    inviteCode: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'invite-1',
        code: 'ABC123',
        ...args.data,
        created_at: new Date(),
        used_count: 0,
        revoked: false,
      })),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async () =>
        opts.isSubCoach
          ? { head_coach_id: opts.headCoachId ?? 'head-1' }
          : null,
      ),
    },
    teamAuditEvent: {
      create: jest.fn(async () => ({ id: 'evt-1' })),
    },
  };
}

function makeService(prisma: MockPrisma) {
  // InviteCodesService takes (prisma, analytics). Only prisma is
  // touched in the createForCoach happy path; analytics is best-
  // effort and stays inert here.
  const analytics = { capture: jest.fn() } as never;
  const svc = new InviteCodesService(prisma as never, analytics);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  return svc;
}

describe('InviteCodesService.createForCoach — Q5 sub-coach attribution', () => {
  it('head coach (no sub-coach assignment) writes invite with their own coach_id and null attribution', async () => {
    const prisma = buildPrisma({ isSubCoach: false });
    const svc = makeService(prisma);

    const result = await svc.createForCoach('head-1', { max_uses: 1 });

    expect(prisma.teamSubCoachAssignment.findFirst).toHaveBeenCalled();
    const created = prisma.inviteCode.create.mock.calls[0]?.[0] as {
      data: { coach_id: string; invited_by_user_id: string | null };
    };
    expect(created.data.coach_id).toBe('head-1');
    expect(created.data.invited_by_user_id).toBeNull();
    expect(result.coach_id).toBe('head-1');
    // No audit event written for non-sub-coach invite.
    expect(prisma.teamAuditEvent.create).not.toHaveBeenCalled();
  });

  it('sub-coach invite redirects coach_id to head coach + stamps invited_by_user_id + writes audit event', async () => {
    const prisma = buildPrisma({ isSubCoach: true, headCoachId: 'head-7' });
    const svc = makeService(prisma);

    const result = await svc.createForCoach('sub-9', { max_uses: 1 });

    const created = prisma.inviteCode.create.mock.calls[0]?.[0] as {
      data: { coach_id: string; invited_by_user_id: string | null };
    };
    expect(created.data.coach_id).toBe('head-7');
    expect(created.data.invited_by_user_id).toBe('sub-9');
    expect(result.coach_id).toBe('head-7');

    // Q4 audit event written.
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.teamAuditEvent.create.mock.calls[0]?.[0] as {
      data: {
        head_coach_id: string;
        actor_user_id: string;
        event_kind: string;
      };
    };
    expect(auditArgs.data.head_coach_id).toBe('head-7');
    expect(auditArgs.data.actor_user_id).toBe('sub-9');
    expect(auditArgs.data.event_kind).toBe('invite_sent_by_sub_coach');
  });

  it('explicit invited_by_user_id input bypasses auto-detection (caller wins)', async () => {
    // If the team-mode service ever pre-resolves attribution and passes
    // it in, we trust the caller — do NOT re-query.
    const prisma = buildPrisma({ isSubCoach: true, headCoachId: 'head-7' });
    const svc = makeService(prisma);

    await svc.createForCoach('head-7', {
      max_uses: 1,
      invited_by_user_id: null,
    });

    const created = prisma.inviteCode.create.mock.calls[0]?.[0] as {
      data: { coach_id: string; invited_by_user_id: string | null };
    };
    expect(created.data.coach_id).toBe('head-7');
    expect(created.data.invited_by_user_id).toBeNull();
    // Auto-detection skipped when caller supplied the field.
    expect(prisma.teamSubCoachAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.teamAuditEvent.create).not.toHaveBeenCalled();
  });

  it('audit event write failure does not roll back the invite create', async () => {
    const prisma = buildPrisma({ isSubCoach: true, headCoachId: 'head-7' });
    prisma.teamAuditEvent.create = jest.fn(async () => {
      throw new Error('audit_write_failed');
    });
    const svc = makeService(prisma);

    const result = await svc.createForCoach('sub-9', { max_uses: 1 });

    // Invite still created and returned even when audit failed.
    expect(result.coach_id).toBe('head-7');
    expect(result.invited_by_user_id).toBe('sub-9');
    expect(prisma.inviteCode.create).toHaveBeenCalledTimes(1);
  });
});
