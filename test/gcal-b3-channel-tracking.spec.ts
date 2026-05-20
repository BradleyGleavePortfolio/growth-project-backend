// test/gcal-b3-channel-tracking.spec.ts
//
// Unit tests for B3: channel_id / resource_id / channel_expires_at columns
// on CalendarConnection.
//
// Verifies:
//   1. The generated Prisma Client exposes the three new fields on the
//      CalendarConnection model type with the correct TypeScript types
//      (string|null, string|null, Date|null).
//   2. A mock prisma.calendarConnection.create call that sets all three
//      columns compiles and the mock receives the correct values.
//   3. A mock prisma.calendarConnection.update call that clears the columns
//      (null-out on disconnect) compiles cleanly.
//   4. A mock prisma.calendarConnection.findFirst call that filters by
//      channel_id compiles and returns the typed row.
//   5. channel_id uniqueness constraint is reflected in the Prisma-generated
//      WhereUniqueInput type (i.e. `channel_id` is a valid unique lookup key).
//
// These tests do NOT hit a real database. They exercise compile-time and
// runtime shape guarantees using in-memory mocks — the same pattern used
// throughout the test suite (see calendar-oauth-kms.spec.ts).

import type {
  CalendarConnection,
  Prisma,
} from '@prisma/client';

// ─── Type-level assertions ───────────────────────────────────────────────────
// These are compile-time checks. If the Prisma schema is wrong or the client
// was not regenerated, tsc will fail here.

// 1. channel_id is string|null on the model type.
type _ChannelId = CalendarConnection['channel_id'];
const _assertChannelIdNullable: null extends _ChannelId ? true : false = true;
const _assertChannelIdString: string extends NonNullable<_ChannelId> ? true : false = true;

// 2. resource_id is string|null.
type _ResourceId = CalendarConnection['resource_id'];
const _assertResourceIdNullable: null extends _ResourceId ? true : false = true;
const _assertResourceIdString: string extends NonNullable<_ResourceId> ? true : false = true;

// 3. channel_expires_at is Date|null.
type _ChannelExpiresAt = CalendarConnection['channel_expires_at'];
const _assertExpiresAtNullable: null extends _ChannelExpiresAt ? true : false = true;
const _assertExpiresAtDate: Date extends NonNullable<_ChannelExpiresAt> ? true : false = true;

// 4. channel_id appears in CalendarConnectionWhereUniqueInput (unique constraint).
type _WhereUnique = Prisma.CalendarConnectionWhereUniqueInput;
type _ChannelIdInUnique = _WhereUnique extends { channel_id?: unknown } ? true : false;
const _assertChannelIdUnique: _ChannelIdInUnique = true;

// Suppress "unused variable" TS warnings — these are intentional type probes.
void _assertChannelIdNullable;
void _assertChannelIdString;
void _assertResourceIdNullable;
void _assertResourceIdString;
void _assertExpiresAtNullable;
void _assertExpiresAtDate;
void _assertChannelIdUnique;

// ─── Runtime tests ───────────────────────────────────────────────────────────

const CHANNEL_EXPIRES = new Date('2026-05-27T12:00:00.000Z'); // 7 days out

