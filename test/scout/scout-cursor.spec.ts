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
/** The pair-only v2 envelope Q1 emitted before S11-E r2 (still accepted as input). */
const envelopeV2 = (family: string) => ({
  v: 2,
  c: 'coach',
  i: 'intent',
  f: family,
  o: 'source_id:asc,source_platform:asc',
  s: 'source',
  p: 'truecoach',
});
/** The row-precise v3 envelope S11-E r2 emits: the ledger's unique key, token included. */
const envelope = (family: string) => ({
  v: 3,
  c: 'coach',
  i: 'intent',
  f: family,
  o: 'source_id:asc,source_platform:asc,entity_type:asc',
  s: 'source',
  p: 'truecoach',
  t: family,
});
const v2 = (v: unknown) => `v2.${encode(JSON.stringify(v))}`;
const v3 = (v: unknown) => `v3.${encode(JSON.stringify(v))}`;

const SCOPE = {
  coach_id: 'coach',
  intent_id: 'intent',
  entity_type: 'workouts',
  status: 'reconstructed',
};
type LookupRow = { source_platform?: string | null; entity_type: string };
/** A ledger reader fake: records the resolution query and answers with the given rows. */
function ledgerTx(rows: LookupRow[]) {
  const findMany = jest.fn((_args: unknown) => Promise.resolve(rows));
  const tx = { scoutReconstructionLedger: { findMany } } as object as Prisma.TransactionClient;
  return { tx, findMany };
}

