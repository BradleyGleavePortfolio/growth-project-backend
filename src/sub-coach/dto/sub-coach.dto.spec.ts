import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AssignClientDto,
  ReassignClientDto,
  ListSubCoachesQueryDto,
} from './sub-coach.dto';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_UUID = '22222222-2222-2222-2222-222222222222';

function errs(obj: object, cls: { new (): object }) {
  const instance = plainToInstance(cls, obj);
  return validateSync(instance, { whitelist: true, forbidNonWhitelisted: false });
}

describe('AssignClientDto', () => {
  it('accepts a valid payload', () => {
    expect(
      errs({ clientId: VALID_UUID, idempotency_key: OTHER_UUID }, AssignClientDto),
    ).toHaveLength(0);
  });

  it('rejects non-UUID clientId', () => {
    expect(
      errs({ clientId: 'not-a-uuid', idempotency_key: OTHER_UUID }, AssignClientDto)
        .length,
    ).toBeGreaterThan(0);
  });

  it('rejects missing idempotency_key', () => {
    expect(
      errs({ clientId: VALID_UUID }, AssignClientDto).length,
    ).toBeGreaterThan(0);
  });

  it('rejects reason exceeding 500 chars', () => {
    expect(
      errs(
        {
          clientId: VALID_UUID,
          idempotency_key: OTHER_UUID,
          reason: 'x'.repeat(501),
        },
        AssignClientDto,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('ReassignClientDto', () => {
  it('accepts a valid payload with reason', () => {
    expect(
      errs(
        {
          clientId: VALID_UUID,
          targetSubCoachId: OTHER_UUID,
          idempotency_key: '33333333-3333-3333-3333-333333333333',
          reason: 'manual transfer',
        },
        ReassignClientDto,
      ),
    ).toHaveLength(0);
  });

  it('rejects when targetSubCoachId is missing', () => {
    expect(
      errs(
        { clientId: VALID_UUID, idempotency_key: OTHER_UUID },
        ReassignClientDto,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('ListSubCoachesQueryDto', () => {
  it('accepts limit and cursor', () => {
    expect(
      errs({ limit: 20, cursor: VALID_UUID }, ListSubCoachesQueryDto),
    ).toHaveLength(0);
  });

  it('rejects limit > 50', () => {
    expect(
      errs({ limit: 51 }, ListSubCoachesQueryDto).length,
    ).toBeGreaterThan(0);
  });

  it('rejects non-UUID cursor', () => {
    expect(
      errs({ cursor: 'bad' }, ListSubCoachesQueryDto).length,
    ).toBeGreaterThan(0);
  });
});
