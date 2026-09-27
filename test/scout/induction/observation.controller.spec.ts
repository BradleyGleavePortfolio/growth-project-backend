import 'reflect-metadata';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { OBSERVATION_BODY_MAX_BYTES } from '../../../src/scout/induction/contract';
import {
  ObservationController,
  type ObservationRequest,
} from '../../../src/scout/induction/observation.controller';
import {
  OBSERVATION_MAX_ENTRIES,
  ScoutRunDeclarationDto,
  ScoutRunObservationDto,
  parseObservationEnvelope,
  withinDeclaredCardinality,
} from '../../../src/scout/induction/observation.dto';
import { ObservationService } from '../../../src/scout/induction/observation.service';
import { PLATFORM_A, SCOPE_1, SCOPE_2, rawEvidence } from '../../utils/g2-s10b-fixtures';

// S10-B — the two induction routes: metadata posture (same keys as run.controller.spec.ts),
// identity from the token only, the S10-A 32 KiB cap (R21) enforced on the exact received bytes,
// the S10-B envelope (intent binding, one entry per unit, cardinality), and the global
// ValidationPipe refusing every server-bound field a client might over-post.
const THROTTLE_LIMIT_DEFAULT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_DEFAULT_KEY = 'THROTTLER:TTLdefault';
const INTENT = '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f';

function makeReq(userId: string, rawBody?: Buffer): ObservationRequest {
  const req: ObservationRequest = { user: { id: userId } as AuthedRequest['user'] };
  if (rawBody !== undefined) req.rawBody = rawBody;
  return req;
}

/** The body as the route receives it, plus its exact serialised bytes. */
function upload(observations: object[], intentId = INTENT) {
  const body: ScoutRunObservationDto = { intent_id: intentId, observations };
  return { body, raw: Buffer.from(JSON.stringify(body), 'utf8') };
}

/** A raw body of exactly `bytes` bytes (valid JSON whitespace padding; the size is what matters). */
function paddedRaw(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x20);
}

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

