// Phase 8 follow-up — sub-coach invite acceptance flow.
//
// Covers:
//   1. previewByToken — happy / not_found / status flags
//      (pending / accepted / revoked / expired)
//   2. accept — happy path writes assignment + audit + flips invite
//   3. accept — student role rejected (accept_role_not_coach)
//   4. accept — empty token / wrong email / own invite rejected
//   5. accept — revoked / already used / expired terminal states
//   6. accept — idempotent re-acceptance by the same caller
//   7. accept — head-cap (2) enforced
//   8. accept — archived prior assignment is re-activated (no dup row)
//   9. accept — existing non-archived assignment is idempotent success
//
// The tests use the same mock-prisma shape the rest of the Phase 8
// service tests use so they stay cheap and deterministic.

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';

function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface MockPrisma {
  subCoachInvite: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  teamSubCoachAssignment: {
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  teamAuditEvent: {
    create: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  const base: MockPrisma = {
    subCoachInvite: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv-1',
        ...data,
      })),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'asn-new',
        ...data,
        archived_at: null,
      })),
      update: jest.fn(
        async ({ data }: { where: unknown; data: Record<string, unknown> }) => ({
          id: 'asn-existing',
          ...data,
        }),
      ),
    },
    teamAuditEvent: {
      create: jest.fn(async () => ({ id: 'evt-1' })),
    },
    user: {
      findUnique: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(base as unknown),
    ),
    ...overrides,
  };
  return base;
}

function buildTeam() {
  return {
    refreshCounters: jest.fn(async () => undefined),
  };
}

function futureDate(days = 7): Date {
  return new Date(Date.now() + days * 86_400_000);
}

function pastDate(days = 1): Date {
  return new Date(Date.now() - days * 86_400_000);
}

const VALID_TOKEN = 'a'.repeat(32);

// ── invite token hashing (P1-2 fix) ────────────────────────────────

describe('SubCoachesService.accept — token_hash lookup (P1-2)', () => {
  it('resolves invite by hashing the presented token (not plaintext lookup)', async () => {
    // Simulate a new-style invite stored with token_hash only.
    const prisma = buildPrisma({
      subCoachInvite: {
        // First call: hash-based lookup succeeds → returns the invite.
        // Second call (legacy fallback) should NOT be reached.
        findUnique: jest.fn(async () => inviteRow()),
        update: jest.fn(async () => ({ id: 'inv-1' })),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'x', name: 'X' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.ok).toBe(true);
    // The FIRST findUnique call must use token_hash (the hash of the presented token).
    const firstCall = prisma.subCoachInvite.findUnique.mock.calls[0][0];
    expect(firstCall.where).toHaveProperty('token_hash', sha256hex(VALID_TOKEN));
    // The second call (legacy fallback) should not have happened when hash hit.
    expect(prisma.subCoachInvite.findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to legacy plaintext token lookup when hash lookup misses', async () => {
    // Simulate a legacy invite stored with plaintext token only (pre-rollout row).
    const legacyInvite = inviteRow();
    const prisma = buildPrisma({
      subCoachInvite: {
        // First call (hash lookup): miss. Second call (legacy): hit.
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)           // hash miss
          .mockResolvedValueOnce(legacyInvite),  // legacy hit
        update: jest.fn(async () => ({ id: 'inv-1' })),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'x', name: 'X' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.ok).toBe(true);
    // Both lookups must have fired.
    expect(prisma.subCoachInvite.findUnique).toHaveBeenCalledTimes(2);
    const firstCall = prisma.subCoachInvite.findUnique.mock.calls[0][0];
    const secondCall = prisma.subCoachInvite.findUnique.mock.calls[1][0];
    expect(firstCall.where).toHaveProperty('token_hash');
    // Legacy fallback must use the raw (plaintext) token.
    expect(secondCall.where).toHaveProperty('token', VALID_TOKEN);
  });

  it('returns 404 when both hash and legacy lookup miss (wrong token)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => null), // both lookups miss
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(NotFoundException);
    // Both lookups fired.
    expect(prisma.subCoachInvite.findUnique).toHaveBeenCalledTimes(2);
  });

  it('accept is single-use — second accept with same token from a different user throws invite_already_used', async () => {
    const consumedRow = inviteRow({
      accepted_at: new Date(),
      accepted_by_user_id: 'sub-1',
    });
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => consumedRow),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    // A different user (sub-2) tries to redeem the same token.
    await expect(
      svc.accept('sub-2', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(ConflictException);
  });
});

describe('SubCoachesService.previewByToken — token_hash lookup (P1-2)', () => {
  it('resolves preview by hash-first lookup, not plaintext', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          email: 'sub@x.test',
          name: null,
          max_clients: null,
          token: VALID_TOKEN,
          expires_at: futureDate(),
          accepted_at: null,
          revoked_at: null,
          head_coach: {
            id: 'head-1',
            name: 'Head',
            coach_profile: null,
          },
        })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await svc.previewByToken(VALID_TOKEN);
    const firstCall = prisma.subCoachInvite.findUnique.mock.calls[0][0];
    // Must use token_hash for the primary lookup.
    expect(firstCall.where).toHaveProperty('token_hash', sha256hex(VALID_TOKEN));
  });

  it('falls back to legacy plaintext lookup when hash misses', async () => {
    const inviteWithHead = {
      id: 'inv-1',
      email: 'sub@x.test',
      name: null,
      max_clients: null,
      token: VALID_TOKEN,
      expires_at: futureDate(),
      accepted_at: null,
      revoked_at: null,
      head_coach: { id: 'head-1', name: 'Head', coach_profile: null },
    };
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)          // hash miss
          .mockResolvedValueOnce(inviteWithHead), // legacy hit
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.previewByToken(VALID_TOKEN);
    expect(out.status).toBe('pending');
    expect(prisma.subCoachInvite.findUnique).toHaveBeenCalledTimes(2);
    const secondCall = prisma.subCoachInvite.findUnique.mock.calls[1][0];
    expect(secondCall.where).toHaveProperty('token', VALID_TOKEN);
  });
});

