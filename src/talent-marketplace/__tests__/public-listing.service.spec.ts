import { NotFoundException } from '@nestjs/common';
import type { JobListing } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { PublicListingService } from '../public-listing.service';
import { parseTupleCursor } from '../public-listing.cursor';

// TM-3 — public browse + detail. These specs lock the three security/contract
// invariants of the public surface:
//   1. ANON-SEES-ONLY-PUBLISHED — every query carries status:'published'
//      (defence-in-depth alongside RLS); a non-published id is a 404.
//   2. PII OMISSION — the payload is an allow-list copy; hirer_id,
//      idempotency_key and friends never appear in the card or detail DTO.
//   3. KEYSET TUPLE PAGINATION — over-fetch + (created_at,id) boundary, opaque
//      next_cursor, null on the last page; never offset.
// The Prisma double is assembled onto a real PrismaService prototype so it stays
// structurally a PrismaService with no forbidden cast (mirrors the TM-2 spec).

type Row = JobListing;

const FULL_FIELDS = {
  hirer_id: 'hirer-SECRET-001',
  idempotency_key: 'idem-SECRET-key',
  closed_at: null,
  updated_at: new Date('2026-06-01T00:00:00.000Z'),
} as const;

function row(over: Partial<Row> = {}): Row {
  const base = {
    id: 'listing-1',
    title: 'Head Coach Wanted',
    description: 'Lead a regional squad of coaches.',
    specialty: 'Strength',
    location: 'London',
    modality: 'remote',
    compensation_type: 'commission',
    compensation_terms: { rate_pct: 20 },
    expectations: '10 sessions / week',
    status: 'published',
    published_at: new Date('2026-06-10T08:00:00.000Z'),
    created_at: new Date('2026-06-10T08:00:00.000Z'),
    ...FULL_FIELDS,
    ...over,
  };
  return base as Row;
}

function makeService(rows: Row[]): {
  service: PublicListingService;
  findMany: jest.Mock;
  findFirst: jest.Mock;
} {
  const findMany = jest.fn(
    (args: {
      where: { status?: string };
      take: number;
    }) => {
      // Honour the published filter the service is contractually required to
      // pass, so the "anon sees only published" assertion is meaningful.
      const visible =
        args.where.status === 'published'
          ? rows.filter((r) => r.status === 'published')
          : rows;
      return Promise.resolve(visible.slice(0, args.take));
    },
  );
  const findFirst = jest.fn(
    (args: { where: { id: string; status?: string } }) => {
      const found = rows.find(
        (r) =>
          r.id === args.where.id &&
          (args.where.status === undefined || r.status === args.where.status),
      );
      return Promise.resolve(found ?? null);
    },
  );
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    { jobListing: { findMany, findFirst } },
  );
  return { service: new PublicListingService(prisma), findMany, findFirst };
}

describe('PublicListingService.browse — anon sees only published', () => {
  it('always queries with status:published', async () => {
    const { service, findMany } = makeService([row()]);
    await service.browse({});
    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0] as { where: { status: string } };
    expect(arg.where.status).toBe('published');
  });

  it('excludes draft/closed rows from the result set', async () => {
    const { service } = makeService([
      row({ id: 'pub', status: 'published' }),
      row({ id: 'draft', status: 'draft' }),
      row({ id: 'closed', status: 'closed' }),
    ]);
    const res = await service.browse({});
    expect(res.items.map((i) => i.id)).toEqual(['pub']);
  });

  it('orders by the (created_at desc, id desc) keyset sort key', async () => {
    const { service, findMany } = makeService([row()]);
    await service.browse({});
    const arg = findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(arg.orderBy).toEqual([
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
  });
});

describe('PublicListingService.browse — PII omission', () => {
  it('card payload contains ONLY allow-listed public fields', async () => {
    const { service } = makeService([row()]);
    const res = await service.browse({});
    const card = res.items[0];
    expect(Object.keys(card).sort()).toEqual(
      [
        'compensation_summary',
        'cta_listing_id',
        'id',
        'location',
        'modality',
        'published_at',
        'specialty',
        'title',
      ].sort(),
    );
  });

  it('never leaks hirer_id, idempotency_key, or any PII onto the card', () => {
    // Assert against a JSON snapshot so even nested/inherited props are caught.
    return makeService([row()])
      .service.browse({})
      .then((res) => {
        const serialized = JSON.stringify(res.items[0]);
        expect(serialized).not.toContain('hirer-SECRET-001');
        expect(serialized).not.toContain('idem-SECRET-key');
        expect(serialized).not.toContain('hirer_id');
        expect(serialized).not.toContain('idempotency_key');
      });
  });
});

describe('PublicListingService.browse — keyset tuple pagination', () => {
  function manyRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) =>
      row({
        id: `id-${String(i).padStart(3, '0')}`,
        created_at: new Date(2026, 0, 1, 0, 0, n - i),
      }),
    );
  }

  it('over-fetches limit+1 and emits an opaque next_cursor when more exist', async () => {
    const { service, findMany } = makeService(manyRows(5));
    const res = await service.browse({ limit: 2 });
    const arg = findMany.mock.calls[0][0] as { take: number };
    expect(arg.take).toBe(3); // limit + 1
    expect(res.items).toHaveLength(2);
    expect(res.next_cursor).not.toBeNull();
    // Cursor is the (created_at, id) of the LAST returned row.
    const decoded = parseTupleCursor(res.next_cursor as string);
    expect(decoded?.id).toBe(res.items[1].id);
  });

  it('returns next_cursor:null on the last page (no over-fetched row)', async () => {
    const { service } = makeService(manyRows(2));
    const res = await service.browse({ limit: 5 });
    expect(res.items).toHaveLength(2);
    expect(res.next_cursor).toBeNull();
  });

  it('returns next_cursor:null for an empty result set', async () => {
    const { service } = makeService([]);
    const res = await service.browse({});
    expect(res.items).toEqual([]);
    expect(res.next_cursor).toBeNull();
  });

  it('applies a keyset boundary (not offset) when a valid cursor is supplied', async () => {
    const { service, findMany } = makeService(manyRows(3));
    const cursor = (await service.browse({ limit: 1 })).next_cursor as string;
    await service.browse({ cursor, limit: 1 });
    const arg = findMany.mock.calls[1][0] as {
      where: { AND?: unknown[] };
      skip?: number;
    };
    expect(arg.skip).toBeUndefined(); // never offset
    expect(arg.where.AND).toBeDefined();
  });

  it('ignores a malformed cursor and degrades to page 1 (no boundary)', async () => {
    const { service, findMany } = makeService(manyRows(3));
    await service.browse({ cursor: 'not-a-real-cursor', limit: 2 });
    const arg = findMany.mock.calls[0][0] as { where: { AND?: unknown[] } };
    expect(arg.where.AND).toBeUndefined();
  });

  it('clamps limit to the configured maximum', async () => {
    const { service, findMany } = makeService(manyRows(1));
    await service.browse({ limit: 9999 });
    const arg = findMany.mock.calls[0][0] as { take: number };
    expect(arg.take).toBe(51); // PUBLIC_LISTING_MAX_LIMIT (50) + 1
  });
});

