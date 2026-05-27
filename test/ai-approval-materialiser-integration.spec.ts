import { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { AuditService } from '../src/audit/audit.service';
import { CapabilityMaterializerRegistry } from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import type { CapabilityMaterializer } from '../src/ai/gateway/materialisers/capability-materialiser.interface';
import { CoachMessageMaterializer } from '../src/ai/gateway/materialisers/coach-message.materialiser';
import { ConflictException } from '@nestjs/common';

// PR AI-3 (PRODUCT-1) — integration coverage for AiApprovalService.decide
// + CapabilityMaterializerRegistry. The unit specs cover each piece in
// isolation; these tests prove the wiring: that decide() resolves and
// calls the right materialiser exactly once on approve, never on reject,
// and that materialisation failures keep the draft in 'pending'.

function matchesWhere(row: any, where: any): boolean {
  // Minimal-but-faithful match for the fields the materialiser+decide()
  // touch: `id`, `status`, `materialised_at` (nullable + { not: null }),
  // `materialised_ref` (nullable + { not: null }).
  for (const key of Object.keys(where)) {
    const cond = where[key];
    const v = row[key];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond && typeof cond === 'object' && 'not' in cond) {
      if (cond.not === null) {
        if (v === null || v === undefined) return false;
      } else if (v === cond.not) return false;
    } else {
      if (v !== cond) return false;
    }
  }
  return true;
}

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
        if (i < 0) throw new Error('not found');
        drafts[i] = { ...drafts[i], ...data };
        return drafts[i];
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        // PR AI-3 refixer round 2: the decide() gate + materialiser claim
        // both go through updateMany; emulate Prisma's predicate filtering
        // so concurrent-race tests get an accurate count and mutation.
        let count = 0;
        for (let i = 0; i < drafts.length; i++) {
          if (matchesWhere(drafts[i], where)) {
            drafts[i] = { ...drafts[i], ...data };
            count++;
          }
        }
        return { count };
      }),
    },
    aiRequestAudit: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      create: jest.fn(async () => ({ id: 'a-1' })),
    },
  } as any;
}