function buildMockConnection(
  overrides: Partial<CalendarConnection> = {},
): CalendarConnection {
  return {
    id: 'conn-uuid-1',
    user_id: 'user-uuid-1',
    provider: 'google_calendar',
    external_account_id: 'coach@example.com',
    credentials_secret_ref: null,
    encrypted_refresh_token: null,
    channel_id: null,
    resource_id: null,
    channel_expires_at: null,
    last_synced_at: null,
    disconnected_at: null,
    created_at: new Date('2026-05-20T00:00:00.000Z'),
    updated_at: new Date('2026-05-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CalendarConnection — B3 channel tracking columns', () => {
  describe('schema presence and types', () => {
    it('new columns default to null on a baseline connection', () => {
      const conn = buildMockConnection();

      expect(conn.channel_id).toBeNull();
      expect(conn.resource_id).toBeNull();
      expect(conn.channel_expires_at).toBeNull();
    });

    it('channel_id accepts a UUID string', () => {
      const channelId = '550e8400-e29b-41d4-a716-446655440000';
      const conn = buildMockConnection({ channel_id: channelId });

      expect(conn.channel_id).toBe(channelId);
      expect(typeof conn.channel_id).toBe('string');
    });

    it('resource_id accepts a Google resource identifier string', () => {
      const resourceId = 'o3hgv1rqqmd8AVjf05';
      const conn = buildMockConnection({ resource_id: resourceId });

      expect(conn.resource_id).toBe(resourceId);
      expect(typeof conn.resource_id).toBe('string');
    });

    it('channel_expires_at accepts a Date value 7 days in the future', () => {
      const conn = buildMockConnection({ channel_expires_at: CHANNEL_EXPIRES });

      expect(conn.channel_expires_at).toBeInstanceOf(Date);
      expect(conn.channel_expires_at?.getTime()).toBe(CHANNEL_EXPIRES.getTime());
    });

    it('all three columns can be set together (post-watchCalendar state)', () => {
      const conn = buildMockConnection({
        channel_id: '550e8400-e29b-41d4-a716-446655440000',
        resource_id: 'o3hgv1rqqmd8AVjf05',
        channel_expires_at: CHANNEL_EXPIRES,
      });

      expect(conn.channel_id).not.toBeNull();
      expect(conn.resource_id).not.toBeNull();
      expect(conn.channel_expires_at).not.toBeNull();
    });
  });

  describe('prisma mock: create with channel columns', () => {
    it('create data containing channel fields is accepted and persisted', async () => {
      const createData: Prisma.CalendarConnectionCreateInput = {
        id: 'conn-uuid-2',
        provider: 'google_calendar',
        user: { connect: { id: 'user-uuid-2' } },
        channel_id: '550e8400-e29b-41d4-a716-446655440001',
        resource_id: 'res-abc123',
        channel_expires_at: CHANNEL_EXPIRES,
      };

      const mockPrisma = {
        calendarConnection: {
          create: jest.fn(async (args: { data: typeof createData }) => ({
            ...buildMockConnection({ user_id: 'user-uuid-2' }),
            ...args.data,
            user: undefined, // relation, not returned as flat field
            id: 'conn-uuid-2',
            channel_id: args.data.channel_id ?? null,
            resource_id: args.data.resource_id ?? null,
            channel_expires_at: args.data.channel_expires_at ?? null,
          })),
        },
      };

      const result = await mockPrisma.calendarConnection.create({
        data: createData,
      });

      expect(mockPrisma.calendarConnection.create).toHaveBeenCalledTimes(1);
      expect(result.channel_id).toBe('550e8400-e29b-41d4-a716-446655440001');
      expect(result.resource_id).toBe('res-abc123');
      expect(result.channel_expires_at).toBe(CHANNEL_EXPIRES);
    });
  });

  describe('prisma mock: update — clear channel columns on disconnect', () => {
    it('update can null out all three channel columns (watch stopped / disconnected)', async () => {
      const updateData: Prisma.CalendarConnectionUpdateInput = {
        channel_id: null,
        resource_id: null,
        channel_expires_at: null,
        disconnected_at: new Date(),
      };

      const mockPrisma = {
        calendarConnection: {
          update: jest.fn(async (_args: {
            where: { id: string };
            data: typeof updateData;
          }) => buildMockConnection({ disconnected_at: new Date() })),
        },
      };

      const result = await mockPrisma.calendarConnection.update({
        where: { id: 'conn-uuid-1' },
        data: updateData,
      });

      expect(mockPrisma.calendarConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel_id: null,
            resource_id: null,
            channel_expires_at: null,
          }),
        }),
      );
      expect(result.channel_id).toBeNull();
      expect(result.resource_id).toBeNull();
      expect(result.channel_expires_at).toBeNull();
    });
  });

  describe('prisma mock: findFirst by channel_id (webhook lookup)', () => {
    it('findFirst with a channel_id where clause returns the matching connection', async () => {
      const targetChannelId = '550e8400-e29b-41d4-a716-446655440000';
      const expected = buildMockConnection({
        channel_id: targetChannelId,
        resource_id: 'res-xyz',
        channel_expires_at: CHANNEL_EXPIRES,
      });

      const mockPrisma = {
        calendarConnection: {
          findFirst: jest.fn(async (args: {
            where: Prisma.CalendarConnectionWhereInput;
          }) => {
            if (args.where.channel_id === targetChannelId) {
              return expected;
            }
            return null;
          }),
        },
      };

      const result = await mockPrisma.calendarConnection.findFirst({
        where: { channel_id: targetChannelId },
      });

      expect(result).not.toBeNull();
      expect(result?.channel_id).toBe(targetChannelId);
      expect(result?.resource_id).toBe('res-xyz');
      expect(result?.channel_expires_at).toBe(CHANNEL_EXPIRES);
    });

    it('findFirst returns null when no connection matches the channel_id', async () => {
      const mockPrisma = {
        calendarConnection: {
          findFirst: jest.fn(async (_args: {
            where: Prisma.CalendarConnectionWhereInput;
          }) => null),
        },
      };

      const result = await mockPrisma.calendarConnection.findFirst({
        where: { channel_id: 'nonexistent-channel-uuid' },
      });

      expect(result).toBeNull();
    });
  });

  describe('channel_expires_at boundary logic (B5 renewal pre-check)', () => {
    it('correctly identifies a channel expiring within 48 hours as needing renewal', () => {
      const now = Date.now();
      const RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

      const expiringSoon = buildMockConnection({
        channel_expires_at: new Date(now + 24 * 60 * 60 * 1000), // 24h away
      });
      const notExpiringSoon = buildMockConnection({
        channel_expires_at: new Date(now + 72 * 60 * 60 * 1000), // 72h away
      });
      const alreadyExpired = buildMockConnection({
        channel_expires_at: new Date(now - 1000), // 1s ago
      });
      const nullChannel = buildMockConnection({
        channel_expires_at: null,
      });

      function needsRenewal(conn: CalendarConnection): boolean {
        if (conn.channel_expires_at === null) return false;
        return conn.channel_expires_at.getTime() < now + RENEWAL_WINDOW_MS;
      }

      expect(needsRenewal(expiringSoon)).toBe(true);
      expect(needsRenewal(notExpiringSoon)).toBe(false);
      expect(needsRenewal(alreadyExpired)).toBe(true);
      expect(needsRenewal(nullChannel)).toBe(false);
    });
  });
});