describe('PublicListingService.browse — faceted filters', () => {
  it('passes through specialty/location/modality equality facets', async () => {
    const { service, findMany } = makeService([row()]);
    await service.browse({
      specialty: 'Strength',
      location: 'London',
      modality: 'remote',
    });
    const arg = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.specialty).toBe('Strength');
    expect(arg.where.location).toBe('London');
    expect(arg.where.modality).toBe('remote');
  });

  it('maps a known compensation_type facet to the enum filter', async () => {
    const { service, findMany } = makeService([row()]);
    await service.browse({ compensation_type: 'rev_share' });
    const arg = findMany.mock.calls[0][0] as {
      where: { compensation_type?: string };
    };
    expect(arg.where.compensation_type).toBe('rev_share');
  });

  it('drops an unknown compensation_type facet rather than matching zero rows', async () => {
    const { service, findMany } = makeService([row()]);
    await service.browse({ compensation_type: 'bogus' });
    const arg = findMany.mock.calls[0][0] as {
      where: { compensation_type?: string };
    };
    expect(arg.where.compensation_type).toBeUndefined();
  });
});

describe('PublicListingService.detail', () => {
  it('returns a published listing as a PII-free detail DTO + JSON-LD', async () => {
    const { service, findFirst } = makeService([row()]);
    const res = await service.detail('listing-1');
    const arg = findFirst.mock.calls[0][0] as {
      where: { status: string };
    };
    expect(arg.where.status).toBe('published');
    const serialized = JSON.stringify(res.listing);
    expect(serialized).not.toContain('hirer-SECRET-001');
    expect(serialized).not.toContain('idem-SECRET-key');
    expect(res.listing.id).toBe('listing-1');
    expect(res.listing.description).toBe('Lead a regional squad of coaches.');
    expect(res.json_ld['@type']).toBe('JobPosting');
    expect(res.json_ld.identifier.value).toBe('listing-1');
  });

  it('404s a draft/closed/non-existent id (never leaks unpublished rows)', async () => {
    const { service } = makeService([row({ id: 'draft-1', status: 'draft' })]);
    await expect(service.detail('draft-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.detail('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PublicListingService — compensation summary shaping', () => {
  it('shapes each compensation type into a one-line card summary', async () => {
    const cases: Array<[Partial<Row>, string]> = [
      [{ compensation_type: 'commission', compensation_terms: { rate_pct: 20 } }, '20% commission'],
      [
        {
          compensation_type: 'rev_share',
          compensation_terms: { rate_pct: 15, cap_usd: 5000 },
        },
        '15% rev share (cap $5,000)',
      ],
      [
        {
          compensation_type: 'flat',
          compensation_terms: { amount_usd: 4000, period: 'monthly' },
        },
        '$4,000/monthly',
      ],
      [
        {
          compensation_type: 'hybrid',
          compensation_terms: { base_usd: 2000, rate_pct: 10 },
        },
        '$2,000 base + 10%',
      ],
    ];
    for (const [over, expected] of cases) {
      const { service } = makeService([row(over)]);
      const res = await service.browse({});
      expect(res.items[0].compensation_summary).toBe(expected);
    }
  });
});
