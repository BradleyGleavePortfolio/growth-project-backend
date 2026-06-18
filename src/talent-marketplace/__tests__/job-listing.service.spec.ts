import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { JobListingService } from '../job-listing.service';

// Minimal Prisma double — only the jobListing delegate methods the service
// touches are implemented, assembled onto a real PrismaService prototype so
// the value stays structurally a PrismaService without any forbidden cast.
type ListingRow = {
  id: string;
  hirer_id: string;
  status: 'draft' | 'published' | 'closed';
  compensation_type: 'commission' | 'rev_share' | 'flat' | 'hybrid';
  compensation_terms: Record<string, unknown>;
  published_at: Date | null;
  closed_at: Date | null;
};

function makeService(rows: ListingRow[]): {
  service: JobListingService;
  create: jest.Mock;
  update: jest.Mock;
} {
  const create = jest.fn((args: { data: Record<string, unknown> }) => ({
    id: 'new-id',
    ...args.data,
  }));
  const update = jest.fn(
    (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      return { ...row, ...args.data };
    },
  );
  const findUnique = jest.fn((args: { where: { id: string } }) =>
    rows.find((r) => r.id === args.where.id) ?? null,
  );
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    { jobListing: { create, update, findUnique } },
  );
  return { service: new JobListingService(prisma), create, update };
}

const HIRER = 'hirer-1';

function draftRow(over: Partial<ListingRow> = {}): ListingRow {
  return {
    id: 'listing-1',
    hirer_id: HIRER,
    status: 'draft',
    compensation_type: 'commission',
    compensation_terms: { rate_pct: 20 },
    published_at: null,
    closed_at: null,
    ...over,
  };
}

describe('JobListingService.create', () => {
  it('persists a draft scoped to the hirer with normalized terms', async () => {
    const { service, create } = makeService([]);
    const result = await service.create(HIRER, {
      title: '  Head Coach Wanted  ',
      description: 'Join our team',
      compensation_type: 'flat',
      compensation_terms: { amount_usd: 4000, period: 'monthly', extra: 'x' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.hirer_id).toBe(HIRER);
    expect(data.title).toBe('Head Coach Wanted');
    // Unknown keys are stripped by the validator.
    expect(data.compensation_terms).toEqual({
      amount_usd: 4000,
      period: 'monthly',
    });
    expect(result.id).toBe('new-id');
  });

  it('rejects compensation_terms missing required keys for the type', async () => {
    const { service, create } = makeService([]);
    await expect(
      service.create(HIRER, {
        title: 'Coach',
        description: 'd',
        compensation_type: 'commission',
        compensation_terms: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a rate_pct outside 0..100', async () => {
    const { service } = makeService([]);
    await expect(
      service.create(HIRER, {
        title: 'Coach',
        description: 'd',
        compensation_type: 'commission',
        compensation_terms: { rate_pct: 150 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps optional rev_share cap_usd when valid', async () => {
    const { service, create } = makeService([]);
    await service.create(HIRER, {
      title: 'Coach',
      description: 'd',
      compensation_type: 'rev_share',
      compensation_terms: { rate_pct: 30, cap_usd: 1000 },
    });
    expect(create.mock.calls[0][0].data.compensation_terms).toEqual({
      rate_pct: 30,
      cap_usd: 1000,
    });
  });
});

describe('JobListingService.edit', () => {
  it('applies only the provided fields', async () => {
    const { service, update } = makeService([draftRow()]);
    await service.edit(HIRER, 'listing-1', { title: 'New Title' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toEqual({ title: 'New Title' });
  });

  it('re-validates terms against the existing type when only terms change', async () => {
    const { service, update } = makeService([draftRow()]);
    await service.edit(HIRER, 'listing-1', {
      compensation_terms: { rate_pct: 35 },
    });
    expect(update.mock.calls[0][0].data.compensation_type).toBe('commission');
    expect(update.mock.calls[0][0].data.compensation_terms).toEqual({
      rate_pct: 35,
    });
  });

  it('throws NotFound for a missing listing', async () => {
    const { service } = makeService([]);
    await expect(
      service.edit(HIRER, 'missing', { title: 't' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws Forbidden when the listing belongs to another hirer', async () => {
    const { service } = makeService([draftRow({ hirer_id: 'other' })]);
    await expect(
      service.edit(HIRER, 'listing-1', { title: 't' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to edit a closed listing', async () => {
    const { service } = makeService([draftRow({ status: 'closed' })]);
    await expect(
      service.edit(HIRER, 'listing-1', { title: 't' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('JobListingService.publish', () => {
  it('moves a draft to published and stamps published_at', async () => {
    const { service, update } = makeService([draftRow()]);
    await service.publish(HIRER, 'listing-1');
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe('published');
    expect(data.published_at).toBeInstanceOf(Date);
  });

  it('is idempotent for an already-published listing (no update)', async () => {
    const { service, update } = makeService([draftRow({ status: 'published' })]);
    const result = await service.publish(HIRER, 'listing-1');
    expect(update).not.toHaveBeenCalled();
    expect(result.status).toBe('published');
  });

  it('refuses to publish a closed listing', async () => {
    const { service } = makeService([draftRow({ status: 'closed' })]);
    await expect(service.publish(HIRER, 'listing-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('JobListingService.close', () => {
  it('closes a published listing and stamps closed_at', async () => {
    const { service, update } = makeService([draftRow({ status: 'published' })]);
    await service.close(HIRER, 'listing-1');
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe('closed');
    expect(data.closed_at).toBeInstanceOf(Date);
  });

  it('is idempotent for an already-closed listing (no update)', async () => {
    const { service, update } = makeService([draftRow({ status: 'closed' })]);
    await service.close(HIRER, 'listing-1');
    expect(update).not.toHaveBeenCalled();
  });
});
