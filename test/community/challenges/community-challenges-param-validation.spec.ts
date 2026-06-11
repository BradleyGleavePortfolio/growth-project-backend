/**
 * v3-1 R1 regression — runtime path-param + query UUID validation (Finding 3).
 *
 * Every challenge controller path param (workspaceId, challengeId, commentId)
 * now carries `ParseUUIDPipe({ version: '4' })`, and ListChallengesQueryDto's
 * `cohort_id` is `@IsUUID('4')`. A malformed id must produce a typed 400 at the
 * edge — it must never reach the service / Prisma UUID columns.
 *
 * These tests exercise the exact pipe instance the controller uses and the DTO
 * validator directly (no HTTP server needed), so they run in the default
 * `test/community` suite. The service is necessarily untouched: a 400 is thrown
 * before any handler body runs.
 */
import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ListChallengesQueryDto } from '../../../src/community/challenges/community-challenges.dto';

// Well-formed v4 UUIDs: version nibble = 4, variant nibble ∈ {8,9,a,b}.
const VALID_V4 = '44444444-4444-4444-8444-444444444444';
const VALID_V4_B = '11111111-1111-4111-8111-111111111111';

describe('challenge param validation (Finding 3)', () => {
  describe('ParseUUIDPipe({ version: 4 }) on path params', () => {
    const pipe = new ParseUUIDPipe({ version: '4' });
    const meta = {
      type: 'param' as const,
      metatype: String,
      data: 'challengeId',
    };

    const malformed = [
      'not-a-uuid',
      '123',
      '44444444-4444-4444-4444',
      "44444444-4444-4444-4444-444444444444' OR '1'='1",
      '',
    ];

    for (const bad of malformed) {
      it(`rejects malformed id ${JSON.stringify(bad)} with a 400`, async () => {
        await expect(pipe.transform(bad, meta)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    }

    it('passes a well-formed v4 uuid through unchanged', async () => {
      await expect(pipe.transform(VALID_V4, meta)).resolves.toBe(VALID_V4);
      await expect(pipe.transform(VALID_V4_B, meta)).resolves.toBe(VALID_V4_B);
    });
  });

  describe('ListChallengesQueryDto.cohort_id is @IsUUID(4)', () => {
    it('rejects a non-uuid cohort_id', async () => {
      const dto = plainToInstance(ListChallengesQueryDto, {
        cohort_id: 'not-a-uuid',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('cohort_id');
      expect(errors[0].constraints).toHaveProperty('isUuid');
    });

    it('accepts a well-formed v4 cohort_id', async () => {
      const dto = plainToInstance(ListChallengesQueryDto, {
        cohort_id: VALID_V4,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts an absent cohort_id (optional)', async () => {
      const dto = plainToInstance(ListChallengesQueryDto, { status: 'active' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