// ── previewByToken ──────────────────────────────────────────────────

describe('SubCoachesService.previewByToken', () => {
  it('returns NotFound for an unknown token', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(svc.previewByToken(VALID_TOKEN)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns BadRequest for an empty token', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(svc.previewByToken('  ')).rejects.toThrow(BadRequestException);
  });

  it('returns pending status + head coach summary for an outstanding invite', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          email: 'sub@x.test',
          name: 'Sub',
          max_clients: 30,
          token: VALID_TOKEN,
          expires_at: futureDate(),
          accepted_at: null,
          accepted_by_user_id: null,
          revoked_at: null,
          head_coach: {
            id: 'head-1',
            name: 'Head Coach',
            coach_profile: { business_name: 'Acme Fit' },
          },
        })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.previewByToken(VALID_TOKEN);
    expect(out.status).toBe('pending');
    expect(out.head_coach.id).toBe('head-1');
    expect(out.head_coach.business_name).toBe('Acme Fit');
    expect(out.email).toBe('sub@x.test');
  });

  it('returns revoked status when invite is revoked', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          email: 'sub@x.test',
          name: null,
          max_clients: null,
          token: VALID_TOKEN,
          expires_at: futureDate(),
          accepted_at: null,
          revoked_at: new Date(),
          head_coach: {
            id: 'head-1',
            name: 'Head',
            coach_profile: null,
          },
        })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.previewByToken(VALID_TOKEN);
    expect(out.status).toBe('revoked');
    expect(out.head_coach.business_name).toBeNull();
  });

  it('returns expired status when expires_at is in the past', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          email: 'sub@x.test',
          name: null,
          max_clients: null,
          token: VALID_TOKEN,
          expires_at: pastDate(),
          accepted_at: null,
          revoked_at: null,
          head_coach: {
            id: 'head-1',
            name: 'Head',
            coach_profile: null,
          },
        })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.previewByToken(VALID_TOKEN);
    expect(out.status).toBe('expired');
  });

  it('returns accepted status when invite was already claimed', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          email: 'sub@x.test',
          name: null,
          max_clients: null,
          token: VALID_TOKEN,
          expires_at: futureDate(),
          accepted_at: new Date(),
          accepted_by_user_id: 'sub-1',
          revoked_at: null,
          head_coach: {
            id: 'head-1',
            name: 'Head',
            coach_profile: null,
          },
        })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.previewByToken(VALID_TOKEN);
    expect(out.status).toBe('accepted');
  });
});

// ── accept (validation gates) ───────────────────────────────────────

describe('SubCoachesService.accept — input validation', () => {
  it('rejects empty token', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'a@x.test', '  '),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects student callers with accept_role_not_coach', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'student', 'a@x.test', VALID_TOKEN),
    ).rejects.toThrow(ForbiddenException);
  });

  it('404s for unknown token', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'a@x.test', VALID_TOKEN),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── accept (state gates) ────────────────────────────────────────────

function inviteRow(
  overrides: Partial<{
    id: string;
    head_coach_id: string;
    email: string;
    expires_at: Date;
    accepted_at: Date | null;
    accepted_by_user_id: string | null;
    revoked_at: Date | null;
    max_clients: number | null;
  }> = {},
) {
  return {
    id: 'inv-1',
    head_coach_id: 'head-1',
    email: 'sub@x.test',
    name: 'Sub',
    max_clients: null,
    token: VALID_TOKEN,
    expires_at: futureDate(),
    accepted_at: null,
    accepted_by_user_id: null,
    revoked_at: null,
    ...overrides,
  };
}

