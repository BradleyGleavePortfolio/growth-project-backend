import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { AuditService } from '../src/audit/audit.service';
import { CapabilityMaterializerRegistry } from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import type { CapabilityMaterializer } from '../src/ai/gateway/materialisers/capability-materialiser.interface';

// PR AI-3 (PRODUCT-1) — integration coverage for AiApprovalService.decide
// + CapabilityMaterializerRegistry. The unit specs cover each piece in
// isolation; these tests prove the wiring: that decide() resolves and
// calls the right materialiser exactly once on approve, never on reject,
// and that materialisation failures keep the draft in 'pending'.

function buildPrisma(seed: any[]) {
  const drafts = [...seed];
  return {
    drafts,
    aiActionDraft: {
      findUnique: jest.fn(async ({ where }: any) =>
        drafts.find((d) => d.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const i = drafts.findIndex((d) => d.id === where.id);
        drafts[i] = { ...drafts[i], ...data };
        return drafts[i];
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    aiRequestAudit: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      create: jest.fn(async () => ({ id: 'a-1' })),
    },
  } as any;
}

function makeMaterializer(capability: string, behaviour?: () => Promise<any>): CapabilityMaterializer & { calls: number } {
  const mat: any = {
    capability,
    canHandle: (c: string) => c === capability,
    calls: 0,
    materialize: jest.fn(async () => {
      mat.calls += 1;
      if (behaviour) return behaviour();
      return { status: 'sent', ref: 'downstream-1' };
    }),
  };
  return mat;
}

describe('AiApprovalService + CapabilityMaterializerRegistry (integration)', () => {
  it('decide(approved) on a draft.coach_message draft invokes the coach-message materialiser exactly once with the draft', async () => {
    const draft = {
      id: 'd-coach-1',
      status: 'pending',
      capability: 'draft.coach_message',
      requester_id: 'coach-1',
      subject_user_id: 'client-1',
      tenant_coach_id: 'coach-1',
      payload: { clientId: 'client-1', body: 'hi' },
    };
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);
    const coachMat = makeMaterializer('draft.coach_message');
    const workoutMat = makeMaterializer('draft.workout_program');
    const registry = new CapabilityMaterializerRegistry([coachMat, workoutMat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    const updated = await svc.decide({
      draftId: 'd-coach-1',
      decider: { id: 'owner-1', role: 'owner' },
      decision: 'approved',
    });

    expect(coachMat.materialize).toHaveBeenCalledTimes(1);
    // We expect the materialiser to receive the persisted draft row, not the
    // controller input — so the body/clientId pass through unchanged.
    expect(coachMat.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd-coach-1', capability: 'draft.coach_message' }),
    );
    expect(workoutMat.materialize).not.toHaveBeenCalled();
    expect(updated.status).toBe('approved');
    // Audit row should capture the downstream ref so support can trace.
    const auditMeta = prisma.auditLog.create.mock.calls[0][0].data.metadata;
    expect(auditMeta.materialised_ref).toBe('downstream-1');
  });

  it('decide(rejected) does NOT invoke any materialiser', async () => {
    const draft = {
      id: 'd-coach-2',
      status: 'pending',
      capability: 'draft.coach_message',
      requester_id: 'coach-1',
      subject_user_id: 'client-1',
      tenant_coach_id: 'coach-1',
      payload: { clientId: 'client-1', body: 'hi' },
    };
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);
    const coachMat = makeMaterializer('draft.coach_message');
    const registry = new CapabilityMaterializerRegistry([coachMat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    const updated = await svc.decide({
      draftId: 'd-coach-2',
      decider: { id: 'owner-1', role: 'owner' },
      decision: 'rejected',
      note: 'off-brand',
    });

    expect(coachMat.materialize).not.toHaveBeenCalled();
    expect(updated.status).toBe('rejected');
  });

  it('decide(approved) on a draft.workout_program draft does NOT call the coach-message materialiser', async () => {
    const draft = {
      id: 'd-workout-1',
      status: 'pending',
      // workout_program is NOT registered in this test's registry — it
      // materialises inline in coach-ai.service. AiApprovalService must
      // treat the absence as a no-op (preserving legacy behaviour) rather
      // than incorrectly dispatching to draft.coach_message's handler.
      capability: 'draft.workout_program',
      requester_id: 'coach-1',
      subject_user_id: 'client-1',
      tenant_coach_id: 'coach-1',
      payload: { days: [] },
    };
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);
    const coachMat = makeMaterializer('draft.coach_message');
    const registry = new CapabilityMaterializerRegistry([coachMat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    const updated = await svc.decide({
      draftId: 'd-workout-1',
      decider: { id: 'owner-1', role: 'owner' },
      decision: 'approved',
    });

    expect(coachMat.materialize).not.toHaveBeenCalled();
    expect(updated.status).toBe('approved');
  });

  it('keeps the draft in pending status (does NOT flip to approved) when the materialiser throws', async () => {
    const draft = {
      id: 'd-coach-3',
      status: 'pending',
      capability: 'draft.coach_message',
      requester_id: 'coach-1',
      subject_user_id: 'client-1',
      tenant_coach_id: 'coach-1',
      payload: { clientId: 'client-1', body: 'hi' },
    };
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);
    const coachMat = makeMaterializer('draft.coach_message', async () => {
      throw new Error('downstream messaging failure');
    });
    const registry = new CapabilityMaterializerRegistry([coachMat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    await expect(
      svc.decide({
        draftId: 'd-coach-3',
        decider: { id: 'owner-1', role: 'owner' },
        decision: 'approved',
      }),
    ).rejects.toThrow();

    // The draft row was NOT updated to approved — that's the entire point
    // of PR AI-3: status MUST NOT flip unless materialisation succeeded.
    expect(prisma.drafts[0].status).toBe('pending');
    // And we wrote a materialise-failed audit so ops can spot patterns.
    const auditActions = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data.action);
    expect(auditActions).toContain('ai.draft_materialise_failed');
  });

  it('preserves legacy behaviour when constructed without a registry (status flips, no materialisation attempted)', async () => {
    const draft = {
      id: 'd-coach-4',
      status: 'pending',
      capability: 'draft.coach_message',
      requester_id: 'coach-1',
      subject_user_id: 'client-1',
      tenant_coach_id: 'coach-1',
      payload: { clientId: 'client-1', body: 'hi' },
    };
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);
    // No registry passed — exercise the legacy DI shape that older callers
    // still use. Required so the @Optional() decorator works in practice.
    const svc = new AiApprovalService(prisma, audit);
    const updated = await svc.decide({
      draftId: 'd-coach-4',
      decider: { id: 'owner-1', role: 'owner' },
      decision: 'approved',
    });
    expect(updated.status).toBe('approved');
  });
});
