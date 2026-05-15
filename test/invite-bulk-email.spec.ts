import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

// Exercises the bulkInvite + sendInviteEmailForCode wiring against a
// stubbed EmailService. The point of this spec is the contract between
// bulkInvite and EmailService — not the DB layer — so Prisma is mocked
// just enough to round-trip a created InviteCode row.

function buildPrismaMock() {
  let nextId = 1;
  return {
    inviteCode: {
      create: jest.fn(async ({ data }: any) => ({
        id: `ic-${nextId++}`,
        ...data,
        created_at: new Date(),
        used_count: 0,
        revoked: false,
      })),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'coach-1'
          ? { id: 'coach-1', name: 'Sam Trainer', email: 'sam@example.com' }
          : null,
      ),
    },
    teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
    teamAuditEvent: { create: jest.fn(async () => ({ id: 'evt' })) },
  } as any;
}

describe('InviteCodesService.bulkInvite — email pipeline', () => {
  let prisma: any;
  let email: { send: jest.Mock };
  let audit: { write: jest.Mock };
  let analytics: { capture: jest.Mock; identify: jest.Mock };
  let svc: InviteCodesService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    email = {
      send: jest.fn(async ({ idempotencyKey }: any) => ({
        status: 'sent',
        providerMessageId: 'msg_x',
        idempotencyKey,
      })),
    };
    audit = { write: jest.fn() };
    analytics = { capture: jest.fn(), identify: jest.fn() };
    svc = new InviteCodesService(prisma, analytics as any, email as any, audit as any);
  });

  it('sends one coach-invites-client email per created row using invite_code_id as idempotency key', async () => {
    const result = await svc.bulkInvite('coach-1', [
      { email: 'a@example.com', name: 'Alice' },
      { email: 'b@example.com', note: 'see you Monday' },
    ]);
    expect(result.created).toHaveLength(2);
    expect(email.send).toHaveBeenCalledTimes(2);
    const callOne = email.send.mock.calls[0][0];
    expect(callOne.template).toBe('coach-invites-client');
    expect(callOne.to).toBe('a@example.com');
    expect(callOne.idempotencyKey).toMatch(/^invite:ic-/);
    expect(callOne.data.coach_name).toBe('Sam Trainer');
    expect(callOne.data.invite_code).toMatch(/^GP-/);
    expect(callOne.data.recipient_name).toBe('Alice');
    expect(callOne.data.accept_url).toContain(callOne.data.invite_code);

    // Per-row email_status surfaces to the caller so mobile can show
    // ✓/✗ next to each recipient. The mobile PR #141 contract expects
    // a string enum: 'sent' | 'failed' | 'skipped' | 'logged'.
    for (const row of result.created) {
      expect(row.email_status).toBe('sent');
    }
  });

  it('does NOT fake success when EmailService returns failed — propagates email_status to the row', async () => {
    email.send.mockImplementation(async ({ idempotencyKey }: any) => ({
      status: 'failed',
      providerMessageId: null,
      idempotencyKey,
      error: 'Resend 422: domain not verified',
    }));
    const result = await svc.bulkInvite('coach-1', [
      { email: 'a@example.com' },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].email_status).toBe('failed');
    expect(result.created[0].email_error).toMatch(/domain not verified/);
  });

  it('rejects empty + duplicate-in-batch emails without calling EmailService', async () => {
    const result = await svc.bulkInvite('coach-1', [
      { email: 'a@example.com' },
      { email: 'a@example.com' },
      { email: '' },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.rejected).toEqual([
      { email: 'a@example.com', reason: 'duplicate_in_batch' },
      { email: '', reason: 'empty' },
    ]);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('writes a single invite.bulk_sent audit row with per-status counts', async () => {
    email.send
      .mockImplementationOnce(async () => ({
        status: 'sent',
        providerMessageId: 'm1',
        idempotencyKey: 'k1',
      }))
      .mockImplementationOnce(async () => ({
        status: 'failed',
        providerMessageId: null,
        idempotencyKey: 'k2',
        error: 'boom',
      }));
    await svc.bulkInvite('coach-1', [
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
    expect(audit.write).toHaveBeenCalledTimes(1);
    const payload = audit.write.mock.calls[0][0];
    expect(payload.action).toBe('invite.bulk_sent');
    expect(payload.actorId).toBe('coach-1');
    expect(payload.tenantCoachId).toBe('coach-1');
    expect(payload.metadata).toEqual(
      expect.objectContaining({
        total_requested: 2,
        created_count: 2,
        rejected_count: 0,
        sent_count: 1,
        failed_count: 1,
      }),
    );
  });
});

describe('InviteCodesService.sendInviteEmailForCode', () => {
  let prisma: any;
  let email: { send: jest.Mock };
  let svc: InviteCodesService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    email = {
      send: jest.fn(async ({ idempotencyKey }: any) => ({
        status: 'sent',
        providerMessageId: 'msg',
        idempotencyKey,
      })),
    };
    svc = new InviteCodesService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      email as any,
      { write: jest.fn() } as any,
    );
  });

  it('rejects when the row belongs to a different coach', async () => {
    prisma.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-1',
      code: 'GP-AAA',
      coach_id: 'someone-else',
      revoked: false,
      expires_at: null,
    });
    await expect(
      svc.sendInviteEmailForCode('coach-1', 'ic-1', 'a@example.com'),
    ).rejects.toThrow(/does not belong/);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('rejects when the row is revoked', async () => {
    prisma.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-1',
      code: 'GP-AAA',
      coach_id: 'coach-1',
      revoked: true,
      expires_at: null,
    });
    await expect(
      svc.sendInviteEmailForCode('coach-1', 'ic-1', 'a@example.com'),
    ).rejects.toThrow(/revoked/);
  });

  it('sends with the same idempotency key shape as bulkInvite', async () => {
    prisma.inviteCode.findUnique.mockResolvedValue({
      id: 'ic-99',
      code: 'GP-ZZZZZZ',
      coach_id: 'coach-1',
      revoked: false,
      expires_at: new Date('2026-08-01'),
    });
    const res = await svc.sendInviteEmailForCode(
      'coach-1',
      'ic-99',
      'a@example.com',
      { recipientName: 'Alex' },
    );
    expect(res.status).toBe('sent');
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'invite:ic-99',
        template: 'coach-invites-client',
        to: 'a@example.com',
        data: expect.objectContaining({ recipient_name: 'Alex' }),
      }),
    );
  });
});
