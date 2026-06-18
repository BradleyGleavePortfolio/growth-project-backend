import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
  type ClaimWriteResult,
} from '../marketplace-idempotency.service';
import { ApplyService } from '../apply.service';

// apply.service is the PII boundary for the apply funnel. These tests assert:
//   - reads are owner-scoped (where-clause pinned to the caller subject),
//   - responses are explicit allow-list DTOs (no raw entity columns leak),
//   - idempotency outcomes (replay / in_flight / P2002 recovery) are honoured,
//   - no raw email/PII is written to logs.
// Prisma + the idempotency ledger are assembled onto their real prototypes so
// the doubles stay structurally typed without any forbidden cast.

type ApplicantRow = {
  id: string;
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  certifications: string[];
  years_experience: number | null;
  sample_program_url: string | null;
  created_at: Date;
  updated_at: Date;
};

type ApplicationRow = {
  id: string;
  listing_id: string;
  applicant_id: string;
  applicant_user_id: string;
  hirer_id: string;
  cover_note: string | null;
  fit_score: number | null;
  status: string;
  created_at: Date;
};

const NOW = new Date('2026-06-18T04:41:00.000Z');

function applicantRow(over: Partial<ApplicantRow> = {}): ApplicantRow {
  return {
    id: 'applicant-1',
    user_id: 'user-1',
    email: 'jo@example.com',
    first_name: 'Jo',
    last_name: 'Coach',
    headline: null,
    bio: null,
    specialties: ['Strength'],
    certifications: [],
    years_experience: null,
    sample_program_url: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function applicationRow(over: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: 'app-1',
    listing_id: 'listing-1',
    applicant_id: 'applicant-1',
    applicant_user_id: 'user-1',
    hirer_id: 'hirer-1',
    cover_note: 'Excited to apply',
    fit_score: 80,
    status: 'submitted',
    created_at: NOW,
    ...over,
  };
}

type PrismaParts = {
  applicant?: Partial<Record<string, jest.Mock>>;
  application?: Partial<Record<string, jest.Mock>>;
  user?: Partial<Record<string, jest.Mock>>;
  jobListing?: Partial<Record<string, jest.Mock>>;
  $transaction?: jest.Mock;
};

function makePrisma(parts: PrismaParts): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, parts);
}

function makeIdempotency(
  parts: Partial<Record<string, jest.Mock>>,
): MarketplaceIdempotencyService {
  return Object.assign(
    Object.create(MarketplaceIdempotencyService.prototype) as MarketplaceIdempotencyService,
    parts,
  );
}