describe('ObservationController', () => {
  let declare: jest.Mock;
  let observe: jest.Mock;
  let controller: ObservationController;

  beforeEach(() => {
    declare = jest.fn().mockResolvedValue({
      intent_id: INTENT,
      challenge_b64: Buffer.alloc(32).toString('base64'),
      declared_at: '2026-09-26T12:00:00.000Z',
    });
    observe = jest
      .fn()
      .mockResolvedValue({ intent_id: INTENT, execution_epoch: 1, stored: 1, replayed: 0 });
    const service = Object.assign(
      Object.create(ObservationService.prototype) as ObservationService,
      { declare, observe },
    );
    controller = new ObservationController(service);
  });

  describe('POST /api/scout/runs/declaration', () => {
    const platforms = [{ source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_1] }];

    it('delegates with the coach from the token and the body intent/platforms', async () => {
      await controller.postDeclaration(makeReq('coach-token'), { intent_id: INTENT, platforms });
      expect(declare).toHaveBeenCalledWith('coach-token', INTENT, platforms);
    });

    it('never reads an account field from the body — identity is the token', async () => {
      const overPosted: ScoutRunDeclarationDto & { coach_id: string } = {
        intent_id: INTENT,
        platforms,
        coach_id: 'attacker',
      };
      await controller.postDeclaration(makeReq('coach-token'), overPosted);
      expect(declare.mock.calls[0][0]).toBe('coach-token');
    });

    it.each(['coach_id', 'challenge_b64', 'declared_at', 'execution_epoch'])(
      'the ValidationPipe refuses a client-supplied server-bound field `%s`',
      async (field) => {
        const body = { intent_id: INTENT, platforms, [field]: 'client-value' };
        await expect(
          pipe.transform(body, { type: 'body', metatype: ScoutRunDeclarationDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it.each([
      ['an empty platform list', { intent_id: INTENT, platforms: [] }],
      [
        'a raw (non-digest) scope id',
        {
          intent_id: INTENT,
          platforms: [{ source_platform: PLATFORM_A, account_scope_id_digests: ['acct-123'] }],
        },
      ],
      [
        'a non-canonical slug',
        {
          intent_id: INTENT,
          platforms: [{ source_platform: 'Synthetic Src', account_scope_id_digests: [SCOPE_1] }],
        },
      ],
      [
        'a duplicate scope',
        {
          intent_id: INTENT,
          platforms: [
            { source_platform: PLATFORM_A, account_scope_id_digests: [SCOPE_1, SCOPE_1] },
          ],
        },
      ],
      ['a missing intent', { platforms }],
    ])('the ValidationPipe refuses %s', async (_label, body) => {
      await expect(
        pipe.transform(body, { type: 'body', metatype: ScoutRunDeclarationDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is a POST on `runs/declaration`, 200, coach|owner, 30/min', () => {
      const handler = ObservationController.prototype.postDeclaration;
      expect(Reflect.getMetadata(PATH_METADATA, ObservationController)).toBe('scout');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runs/declaration');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, handler)).toBe(30);
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, handler)).toBe(60_000);
    });
  });

  describe('POST /api/scout/runs/observation', () => {
    it('delegates the parsed entries with the coach from the token', async () => {
      const { body, raw } = upload([rawEvidence()]);
      await controller.postObservation(makeReq('coach-token', raw), body);
      expect(observe).toHaveBeenCalledTimes(1);
      const [coach, intent, entries] = observe.mock.calls[0] as [
        string,
        string,
        { evidence: object }[],
      ];
      expect(coach).toBe('coach-token');
      expect(intent).toBe(INTENT);
      expect(entries).toHaveLength(1);
      expect(entries[0].evidence).toMatchObject({ source_platform: PLATFORM_A, family: 'clients' });
    });

    it('accepts a body of exactly 32 KiB and refuses a 32769-byte body (R21), before the service', async () => {
      expect(OBSERVATION_BODY_MAX_BYTES).toBe(32 * 1024);
      const { body } = upload([rawEvidence()]);
      await controller.postObservation(makeReq('c', paddedRaw(OBSERVATION_BODY_MAX_BYTES)), body);
      expect(observe).toHaveBeenCalledTimes(1);
      observe.mockClear();
      await expect(
        controller.postObservation(makeReq('c', paddedRaw(32_769)), body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(observe).not.toHaveBeenCalled();
    });

    it('refuses when the raw body was not captured (fail closed, never re-measured)', async () => {
      const { body } = upload([rawEvidence()]);
      await expect(controller.postObservation(makeReq('c'), body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(observe).not.toHaveBeenCalled();
    });

    it('refuses two entries for one unit (one entry per (platform, scope, family))', async () => {
      const { body, raw } = upload([rawEvidence(), rawEvidence({ observedUnique: 9 })]);
      await expect(controller.postObservation(makeReq('c', raw), body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(observe).not.toHaveBeenCalled();
    });

    it('refuses an entry the S10-A evidence grammar rejects (unknown key)', async () => {
      const { body, raw } = upload([{ ...rawEvidence(), coach_id: 'attacker' }]);
      await expect(controller.postObservation(makeReq('c', raw), body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each(['coach_id', 'execution_epoch', 'received_at', 'evidence_digest'])(
      'the ValidationPipe refuses a client-supplied server-bound field `%s`',
      async (field) => {
        const body = { intent_id: INTENT, observations: [rawEvidence()], [field]: 'client-value' };
        await expect(
          pipe.transform(body, { type: 'body', metatype: ScoutRunObservationDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('the ValidationPipe passes evidence entries through unmodified for parseEvidence', async () => {
      const entry = rawEvidence();
      const out: unknown = await pipe.transform(
        { intent_id: INTENT, observations: [entry] },
        { type: 'body', metatype: ScoutRunObservationDto },
      );
      const parsed = parseObservationEnvelope(out);
      expect(parsed.ok).toBe(true);
    });

    it('is a POST on `runs/observation`, 200, coach|owner, 30/min', () => {
      const handler = ObservationController.prototype.postObservation;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runs/observation');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, handler)).toBe(30);
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, handler)).toBe(60_000);
    });
  });

  describe('the S10-B envelope (pure)', () => {
    it.each([
      ['a non-object body', [], 'not_object'],
      [
        'an extra key',
        { intent_id: INTENT, observations: [rawEvidence()], extra: 1 },
        'unknown_key',
      ],
      ['a missing key', { intent_id: INTENT }, 'missing_key'],
      ['an empty intent', { intent_id: '', observations: [rawEvidence()] }, 'bad_intent'],
      ['an empty list', { intent_id: INTENT, observations: [] }, 'bad_count'],
    ])('%s → %s', (_label, body, reason) => {
      expect(parseObservationEnvelope(body)).toEqual({ ok: false, reason });
    });

    it('refuses more entries than the static bound', () => {
      const many = Array.from({ length: OBSERVATION_MAX_ENTRIES + 1 }, () => ({}));
      expect(parseObservationEnvelope({ intent_id: INTENT, observations: many })).toEqual({
        ok: false,
        reason: 'too_large',
      });
    });

    it('cardinality is at most 4 families × the declared scopes', () => {
      expect(withinDeclaredCardinality(4, 1)).toBe(true);
      expect(withinDeclaredCardinality(5, 1)).toBe(false);
      expect(withinDeclaredCardinality(8, 2)).toBe(true);
      expect(withinDeclaredCardinality(1, 0)).toBe(false);
    });

    it('distinct scopes of one platform/family are distinct units', () => {
      const out = parseObservationEnvelope({
        intent_id: INTENT,
        observations: [rawEvidence(), rawEvidence({ scope: SCOPE_2 })],
      });
      expect(out.ok).toBe(true);
    });
  });
});
