import {
  CoachMessageMaterializer,
  CoachMessagePayloadSchema,
  assertCoachMessagePayload,
} from '../src/ai/gateway/materialisers/coach-message.materialiser';

// PR AI-3 (PRODUCT-1) — CoachMessageMaterializer behaviour.
// These tests cover the full happy + sad paths around the silent-send
// regression: validation, sendAsCoach dispatch, idempotency on the
// materialised_at column, and rollback when sendAsCoach throws.

const VALID_DRAFT = (overrides: Partial<any> = {}): any => ({
  id: '11111111-1111-1111-1111-111111111111',
  capability: 'draft.coach_message',
  status: 'pending',
  requester_id: 'coach-1',
  subject_user_id: '22222222-2222-2222-2222-222222222222',
  tenant_coach_id: 'coach-1',
  payload: {
    clientId: '22222222-2222-2222-2222-222222222222',
    body: 'Quick reminder about your check-in this week.',
  },
  materialised_at: null,
  materialised_ref: null,
  ...overrides,
});

function buildPrisma(initialDraft: any) {
  // Single in-memory draft row plus the small slice of the prisma surface
  // CoachMessageMaterializer touches. We mirror Prisma's `updateMany` /
  // `update` semantics closely enough that the optimistic-lock branch is
  // exercised end-to-end.
  let row = { ...initialDraft };
  return {
    row: () => row,
    aiActionDraft: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === row.id ? row : null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== row.id) throw new Error('not found');
        row = { ...row, ...data };
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== row.id) return { count: 0 };
        if (where.materialised_at === null && row.materialised_at !== null) {
          return { count: 0 };
        }
        if (
          where.materialised_at &&
          typeof where.materialised_at === 'object' &&
          'not' in where.materialised_at &&
          where.materialised_at.not === null &&
          row.materialised_at === null
        ) {
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      }),
    },
  } as any;
}

function buildMessaging() {
  return {
    sendAsCoach: jest.fn(async (_coachId: string, _clientId: string, _payload: any) => ({
      id: 'msg-abc-123',
    })),
  } as any;
}

