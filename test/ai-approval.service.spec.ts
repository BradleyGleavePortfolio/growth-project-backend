import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { AuditService } from '../src/audit/audit.service';

function buildPrisma(seed: any[] = []) {
  const drafts: any[] = [...seed];
  return {
    drafts,
    aiActionDraft: {
      findUnique: jest.fn(async ({ where }: any) =>
        drafts.find((d) => d.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where, take }: any) => {
        const rows = drafts.filter((d) => {
          if (where?.status && d.status !== where.status) return false;
          if (where?.tenant_coach_id && d.tenant_coach_id !== where.tenant_coach_id) return false;
          if (where?.subject_user_id && d.subject_user_id !== where.subject_user_id) return false;
          return true;
        });
        return rows.slice(0, take ?? 50);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const i = drafts.findIndex((d) => d.id === where.id);
        drafts[i] = { ...drafts[i], ...data };
        return drafts[i];
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    aiRequestAudit: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      create: jest.fn(async () => ({ id: 'a-1' })),
    },
  } as any;
}

function makeAudit(prisma: any) {
  return new AuditService(prisma);
}

describe('AiApprovalService', () => {
  it('approves a pending draft and writes an AuditLog row', async () => {
    const prisma = buildPrisma([
      {
        id: 'd-1',
        status: 'pending',
        capability: 'draft.coach_message',
        requester_id: 'coach-1',
        subject_user_id: 'client-1',
        tenant_coach_id: 'coach-1',
      },
    ]);
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    const updated = await svc.decide({
      draftId: 'd-1',
      decider: { id: 'owner-1', role: 'owner' },
      decision: 'approved',
      note: 'looks good',
    });
    expect(updated.status).toBe('approved');
    expect(updated.decided_by_id).toBe('owner-1');
    expect(prisma.aiRequestAudit.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditData.action).toBe('ai.draft_approved');
    expect(auditData.target_id).toBe('d-1');
  });

  it('refuses to let the requester approve their own draft', async () => {
    const prisma = buildPrisma([
      {
        id: 'd-1',
        status: 'pending',
        capability: 'draft.coach_message',
        requester_id: 'coach-1',
        tenant_coach_id: 'coach-1',
      },
    ]);
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    await expect(
      svc.decide({
        draftId: 'd-1',
        decider: { id: 'coach-1', role: 'coach' },
        decision: 'approved',
      }),
    ).rejects.toThrow(/requester/);
  });

  it('refuses cross-tenant approval by a coach', async () => {
    const prisma = buildPrisma([
      {
        id: 'd-1',
        status: 'pending',
        capability: 'draft.coach_message',
        requester_id: 'coach-A',
        tenant_coach_id: 'coach-A',
      },
    ]);
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    await expect(
      svc.decide({
        draftId: 'd-1',
        decider: { id: 'coach-B', role: 'coach' },
        decision: 'approved',
      }),
    ).rejects.toThrow(/outside your tenant/);
  });

  it('refuses to decide an already-decided draft', async () => {
    const prisma = buildPrisma([
      {
        id: 'd-1',
        status: 'approved',
        capability: 'draft.coach_message',
        requester_id: 'coach-1',
        tenant_coach_id: 'coach-1',
      },
    ]);
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    await expect(
      svc.decide({
        draftId: 'd-1',
        decider: { id: 'owner-1', role: 'owner' },
        decision: 'rejected',
      }),
    ).rejects.toThrow(/already approved/);
  });

  it('rejects non-coach / non-owner approvers', async () => {
    const prisma = buildPrisma([
      {
        id: 'd-1',
        status: 'pending',
        capability: 'draft.coach_message',
        requester_id: 'coach-1',
        tenant_coach_id: 'coach-1',
      },
    ]);
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    await expect(
      svc.decide({
        draftId: 'd-1',
        decider: { id: 'student-1', role: 'student' },
        decision: 'approved',
      }),
    ).rejects.toThrow(/not permitted/);
  });

  it('expireStaleDrafts marks pending rows past expires_at and writes an audit row', async () => {
    const prisma = buildPrisma();
    prisma.aiActionDraft.updateMany = jest.fn().mockResolvedValue({ count: 3 });
    const svc = new AiApprovalService(prisma, makeAudit(prisma));
    const count = await svc.expireStaleDrafts(new Date('2026-05-01T00:00:00Z'));
    expect(count).toBe(3);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditData.action).toBe('ai.drafts_expired');
    expect(auditData.metadata.count).toBe(3);
  });
});
