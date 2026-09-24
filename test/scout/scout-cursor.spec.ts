import { BadRequestException, InternalServerErrorException, ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { ScoutRosterService } from '../../src/scout/scout-roster.service';
import { ScoutEntitiesService } from '../../src/scout/scout-entities.service';
import { ScoutRosterQueryDto } from '../../src/scout/scout-roster.dto';
import { ScoutEntitiesQueryDto } from '../../src/scout/scout-entities.dto';
import {
  decodeScoutCursor,
  encodeScoutCursor,
  resolveScoutCursor,
  SCOUT_CURSOR_MAX_LENGTH,
  scoutCursorOrder,
  scoutCursorWhere,
} from '../../src/scout/scout-cursor';
import { Prisma } from '@prisma/client';

const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const envelope = (family: string) => ({
  v: 2,
  c: 'coach',
  i: 'intent',
  f: family,
  o: 'source_id:asc,source_platform:asc',
  s: 'source',
  p: 'truecoach',
});
const v2 = (v: unknown) => `v2.${encode(JSON.stringify(v))}`;

const SCOPE = {
  coach_id: 'coach',
  intent_id: 'intent',
  entity_type: 'workouts',
  status: 'reconstructed',
};
/** A ledger reader fake: records the resolution query and answers with the given rows. */
function ledgerTx(rows: Array<{ source_platform: string | null }>) {
  const findMany = jest.fn((_args: unknown) => Promise.resolve(rows));
  const tx = { scoutReconstructionLedger: { findMany } } as object as Prisma.TransactionClient;
  return { tx, findMany };
}

describe('Q1 scoped v2 encoder, decoder, legacy resolution and HTTP boundary', () => {
  it.each(['clients', 'workouts', 'client_history'])('accepts exact v2 %s boundary', (family) => {
    const after = decodeScoutCursor(v2(envelope(family)), 'coach', 'intent', family);
    expect(after).toEqual({ s: 'source', p: 'truecoach' });
    expect(scoutCursorWhere({ s: 'source', p: 'truecoach' })).toEqual({
      OR: [
        { source_id: { gt: 'source' } },
        { source_id: 'source', source_platform: { gt: 'truecoach' } },
      ],
    });
    expect(scoutCursorOrder()).toEqual([{ source_id: 'asc' }, { source_platform: 'asc' }]);
  });

  it.each(['clients', 'workouts', 'client_history'])(
    'emits the exact canonical v2 envelope for %s and round-trips it',
    (family) => {
      const token = encodeScoutCursor('coach', 'intent', family, 'source', 'truecoach');
      expect(token).toBe(v2(envelope(family)));
      expect(token.startsWith('v2.')).toBe(true);
      const json = Buffer.from(token.slice(3), 'base64url').toString('utf8');
      expect(Object.keys(JSON.parse(json) as object)).toEqual(['v', 'c', 'i', 'f', 'o', 's', 'p']);
      expect(decodeScoutCursor(token, 'coach', 'intent', family)).toEqual({
        s: 'source',
        p: 'truecoach',
      });
      // Emitted tokens are bound: any other scope or endpoint refuses them.
      expect(() => decodeScoutCursor(token, 'other', 'intent', family)).toThrow('malformed cursor');
      expect(() => decodeScoutCursor(token, 'coach', 'other', family)).toThrow('malformed cursor');
      expect(() =>
        decodeScoutCursor(token, 'coach', 'intent', family === 'clients' ? 'workouts' : 'clients'),
      ).toThrow('malformed cursor');
    },
  );

  it('round-trips every worst-case boundary and stays within the HTTP bound', () => {
    for (const id of ['\u0001'.repeat(256), '😀'.repeat(256), '\\'.repeat(256), '"'.repeat(256)]) {
      const token = encodeScoutCursor(id, id, 'clients', id, 'a'.repeat(256));
      expect(token.length).toBeLessThanOrEqual(SCOUT_CURSOR_MAX_LENGTH);
      expect(decodeScoutCursor(token, id, id, 'clients')).toEqual({ s: id, p: 'a'.repeat(256) });
    }
  });

  it('fails closed instead of emitting an undecodable token', () => {
    const bad: Array<[string, string, string, string]> = [
      ['coach', 'intent', '', 'truecoach'],
      ['coach', 'intent', 'a'.repeat(257), 'truecoach'],
      ['coach', 'intent', 's\u0000', 'truecoach'],
      ['coach', 'intent', '\ud800', 'truecoach'],
      ['coach', 'intent', 's', 'TrueCoach'],
      ['coach', 'intent', 's', ''],
      ['coach', 'intent', 's', 'a'.repeat(257)],
      ['', 'intent', 's', 'truecoach'],
      ['coach', '', 's', 'truecoach'],
    ];
    for (const [c, i, s, p] of bad) {
      expect(() => encodeScoutCursor(c, i, 'clients', s, p)).toThrow(InternalServerErrorException);
    }
  });

  it('still decodes the distinct legacy formats to a source-only boundary', () => {
    const e = { c: 'coach', i: 'intent', f: 'workouts', o: 'source_id:asc', s: 's' };
    expect(decodeScoutCursor(encode('s'), 'coach', 'intent', 'clients')).toEqual({ s: 's' });
    expect(decodeScoutCursor(encode(JSON.stringify(e)), 'coach', 'intent', 'workouts')).toEqual({
      s: 's',
    });
    expect(scoutCursorWhere(null)).toEqual({});
  });

  it('resolves a legacy boundary only through exactly one canonical ledger row in scope', async () => {
    const { tx, findMany } = ledgerTx([{ source_platform: 'truecoach' }]);
    await expect(resolveScoutCursor(tx, SCOPE, { s: 's' })).resolves.toEqual({
      s: 's',
      p: 'truecoach',
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { ...SCOPE, source_id: 's' },
      select: { source_platform: true },
      take: 2,
    });
  });

  it('passes v2 and empty boundaries through without any lookup', async () => {
    const { tx, findMany } = ledgerTx([]);
    await expect(resolveScoutCursor(tx, SCOPE, { s: 's', p: 'p' })).resolves.toEqual({
      s: 's',
      p: 'p',
    });
    await expect(resolveScoutCursor(tx, SCOPE, null)).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each<[string, Array<{ source_platform: string | null }>]>([
    ['absent (forged, foreign or never reconstructed)', []],
    ['tied across platforms', [{ source_platform: 'a' }, { source_platform: 'b' }]],
    ['noncanonical provenance', [{ source_platform: 'TrueCoach' }]],
    ['null provenance', [{ source_platform: null }]],
  ])('refuses an unresolvable legacy boundary as the documented 400: %s', async (_label, rows) => {
    const { tx } = ledgerTx(rows);
    const err = await resolveScoutCursor(tx, SCOPE, { s: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe('malformed cursor');
  });

  it.each(['clients', 'workouts'])(
    'rejects malformed and cross-scope %s tokens before reads',
    async (family) => {
      const e = envelope(family);
      const invalid = [
        '!',
        'v3.' + encode(JSON.stringify(e)),
        v2({ ...e, v: 3 }),
        v2({ ...e, v: '2' }),
        v2({ ...e, c: 'foreign' }),
        v2({ ...e, i: 'foreign' }),
        v2({ ...e, f: family === 'clients' ? 'workouts' : 'clients' }),
        v2({ ...e, o: 'source_id:desc' }),
        v2({ ...e, s: '' }),
        v2({ ...e, s: 1 }),
        v2({ ...e, s: 'a'.repeat(257) }),
        v2({ ...e, s: '\u0000' }),
        v2({ ...e, s: '\ud800' }),
        v2({ ...e, p: null }),
        v2({ ...e, p: 'TrueCoach' }),
        v2({ ...e, p: 'a\n' }),
        v2({ ...e, extra: 'ignored?' }),
        v2([e]),
        v2(null),
        v2({ ...e, p: undefined }),
        `v2.${encode(JSON.stringify(e, null, 2))}`,
        `${v2(e)}=`,
        `v2.${encode(JSON.stringify(e).replace('"v":2', '"v":2,"v":2'))}`,
        `v2.${Buffer.from([0xff]).toString('base64url')}`,
        'a'.repeat(SCOUT_CURSOR_MAX_LENGTH + 1),
      ];
      const transaction = jest.fn();
      const db = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
        $transaction: transaction,
      });
      const analytics = Object.create(AnalyticsService.prototype) as AnalyticsService;
      for (const cursor of invalid) {
        const call =
          family === 'clients'
            ? new ScoutRosterService(db, analytics).getRoster('coach', 'intent', cursor, 1)
            : new ScoutEntitiesService(db, analytics).getEntities(
                'coach',
                'intent',
                family,
                cursor,
                1,
              );
        await expect(call).rejects.toThrow('malformed cursor');
      }
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['clients', 'workouts'])(
    'accepts worst-case escaped and Unicode identifiers through the real %s query pipe',
    async (family) => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      for (const identifier of ['\u0001'.repeat(256), '😀'.repeat(256), '\\'.repeat(256)]) {
        const e = {
          ...envelope(family),
          c: identifier,
          i: identifier,
          s: identifier,
          p: 'a'.repeat(256),
        };
        const cursor = v2(e);
        expect(cursor.length).toBeGreaterThan(512);
        expect(cursor.length).toBeLessThanOrEqual(SCOUT_CURSOR_MAX_LENGTH);
        const query =
          family === 'clients'
            ? { intent_id: identifier, cursor }
            : { intent_id: identifier, cursor, family };
        const dto = family === 'clients' ? ScoutRosterQueryDto : ScoutEntitiesQueryDto;
        await expect(
          pipe.transform(query, { type: 'query', metatype: dto }),
        ).resolves.toMatchObject(query);
        expect(decodeScoutCursor(cursor, identifier, identifier, family)).toEqual({
          s: identifier,
          p: e.p,
        });
        const legacy =
          family === 'clients'
            ? encode(identifier)
            : encode(
                JSON.stringify({
                  c: identifier,
                  i: identifier,
                  f: family,
                  o: 'source_id:asc',
                  s: identifier,
                }),
              );
        await expect(
          pipe.transform({ ...query, cursor: legacy }, { type: 'query', metatype: dto }),
        ).resolves.toMatchObject({ cursor: legacy });
        expect(decodeScoutCursor(legacy, identifier, identifier, family)).toEqual({
          s: identifier,
        });
        await expect(
          pipe.transform(
            { ...query, cursor: 'a'.repeat(SCOUT_CURSOR_MAX_LENGTH + 1) },
            { type: 'query', metatype: dto },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    },
  );
});