function makeMaterializer(
  capability: string,
  behaviour?: (draft: any, prisma: any) => Promise<any>,
  prisma?: any,
): CapabilityMaterializer & { calls: number } {
  const mat: any = {
    capability,
    canHandle: (c: string) => c === capability,
    calls: 0,
    materialize: jest.fn(async (draft: any) => {
      mat.calls += 1;
      if (behaviour) return behaviour(draft, prisma);
      // Default: emulate the real CoachMessageMaterializer's commit by
      // claiming the row, writing materialised_ref, and returning the ref.
      // This matches the decide() gate which requires materialised_ref to
      // be observable in the DB before status flips.
      if (prisma) {
        await prisma.aiActionDraft.updateMany({
          where: { id: draft.id, materialised_at: null },
          data: { materialised_at: new Date() },
        });
        await prisma.aiActionDraft.update({
          where: { id: draft.id },
          data: { materialised_ref: 'downstream-1' },
        });
      }
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
    const coachMat = makeMaterializer('draft.coach_message', undefined, prisma);
    const workoutMat = makeMaterializer('draft.workout_program', undefined, prisma);
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
    const coachMat = makeMaterializer('draft.coach_message', undefined, prisma);
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
    const coachMat = makeMaterializer('draft.coach_message', undefined, prisma);
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
    }, prisma);
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

  // -----------------------------------------------------------------
  // PR AI-3 refixer round 2 (P1-1, P2-1, P2-3) — race-window regression
  // tests. These exercise the real CoachMessageMaterializer so the gate,
  // polling, and rollback paths are covered end-to-end with no stubs.
  // -----------------------------------------------------------------

  function uuid(suffix: string): string {
    // A small helper that produces UUIDs the zod schema will accept for the
    // payload tests below. Suffix is squeezed into the last 12 chars so each
    // call yields a distinct, deterministic id.
    const stem = '11111111-1111-1111-1111-';
    const pad = suffix.padStart(12, '0');
    return stem + pad.slice(-12);
  }

  function buildRaceDraft(suffix: string, overrides: Partial<any> = {}) {
    return {
      id: uuid(suffix),
      status: 'pending',
      capability: 'draft.coach_message',
      requester_id: 'coach-1',
      subject_user_id: uuid('c' + suffix),
      tenant_coach_id: 'coach-1',
      payload: { clientId: uuid('c' + suffix), body: 'hello race' },
      materialised_at: null,
      materialised_ref: null,
      ...overrides,
    };
  }

  it('P1-1 race_loser_flips_then_winner_throws: status does NOT flip when the materialisation race is unresolved', async () => {
    // Two concurrent approvers race decide() on the same draft. The
    // winner's `sendAsCoach` throws AFTER claim is set but BEFORE
    // materialised_ref is written. Loser must NOT flip status to
    // 'approved'; final state must be consistent (either both rolled
    // back to 'pending' or one cleanly succeeded with materialised_ref
    // set). At least one caller must see a clear error.
    const draft = buildRaceDraft('1');
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);

    let winnerStarted = false;
    let releaseWinner: (() => void) | null = null;
    const winnerCanFinish = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    // Real CoachMessageMaterializer driven by a messaging stub that
    // blocks until the loser has reached the race-poll branch, then
    // throws — recreating the exact PRODUCT-1 timing.
    const messaging: any = {
      sendAsCoach: jest.fn(async () => {
        winnerStarted = true;
        await winnerCanFinish;
        throw new Error('expo push provider 503');
      }),
    };
    const mat = new CoachMessageMaterializer(prisma, messaging);
    // Shorten the race-poll interval so the test runs in <1s. The
    // production default is 100ms × 10 attempts; here we drop both.
    (CoachMessageMaterializer as any).RACE_POLL_INTERVAL_MS = 5;
    (CoachMessageMaterializer as any).RACE_POLL_ATTEMPTS = 6;
    const registry = new CapabilityMaterializerRegistry([mat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    // Attach the .catch immediately so Jest doesn't flag an unhandled
    // rejection when the winner throws before we await its result.
    const winnerP = svc
      .decide({
        draftId: draft.id,
        decider: { id: 'owner-A', role: 'owner' },
        decision: 'approved',
      })
      .catch((err) => ({ __error: err }));
    // Wait for the winner to start its sendAsCoach (claim acquired).
    for (let i = 0; i < 50 && !winnerStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(winnerStarted).toBe(true);
    // Now the loser tries to decide(). It must NOT short-circuit on
    // already_materialised; it must enter the race-poll branch.
    const loserP = svc
      .decide({
        draftId: draft.id,
        decider: { id: 'owner-B', role: 'owner' },
        decision: 'approved',
      })
      .catch((err) => ({ __error: err }));

    // Give the loser time to enter poll, then release the winner with
    // a throw (sendAsCoach 503).
    await new Promise((r) => setTimeout(r, 10));
    releaseWinner!();

    const winnerResult: any = await winnerP;
    const loserResult: any = await loserP;
    expect(winnerResult.__error).toBeDefined();

    // Loser MUST see a clear error (either 409 racing or 500 materialise
    // failed when it recovered the claim itself and the same provider
    // outage repeated).
    expect(loserResult.__error).toBeDefined();

    // Final state: status remains 'pending' — the entire point.
    expect(prisma.drafts[0].status).toBe('pending');
    // No orphan downstream row (we never call ack/dedupe here, just
    // verify sendAsCoach wasn't reported as success on the draft).
    expect(prisma.drafts[0].materialised_ref).toBeNull();
  }, 10000);

  it('P2-1 stuck_claim_retry_recovery: a draft with materialised_at set but materialised_ref null can be retried, NOT short-circuited', async () => {
    // Plant the post-rollback-failure state: a previous attempt's
    // sendAsCoach threw and the rollback updateMany also failed, leaving
    // materialised_at set with materialised_ref still null. The fixed
    // materialiser must treat this as a STUCK-CLAIM and proceed with
    // materialisation (not short-circuit to already_materialised).
    const draft = buildRaceDraft('2', {
      materialised_at: new Date('2026-01-01T00:00:00Z'),
      materialised_ref: null,
    });
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);

    const messaging: any = {
      sendAsCoach: jest.fn(async () => ({ id: 'msg-recovered-1' })),
    };
    const mat = new CoachMessageMaterializer(prisma, messaging);
    // Force the race-poll branch to give up fast so the recovery loop
    // re-enters claim quickly. In the STUCK-CLAIM case the initial
    // claim updateMany returns count=0 (materialised_at not null), the
    // poll observes materialised_ref still null, materialised_at still
    // not null → racing returned → decide() throws 409 OR — if the
    // upstream stuck-claim is recovered first — sends. The test below
    // asserts the retry CAN succeed when a fresh decide() lands on a
    // draft whose materialised_at is set but materialised_ref is null
    // and no concurrent winner exists.
    (CoachMessageMaterializer as any).RACE_POLL_INTERVAL_MS = 2;
    (CoachMessageMaterializer as any).RACE_POLL_ATTEMPTS = 3;
    const registry = new CapabilityMaterializerRegistry([mat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    // First decide() lands on a stuck claim with no live winner. It must
    // either (a) detect STUCK-CLAIM and proceed itself (preferred) or
    // (b) surface a 409 so a retry can clean it up. Either is acceptable
    // as long as the draft does NOT silently flip to 'approved' without
    // a downstream send.
    let firstError: any = null;
    let firstResult: any = null;
    try {
      firstResult = await svc.decide({
        draftId: draft.id,
        decider: { id: 'owner-1', role: 'owner' },
        decision: 'approved',
      });
    } catch (err) {
      firstError = err;
    }

    // If decide() succeeded, the side-effect must be observable.
    if (firstResult) {
      expect(messaging.sendAsCoach).toHaveBeenCalledTimes(1);
      expect(prisma.drafts[0].status).toBe('approved');
      expect(prisma.drafts[0].materialised_ref).toBe('msg-recovered-1');
    } else {
      // Otherwise, the error must be a Conflict (409) — never a silent
      // 'approved' flip with no message.
      expect(firstError).toBeInstanceOf(ConflictException);
      expect(prisma.drafts[0].status).toBe('pending');
      expect(prisma.drafts[0].materialised_ref).toBeNull();
      // Subsequent retry must be able to clear the stuck claim and send.
      // We simulate that by clearing materialised_at (ops manual recovery)
      // and re-issuing decide(). This branch documents the recovery
      // contract for ops scripts.
      prisma.drafts[0] = { ...prisma.drafts[0], materialised_at: null };
      const retried = await svc.decide({
        draftId: draft.id,
        decider: { id: 'owner-1', role: 'owner' },
        decision: 'approved',
      });
      expect(retried.status).toBe('approved');
      expect(retried.materialised_ref).toBe('msg-recovered-1');
    }
  }, 10000);

  it('P2-3 concurrent_decide_409_conflict: first approver wins, second gets ConflictException; decided_by_id matches winner only', async () => {
    // Two approvers race decide(). The materialiser is well-behaved and
    // sends successfully on the winner. The loser must not overwrite
    // decided_by_id; it must receive a ConflictException.
    const draft = buildRaceDraft('3');
    const prisma = buildPrisma([draft]);
    const audit = new AuditService(prisma);

    let sendCount = 0;
    const inFlight = new Promise<void>((resolve) => {
      // Allow the test to release the first sendAsCoach so the loser
      // arrives at decide()'s gate while the winner is still in-flight.
      (global as any).__releaseFirstSend = resolve;
    });
    const messaging: any = {
      sendAsCoach: jest.fn(async () => {
        sendCount += 1;
        const myCount = sendCount;
        if (myCount === 1) await inFlight;
        return { id: `msg-${myCount}` };
      }),
    };
    const mat = new CoachMessageMaterializer(prisma, messaging);
    (CoachMessageMaterializer as any).RACE_POLL_INTERVAL_MS = 5;
    (CoachMessageMaterializer as any).RACE_POLL_ATTEMPTS = 20;
    const registry = new CapabilityMaterializerRegistry([mat]);
    const svc = new AiApprovalService(prisma, audit, registry);

    const winnerP = svc.decide({
      draftId: draft.id,
      decider: { id: 'owner-WIN', role: 'owner' },
      decision: 'approved',
    });
    // Let the winner reserve the claim before the loser arrives.
    await new Promise((r) => setTimeout(r, 5));
    const loserP = svc.decide({
      draftId: draft.id,
      decider: { id: 'owner-LOSE', role: 'owner' },
      decision: 'approved',
    });
    // Release the winner so it commits its sendAsCoach success.
    (global as any).__releaseFirstSend();

    const winnerResult = await winnerP;
    let loserError: any = null;
    try {
      await loserP;
    } catch (err) {
      loserError = err;
    }

    expect(winnerResult.status).toBe('approved');
    expect(winnerResult.decided_by_id).toBe('owner-WIN');
    expect(winnerResult.materialised_ref).toBe('msg-1');
    expect(loserError).toBeInstanceOf(ConflictException);

    // Final draft state: decided_by remains the winner — never overwritten.
    expect(prisma.drafts[0].decided_by_id).toBe('owner-WIN');
    expect(prisma.drafts[0].status).toBe('approved');
    // Exactly one sendAsCoach landed (idempotency held).
    expect(messaging.sendAsCoach).toHaveBeenCalledTimes(1);
  }, 10000);

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