describe('ApplyService.getOwnProfile — owner-scoped read + allow-list DTO', () => {
  it('queries by the caller user_id and returns only allow-listed fields', async () => {
    const findUnique = jest.fn(async () => applicantRow());
    const prisma = makePrisma({ applicant: { findUnique } });
    const service = new ApplyService(prisma, makeIdempotency({}));

    const profile = await service.getOwnProfile('user-1');

    expect(findUnique).toHaveBeenCalledWith({ where: { user_id: 'user-1' } });
    // serialized dates + named fields only; no raw Date objects or extra columns
    expect(profile.created_at).toBe(NOW.toISOString());
    expect(Object.keys(profile).sort()).toEqual(
      [
        'bio',
        'certifications',
        'created_at',
        'email',
        'first_name',
        'headline',
        'id',
        'last_name',
        'sample_program_url',
        'specialties',
        'updated_at',
        'years_experience',
      ].sort(),
    );
  });

  it('throws NotFound when the caller has no profile', async () => {
    const prisma = makePrisma({ applicant: { findUnique: jest.fn(async () => null) } });
    const service = new ApplyService(prisma, makeIdempotency({}));
    await expect(service.getOwnProfile('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ApplyService.updateOwnProfile — pinned to caller, no cross-write', () => {
  it('pins both the existence check and the update where-clause to the caller', async () => {
    const findUnique = jest.fn(async () => ({ id: 'applicant-1' }));
    const update = jest.fn(async (_args: { where: unknown; data: unknown }) =>
      applicantRow({ first_name: 'Jordan' }),
    );
    const prisma = makePrisma({ applicant: { findUnique, update } });
    const service = new ApplyService(prisma, makeIdempotency({}));

    await service.updateOwnProfile('user-1', { first_name: '  Jordan  ' });

    expect(findUnique).toHaveBeenCalledWith({
      where: { user_id: 'user-1' },
      select: { id: true },
    });
    expect(update.mock.calls[0][0].where).toEqual({ user_id: 'user-1' });
    // only provided fields are written, trimmed
    expect(update.mock.calls[0][0].data).toEqual({ first_name: 'Jordan' });
  });

  it('throws NotFound rather than creating when no profile exists', async () => {
    const update = jest.fn();
    const prisma = makePrisma({
      applicant: { findUnique: jest.fn(async () => null), update },
    });
    const service = new ApplyService(prisma, makeIdempotency({}));
    await expect(
      service.updateOwnProfile('ghost', { first_name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('ApplyService.myApplications — owner-scoped keyset pagination', () => {
  it('filters by applicant_user_id and returns PII-free cards', async () => {
    const findMany = jest.fn(async (_args: { where: unknown; take: number }) => [
      applicationRow(),
    ]);
    const prisma = makePrisma({ application: { findMany } });
    const service = new ApplyService(prisma, makeIdempotency({}));

    const page = await service.myApplications('user-1', {});

    expect(findMany.mock.calls[0][0].where).toEqual({ applicant_user_id: 'user-1' });
    const card = page.items[0];
    // no hirer_id / applicant_user_id / email leaks onto the card
    expect(Object.keys(card).sort()).toEqual(
      ['cover_note', 'created_at', 'fit', 'id', 'listing_id', 'status'].sort(),
    );
    expect(page.next_cursor).toBeNull();
  });

  it('emits a next_cursor only when more rows exist beyond the limit', async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      applicationRow({ id: `app-${i}`, created_at: new Date(NOW.getTime() - i * 1000) }),
    );
    const findMany = jest.fn(async (_args: { where: unknown; take: number }) => rows);
    const prisma = makePrisma({ application: { findMany } });
    const service = new ApplyService(prisma, makeIdempotency({}));

    const page = await service.myApplications('user-1', { limit: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.next_cursor).not.toBeNull();
    // took limit+1 to detect the extra row
    expect(findMany.mock.calls[0][0].take).toBe(21);
  });
});

describe('ApplyService.apply — listing visibility & idempotency', () => {
  it('throws NotFound for an unpublished/missing listing (mirrors RLS)', async () => {
    const prisma = makePrisma({
      jobListing: { findUnique: jest.fn(async () => ({ id: 'l', status: 'draft' })) },
    });
    const service = new ApplyService(prisma, makeIdempotency({}));
    await expect(
      service.apply('l', {
        email: 'jo@example.com',
        first_name: 'Jo',
        last_name: 'Coach',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays a stored confirmation without re-executing the mutation', async () => {
    const stored = {
      application_id: 'app-1',
      applicant_id: 'applicant-1',
      account_id: 'user-1',
      status: 'submitted',
      fit: { level: 'strong', label: 'Strong match', score: 80 },
      confirmation: { headline: "You're in.", message: 'm', next_step: 'n' },
    };
    const create = jest.fn();
    const prisma = makePrisma({
      jobListing: {
        findUnique: jest.fn(async () => ({
          id: 'listing-1',
          hirer_id: 'hirer-1',
          status: 'published',
          specialty: 'Strength',
          compensation_type: 'flat',
        })),
      },
      user: { findUnique: jest.fn(async () => ({ id: 'user-1', email: 'jo@example.com' })) },
      application: { create },
    });
    const claimOrReplay = jest.fn(
      async (): Promise<ClaimOrReplayResult> => ({ outcome: 'replay', response: stored }),
    );
    const service = new ApplyService(prisma, makeIdempotency({ claimOrReplay }));

    const result = await service.apply('listing-1', {
      email: 'jo@example.com',
      first_name: 'Jo',
      last_name: 'Coach',
    });

    expect(result.application_id).toBe('app-1');
    // replay path must NOT create a new Application
    expect(create).not.toHaveBeenCalled();
    // The anonymous-caller confirmation payload is an exact allow-list: ids +
    // status + fit chip + closure copy ONLY. No applicant email/name and no
    // hirer identity ever cross back to the public apply caller.
    expect(Object.keys(result).sort()).toEqual(
      [
        'account_id',
        'applicant_id',
        'application_id',
        'confirmation',
        'fit',
        'status',
      ].sort(),
    );
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('jo@example.com');
    expect(flat).not.toContain('hirer-1');
  });

  it('surfaces a retryable conflict when a sibling submit is in flight', async () => {
    const prisma = makePrisma({
      jobListing: {
        findUnique: jest.fn(async () => ({
          id: 'listing-1',
          hirer_id: 'hirer-1',
          status: 'published',
          specialty: 'Strength',
          compensation_type: 'flat',
        })),
      },
      user: { findUnique: jest.fn(async () => ({ id: 'user-1', email: 'jo@example.com' })) },
    });
    const claimOrReplay = jest.fn(
      async (): Promise<ClaimOrReplayResult> => ({ outcome: 'in_flight' }),
    );
    const service = new ApplyService(prisma, makeIdempotency({ claimOrReplay }));

    await expect(
      service.apply('listing-1', {
        email: 'jo@example.com',
        first_name: 'Jo',
        last_name: 'Coach',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keys idempotency on the resolved account + listing when no client key given', async () => {
    const claimOrReplay = jest.fn(
      async (_key: {
        userId: string;
        routeKey: string;
        idempotencyKey: string;
      }): Promise<ClaimOrReplayResult> => ({ outcome: 'in_flight' }),
    );
    const prisma = makePrisma({
      jobListing: {
        findUnique: jest.fn(async () => ({
          id: 'listing-1',
          hirer_id: 'hirer-1',
          status: 'published',
          specialty: 'Strength',
          compensation_type: 'flat',
        })),
      },
      user: { findUnique: jest.fn(async () => ({ id: 'user-1', email: 'jo@example.com' })) },
    });
    const service = new ApplyService(prisma, makeIdempotency({ claimOrReplay }));

    await expect(
      service.apply('listing-1', {
        email: 'JO@example.com',
        first_name: 'Jo',
        last_name: 'Coach',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // default key is namespaced per (account, listing) — no cross-user intent leak
    expect(claimOrReplay.mock.calls[0][0].idempotencyKey).toBe('apply:user-1:listing-1');
  });
});

describe('ApplyService — PII hygiene', () => {
  it('never writes the applicant email to console during a happy-path apply', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const created = applicationRow();
    const $transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        applicant: { upsert: jest.fn(async () => applicantRow()) },
        application: { create: jest.fn(async () => created) },
      }),
    );
    const claimNonce = 'nonce-1';
    const prisma = makePrisma({
      jobListing: {
        findUnique: jest.fn(async () => ({
          id: 'listing-1',
          hirer_id: 'hirer-1',
          status: 'published',
          specialty: 'Strength',
          compensation_type: 'flat',
        })),
      },
      user: { findUnique: jest.fn(async () => ({ id: 'user-1', email: 'jo@example.com' })) },
      $transaction,
    });
    const idempotency = makeIdempotency({
      claimOrReplay: jest.fn(
        async (): Promise<ClaimOrReplayResult> => ({ outcome: 'claimed', claimNonce }),
      ),
      markCompleted: jest.fn(async (): Promise<ClaimWriteResult> => ({ outcome: 'ok' })),
    });
    const service = new ApplyService(prisma, idempotency);

    await service.apply('listing-1', {
      email: 'jo@example.com',
      first_name: 'Jo',
      last_name: 'Coach',
      specialties: ['Strength'],
    });

    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(allLogs).not.toContain('jo@example.com');

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
