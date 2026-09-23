import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { ScoutRosterService } from '../../src/scout/scout-roster.service';
import { ScoutEntitiesService } from '../../src/scout/scout-entities.service';
import { ScoutRosterQueryDto } from '../../src/scout/scout-roster.dto';
import { ScoutEntitiesQueryDto } from '../../src/scout/scout-entities.dto';
import {
  decodeScoutCursor,
  SCOUT_CURSOR_MAX_LENGTH,
  scoutCursorOrder,
  scoutCursorWhere,
} from '../../src/scout/scout-cursor';

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

describe('Q0 scoped decoder and HTTP boundary', () => {
  it.each(['clients', 'workouts', 'client_history'])('accepts exact v2 %s boundary', (family) => {
    const after = decodeScoutCursor(v2(envelope(family)), 'coach', 'intent', family);
    expect(after).toEqual({ s: 'source', p: 'truecoach' });
    expect(scoutCursorWhere(after)).toEqual({
      OR: [
        { source_id: { gt: 'source' } },
        { source_id: 'source', source_platform: { gt: 'truecoach' } },
      ],
    });
    expect(scoutCursorOrder(after)).toEqual([{ source_id: 'asc' }, { source_platform: 'asc' }]);
  });

  it('retains the distinct legacy formats without a provenance lookup', () => {
    const e = { c: 'coach', i: 'intent', f: 'workouts', o: 'source_id:asc', s: 's' };
    expect(decodeScoutCursor(encode('s'), 'coach', 'intent', 'clients')).toEqual({ s: 's' });
    expect(decodeScoutCursor(encode(JSON.stringify(e)), 'coach', 'intent', 'workouts')).toEqual({
      s: 's',
    });
    expect(scoutCursorWhere({ s: 's' })).toEqual({ source_id: { gt: 's' } });
    expect(scoutCursorOrder({ s: 's' })).toEqual({ source_id: 'asc' });
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