describe('SubCoachesService.accept — terminal states', () => {
  it('rejects when caller is the issuing head coach (cannot_accept_own_invite)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => inviteRow({ head_coach_id: 'head-1' })),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('head-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when invite is revoked (invite_revoked)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({ revoked_at: new Date() }),
        ),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects when invite was accepted by a different user (invite_already_used)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({
            accepted_at: new Date(),
            accepted_by_user_id: 'other-sub',
          }),
        ),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects when invite is expired and not yet accepted (invite_expired)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({ expires_at: pastDate() }),
        ),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects when caller email does not match invite email (invite_email_mismatch)', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({ email: 'sub@x.test' }),
        ),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'someone-else@x.test', VALID_TOKEN),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when caller is already a sub-coach under SUB_COACH_HEAD_CAP head coaches', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => inviteRow()),
        update: jest.fn(),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => SubCoachesService.headCap),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.accept('caller-1', 'coach', 'sub@x.test', VALID_TOKEN),
    ).rejects.toThrow(ConflictException);
  });
});

// ── accept (happy + idempotent) ─────────────────────────────────────

describe('SubCoachesService.accept — happy path', () => {
  it('creates assignment + writes sub_coach_assigned audit + flips invite', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({ max_clients: 75 }),
        ),
        update: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'inv-1',
            ...data,
          }),
        ),
      },
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'head-1'
            ? { id: 'head-1', name: 'Head' }
            : { id: 'sub-1', name: 'New Sub' },
        ),
      },
    });
    const team = buildTeam();
    const svc = new SubCoachesService(prisma as never, team as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.ok).toBe(true);
    expect(out.already_accepted).toBe(false);
    expect(out.headCoachId).toBe('head-1');
    expect(out.subCoachId).toBe('sub-1');
    expect(prisma.subCoachInvite.update).toHaveBeenCalledTimes(1);
    expect(prisma.teamSubCoachAssignment.create).toHaveBeenCalledTimes(1);
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.teamAuditEvent.create.mock.calls[0][0];
    expect(auditCall.data.event_kind).toBe('sub_coach_assigned');
    expect(auditCall.data.actor_user_id).toBe('sub-1');
    expect(auditCall.data.head_coach_id).toBe('head-1');
    expect(auditCall.data.metadata.invite_id).toBe('inv-1');
    expect(auditCall.data.metadata.via).toBe('invite_acceptance');
    expect(auditCall.data.metadata.max_clients).toBe(75);
    expect(team.refreshCounters).toHaveBeenCalledWith('head-1');
  });

  it('matches email case-insensitively', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () =>
          inviteRow({ email: 'Sub@X.Test' }),
        ),
        update: jest.fn(async () => ({ id: 'inv-1' })),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'x', name: 'X' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept(
      'sub-1',
      'coach',
      'SUB@x.test',
      VALID_TOKEN,
    );
    expect(out.ok).toBe(true);
  });

  it('is idempotent — second call by the same accepter returns already_accepted=true and writes no new audit', async () => {
    const acceptedRow = inviteRow({
      accepted_at: new Date(),
      accepted_by_user_id: 'sub-1',
    });
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => acceptedRow),
        update: jest.fn(),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => ({ id: 'asn-existing' })),
        count: jest.fn(async () => 0),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.already_accepted).toBe(true);
    expect(out.assignmentId).toBe('asn-existing');
    expect(prisma.teamAuditEvent.create).not.toHaveBeenCalled();
    expect(prisma.teamSubCoachAssignment.create).not.toHaveBeenCalled();
  });

  it('re-activates an archived prior assignment instead of creating a duplicate row', async () => {
    const archivedAssignment = {
      id: 'asn-archived',
      head_coach_id: 'head-1',
      sub_coach_id: 'sub-1',
      archived_at: new Date(),
    };
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => inviteRow()),
        update: jest.fn(async () => ({ id: 'inv-1' })),
      },
      teamSubCoachAssignment: {
        // First call (idempotency probe) finds the archived row; second
        // call inside the transaction returns it for re-activation.
        findFirst: jest.fn(async () => archivedAssignment),
        count: jest.fn(async () => 0),
        create: jest.fn(),
        update: jest.fn(async () => ({
          ...archivedAssignment,
          archived_at: null,
        })),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'x', name: 'X' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.ok).toBe(true);
    expect(out.already_accepted).toBe(false);
    expect(out.assignmentId).toBe('asn-archived');
    expect(prisma.teamSubCoachAssignment.update).toHaveBeenCalledTimes(1);
    expect(prisma.teamSubCoachAssignment.create).not.toHaveBeenCalled();
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('treats an existing non-archived assignment as an idempotent success and consumes the invite', async () => {
    const liveAssignment = {
      id: 'asn-live',
      head_coach_id: 'head-1',
      sub_coach_id: 'sub-1',
      archived_at: null,
    };
    const updateInvite = jest.fn(async () => ({ id: 'inv-1' }));
    const prisma = buildPrisma({
      subCoachInvite: {
        findUnique: jest.fn(async () => inviteRow()),
        update: updateInvite,
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => liveAssignment),
        count: jest.fn(async () => 0),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'x', name: 'X' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.accept('sub-1', 'coach', 'sub@x.test', VALID_TOKEN);
    expect(out.already_accepted).toBe(true);
    expect(out.assignmentId).toBe('asn-live');
    expect(updateInvite).toHaveBeenCalledTimes(1);
    expect(prisma.teamAuditEvent.create).not.toHaveBeenCalled();
  });
});