describe('CoachMessagePayloadSchema', () => {
  it('accepts the canonical { clientId, body } shape', () => {
    const ok = CoachMessagePayloadSchema.safeParse({
      clientId: '22222222-2222-2222-2222-222222222222',
      body: 'hello',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects missing clientId', () => {
    const r = CoachMessagePayloadSchema.safeParse({ body: 'hi' });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid clientId', () => {
    const r = CoachMessagePayloadSchema.safeParse({
      clientId: 'not-a-uuid',
      body: 'hi',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty / whitespace-only body', () => {
    const base = { clientId: '22222222-2222-2222-2222-222222222222' };
    expect(CoachMessagePayloadSchema.safeParse({ ...base, body: '' }).success).toBe(false);
    expect(CoachMessagePayloadSchema.safeParse({ ...base, body: '   ' }).success).toBe(false);
  });

  it('rejects extra properties (strict mode prevents schema drift)', () => {
    const r = CoachMessagePayloadSchema.safeParse({
      clientId: '22222222-2222-2222-2222-222222222222',
      body: 'hi',
      smuggled: 'value',
    });
    expect(r.success).toBe(false);
  });

  it('rejects oversize bodies', () => {
    const r = CoachMessagePayloadSchema.safeParse({
      clientId: '22222222-2222-2222-2222-222222222222',
      body: 'x'.repeat(4001),
    });
    expect(r.success).toBe(false);
  });

  it('assertCoachMessagePayload throws on malformed input', () => {
    expect(() => assertCoachMessagePayload({ body: 'no client' })).toThrow();
  });
});

describe('CoachMessageMaterializer', () => {
  it('canHandle identifies the draft.coach_message capability and nothing else', () => {
    const mat = new CoachMessageMaterializer({} as any, {} as any);
    expect(mat.canHandle('draft.coach_message')).toBe(true);
    expect(mat.canHandle('draft.workout_program')).toBe(false);
    expect(mat.canHandle('chat.client_self')).toBe(false);
    expect(mat.canHandle('')).toBe(false);
  });

  it('calls MessagingService.sendAsCoach with tenant/client/body and records the ref', async () => {
    const draft = VALID_DRAFT();
    const prisma = buildPrisma(draft);
    const messaging = buildMessaging();
    const mat = new CoachMessageMaterializer(prisma, messaging);
    const result = await mat.materialize(draft);
    expect(messaging.sendAsCoach).toHaveBeenCalledTimes(1);
    expect(messaging.sendAsCoach).toHaveBeenCalledWith('coach-1', draft.payload.clientId, {
      body: draft.payload.body,
    });
    expect(result).toEqual({ status: 'sent', ref: 'msg-abc-123' });
    // The draft row is marked materialised + carries the downstream ref.
    expect(prisma.row().materialised_at).not.toBeNull();
    expect(prisma.row().materialised_ref).toBe('msg-abc-123');
  });

  it('is idempotent: a second materialise on an already-materialised draft does NOT re-send', async () => {
    const draft = VALID_DRAFT({
      materialised_at: new Date('2026-01-01T00:00:00Z'),
      materialised_ref: 'msg-prior',
    });
    const prisma = buildPrisma(draft);
    const messaging = buildMessaging();
    const mat = new CoachMessageMaterializer(prisma, messaging);
    const result = await mat.materialize(draft);
    expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'already_materialised', ref: 'msg-prior' });
  });

  it('handles the optimistic-lock race: when the conditional UPDATE matches zero rows, it returns already_materialised without sending', async () => {
    // Build a draft that LOOKS pending in-memory but the conditional UPDATE
    // refuses (simulating a concurrent approver that already claimed it).
    const draft = VALID_DRAFT();
    const prisma = buildPrisma(draft);
    // Force the next updateMany to report 0 rows updated (race-loser path).
    prisma.aiActionDraft.updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 });
    // The materialiser will then re-read the row to discover the winner's
    // ref. Pretend the winner already wrote one.
    prisma.aiActionDraft.findUnique = jest.fn(async () => ({
      ...draft,
      materialised_at: new Date(),
      materialised_ref: 'msg-winner',
    }));
    const messaging = buildMessaging();
    const mat = new CoachMessageMaterializer(prisma, messaging);
    const result = await mat.materialize(draft);
    expect(messaging.sendAsCoach).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'already_materialised', ref: 'msg-winner' });
  });

  it('rolls back the materialisation claim when sendAsCoach throws so a retry can succeed', async () => {
    const draft = VALID_DRAFT();
    const prisma = buildPrisma(draft);
    const messaging = buildMessaging();
    messaging.sendAsCoach = jest.fn(async () => {
      throw new Error('messaging blew up');
    });
    const mat = new CoachMessageMaterializer(prisma, messaging);
    await expect(mat.materialize(draft)).rejects.toThrow('messaging blew up');
    // Rollback path: materialised_at must be back to null so the next
    // approve attempt can claim and retry.
    expect(prisma.row().materialised_at).toBeNull();
  });

  it('rejects when the persisted payload drifts from the schema (defence in depth)', async () => {
    const draft = VALID_DRAFT({
      payload: { client: 'wrong-key-name', body: 'hi' },
    });
    const prisma = buildPrisma(draft);
    const messaging = buildMessaging();
    const mat = new CoachMessageMaterializer(prisma, messaging);
    await expect(mat.materialize(draft)).rejects.toThrow();
    expect(messaging.sendAsCoach).not.toHaveBeenCalled();
  });

  it('refuses to materialise a draft without a tenant_coach_id (no sender)', async () => {
    const draft = VALID_DRAFT({ tenant_coach_id: null });
    const prisma = buildPrisma(draft);
    const messaging = buildMessaging();
    const mat = new CoachMessageMaterializer(prisma, messaging);
    await expect(mat.materialize(draft)).rejects.toThrow(/tenant_coach_id/);
    expect(messaging.sendAsCoach).not.toHaveBeenCalled();
  });
});