describe('Q1 scoped v3 encoder, decoder, v2/legacy resolution and HTTP boundary', () => {
  it.each(['clients', 'workouts', 'client_history'])('accepts exact v3 %s boundary', (family) => {
    const after = decodeScoutCursor(v3(envelope(family)), 'coach', 'intent', family);
    expect(after).toEqual({ s: 'source', p: 'truecoach', t: family });
    expect(scoutCursorWhere({ s: 'source', p: 'truecoach', t: family })).toEqual({
      OR: [
        { source_id: { gt: 'source' } },
        { source_id: 'source', source_platform: { gt: 'truecoach' } },
        { source_id: 'source', source_platform: 'truecoach', entity_type: { gt: family } },
      ],
    });
    // A pair boundary (no row shares the pair) continues after every row of the pair.
    expect(scoutCursorWhere({ s: 'source', p: 'truecoach', t: null })).toEqual({
      OR: [
        { source_id: { gt: 'source' } },
        { source_id: 'source', source_platform: { gt: 'truecoach' } },
      ],
    });
    expect(scoutCursorOrder()).toEqual([
      { source_id: 'asc' },
      { source_platform: 'asc' },
      { entity_type: 'asc' },
    ]);
  });

  it.each(['clients', 'workouts', 'client_history'])(
    'still accepts the exact pair-only v2 %s boundary minted before r2',
    (family) => {
      const after = decodeScoutCursor(v2(envelopeV2(family)), 'coach', 'intent', family);
      expect(after).toEqual({ s: 'source', p: 'truecoach' });
      expect(() => decodeScoutCursor(v2(envelopeV2(family)), 'other', 'intent', family)).toThrow(
        'malformed cursor',
      );
    },
  );

  it.each(['clients', 'workouts', 'client_history'])(
    'emits the exact canonical v3 envelope for %s and round-trips it',
    (family) => {
      const token = encodeScoutCursor('coach', 'intent', family, 'source', 'truecoach', family);
      expect(token).toBe(v3(envelope(family)));
      expect(token.startsWith('v3.')).toBe(true);
      const json = Buffer.from(token.slice(3), 'base64url').toString('utf8');
      expect(Object.keys(JSON.parse(json) as object)).toEqual([
        'v',
        'c',
        'i',
        'f',
        'o',
        's',
        'p',
        't',
      ]);
      expect(decodeScoutCursor(token, 'coach', 'intent', family)).toEqual({
        s: 'source',
        p: 'truecoach',
        t: family,
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
    // The token is the staged entity_type, bounded to 128 characters at ingest.
    for (const id of ['\u0001'.repeat(256), '😀'.repeat(256), '\\'.repeat(256), '"'.repeat(256)]) {
      const t = Array.from(id).slice(0, 128).join('');
      const token = encodeScoutCursor(id, id, 'clients', id, 'a'.repeat(256), t);
      expect(token.length).toBeLessThanOrEqual(SCOUT_CURSOR_MAX_LENGTH);
      expect(decodeScoutCursor(token, id, id, 'clients')).toEqual({
        s: id,
        p: 'a'.repeat(256),
        t,
      });
    }
  });

  it('fails closed instead of emitting an undecodable token', () => {
    const bad: Array<[string, string, string, string, string]> = [
      ['coach', 'intent', '', 'truecoach', 'clients'],
      ['coach', 'intent', 'a'.repeat(257), 'truecoach', 'clients'],
      ['coach', 'intent', 's\u0000', 'truecoach', 'clients'],
      ['coach', 'intent', '\ud800', 'truecoach', 'clients'],
      ['coach', 'intent', 's', 'TrueCoach', 'clients'],
      ['coach', 'intent', 's', '', 'clients'],
      ['coach', 'intent', 's', 'a'.repeat(257), 'clients'],
      ['', 'intent', 's', 'truecoach', 'clients'],
      ['coach', '', 's', 'truecoach', 'clients'],
      ['coach', 'intent', 's', 'truecoach', ''],
      ['coach', 'intent', 's', 'truecoach', 'a'.repeat(129)],
      ['coach', 'intent', 's', 'truecoach', 't\u0000'],
    ];
    for (const [c, i, s, p, t] of bad) {
      expect(() => encodeScoutCursor(c, i, 'clients', s, p, t)).toThrow(
        InternalServerErrorException,
      );
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
    const { tx, findMany } = ledgerTx([{ source_platform: 'truecoach', entity_type: 'workouts' }]);
    await expect(resolveScoutCursor(tx, SCOPE, { s: 's' })).resolves.toEqual({
      s: 's',
      p: 'truecoach',
      t: 'workouts',
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { ...SCOPE, source_id: 's' },
      select: { source_platform: true, entity_type: true },
      take: 2,
    });
  });

  it('passes v3 and empty boundaries through without any lookup', async () => {
    const { tx, findMany } = ledgerTx([]);
    await expect(resolveScoutCursor(tx, SCOPE, { s: 's', p: 'p', t: 't' })).resolves.toEqual({
      s: 's',
      p: 'p',
      t: 't',
    });
    await expect(resolveScoutCursor(tx, SCOPE, null)).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  describe('a pair-only v2 boundary is completed by the rows sharing its pair, in scope', () => {
    it('one row: the boundary is that row (its token completes the key)', async () => {
      const { tx, findMany } = ledgerTx([{ entity_type: 'u10-routines' }]);
      await expect(resolveScoutCursor(tx, SCOPE, { s: 's', p: 'p' })).resolves.toEqual({
        s: 's',
        p: 'p',
        t: 'u10-routines',
      });
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany.mock.calls[0][0]).toEqual({
        where: { ...SCOPE, source_id: 's', source_platform: 'p' },
        select: { entity_type: true },
        take: 2,
      });
    });

    it('no row: no tie can exist, the pair itself is the boundary (continue after the pair)', async () => {
      const { tx } = ledgerTx([]);
      await expect(resolveScoutCursor(tx, SCOPE, { s: 's', p: 'p' })).resolves.toEqual({
        s: 's',
        p: 'p',
        t: null,
      });
    });

    it('two rows: the boundary is AMBIGUOUS (the page may have ended between them) — fail closed 400', async () => {
      const { tx } = ledgerTx([{ entity_type: 'u10-routines' }, { entity_type: 'u10-sessions' }]);
      const err = await resolveScoutCursor(tx, SCOPE, { s: 's', p: 'p' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('malformed cursor');
    });
  });

  it.each<[string, LookupRow[]]>([
    ['absent (forged, foreign or never reconstructed)', []],
    [
      'tied across platforms',
      [
        { source_platform: 'a', entity_type: 'workouts' },
        { source_platform: 'b', entity_type: 'workouts' },
      ],
    ],
    [
      'tied across tokens of one platform',
      [
        { source_platform: 'a', entity_type: 'u10-routines' },
        { source_platform: 'a', entity_type: 'u10-sessions' },
      ],
    ],
    ['noncanonical provenance', [{ source_platform: 'TrueCoach', entity_type: 'workouts' }]],
    ['null provenance', [{ source_platform: null, entity_type: 'workouts' }]],
  ])('refuses an unresolvable legacy boundary as the documented 400: %s', async (_label, rows) => {
    const { tx } = ledgerTx(rows);
    const err = await resolveScoutCursor(tx, SCOPE, { s: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe('malformed cursor');
  });

  it.each(['clients', 'workouts'])(
    'rejects malformed and cross-scope %s tokens before reads',
    async (family) => {
      const e = envelopeV2(family);
      const r = envelope(family);
      const invalid = [
        '!',
        'v3.' + encode(JSON.stringify(e)),
        v2(r),
        v3({ ...r, v: 2 }),
        v3({ ...r, o: e.o }),
        v3({ ...r, t: undefined }),
        v3({ ...r, t: '' }),
        v3({ ...r, t: null }),
        v3({ ...r, t: 1 }),
        v3({ ...r, t: 'a'.repeat(129) }),
        v3({ ...r, t: 't\u0000' }),
        v3({ ...r, c: 'foreign' }),
        v3({ ...r, f: family === 'clients' ? 'workouts' : 'clients' }),
        v3({ ...r, extra: 'ignored?' }),
        `v3.${encode(JSON.stringify(r, null, 2))}`,
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
          ...envelopeV2(family),
          c: identifier,
          i: identifier,
          s: identifier,
          p: 'a'.repeat(256),
        };
        const cursor = v2(e);
        const row = { ...envelope(family), c: identifier, i: identifier, s: identifier, p: e.p };
        const emitted = v3(row);
        expect(emitted.length).toBeLessThanOrEqual(SCOUT_CURSOR_MAX_LENGTH);
        expect(decodeScoutCursor(emitted, identifier, identifier, family)).toEqual({
          s: identifier,
          p: e.p,
          t: family,
        });
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
