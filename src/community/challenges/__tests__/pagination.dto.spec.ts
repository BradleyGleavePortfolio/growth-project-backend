/**
 * v3-1 pagination DTO validation (D-040, B-PAG-1).
 *
 * The community challenges read endpoints are defended request-side by the
 * shared PaginationQueryDto (and ListChallengesQueryDto, which extends it). The
 * global ValidationPipe in main.ts runs with { whitelist: true,
 * forbidNonWhitelisted: true, transform: true }, so these tests mirror that
 * transform + validate pipeline exactly:
 *
 *   - `limit` is OPTIONAL and arrives as a query-string value; it is coerced to
 *     an integer, then bounded to 1..50. `abc`, `1.5`, `0`, `-1`, `51` are all
 *     rejected; `1`, `20`, `50` (and their string forms) are accepted.
 *   - The default of 20 is NOT applied by the DTO (limit stays undefined when
 *     omitted) — the default lives in the repository's clampLimit, so this spec
 *     pins both halves: the DTO leaves a missing limit undefined, and the
 *     repository spec proves the 20 default is then applied.
 *   - `cursor` is OPTIONAL and must be a v4 uuid when present.
 *   - ListChallengesQueryDto inherits limit/cursor AND keeps cohort_id/status.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListChallengesQueryDto,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PaginationQueryDto,
} from '../community-challenges.dto';

const UUID = '44444444-4444-4444-8444-444444444444';

async function validatePagination(
  payload: object,
): Promise<{ errors: string[]; dto: PaginationQueryDto }> {
  const dto = plainToInstance(PaginationQueryDto, payload, {
    enableImplicitConversion: false,
  });
  const errors = await validate(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { errors: errors.map((e) => e.property), dto };
}

async function validateList(payload: object): Promise<string[]> {
  const dto = plainToInstance(ListChallengesQueryDto, payload, {
    enableImplicitConversion: false,
  });
  const errors = await validate(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('PaginationQueryDto (D-040)', () => {
  it('exposes the documented default (20) and max (50) bounds', () => {
    expect(PAGINATION_DEFAULT_LIMIT).toBe(20);
    expect(PAGINATION_MAX_LIMIT).toBe(50);
  });

  it('accepts an empty query — limit/cursor both optional, limit stays undefined', async () => {
    const { errors, dto } = await validatePagination({});
    expect(errors).toHaveLength(0);
    // The DTO does NOT inject the default; a missing limit is left undefined so
    // the repository applies PAGINATION_DEFAULT_LIMIT (proven in the repo spec).
    expect(dto.limit).toBeUndefined();
    expect(dto.cursor).toBeUndefined();
  });

  it('accepts a numeric limit of 20', async () => {
    const { errors, dto } = await validatePagination({ limit: 20 });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
  });

  it('coerces a string limit "20" (query params arrive as strings)', async () => {
    const { errors, dto } = await validatePagination({ limit: '20' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
    expect(typeof dto.limit).toBe('number');
  });

  it('accepts the lower bound limit=1 and the upper bound limit=50', async () => {
    expect((await validatePagination({ limit: 1 })).errors).toHaveLength(0);
    expect((await validatePagination({ limit: 50 })).errors).toHaveLength(0);
    expect((await validatePagination({ limit: '1' })).errors).toHaveLength(0);
    expect((await validatePagination({ limit: '50' })).errors).toHaveLength(0);
  });

  it('rejects limit=0 (below the minimum of 1)', async () => {
    expect((await validatePagination({ limit: 0 })).errors).toContain('limit');
  });

  it('rejects a negative limit', async () => {
    expect((await validatePagination({ limit: -1 })).errors).toContain('limit');
  });

  it('rejects limit above the max of 50', async () => {
    expect((await validatePagination({ limit: 51 })).errors).toContain('limit');
    expect((await validatePagination({ limit: '99' })).errors).toContain(
      'limit',
    );
  });

  it('rejects a non-integer limit', async () => {
    expect((await validatePagination({ limit: 1.5 })).errors).toContain(
      'limit',
    );
    expect((await validatePagination({ limit: 'abc' })).errors).toContain(
      'limit',
    );
  });

  it('accepts a valid uuid cursor', async () => {
    const { errors, dto } = await validatePagination({ cursor: UUID });
    expect(errors).toHaveLength(0);
    expect(dto.cursor).toBe(UUID);
  });

  it('rejects a non-uuid cursor', async () => {
    expect((await validatePagination({ cursor: 'not-a-uuid' })).errors).toContain(
      'cursor',
    );
  });

  it('rejects an unknown query property (whitelist)', async () => {
    const dto = plainToInstance(PaginationQueryDto, { bogus: 1 });
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((e) => e.property)).toContain('bogus');
  });
});

describe('ListChallengesQueryDto inherits pagination (D-040)', () => {
  it('accepts cohort_id + status + limit + cursor together', async () => {
    const errors = await validateList({
      cohort_id: UUID,
      status: 'active',
      limit: 20,
      cursor: UUID,
    });
    expect(errors).toHaveLength(0);
  });

  it('still rejects an invalid limit on the list query', async () => {
    expect(await validateList({ limit: 0 })).toContain('limit');
  });
});
