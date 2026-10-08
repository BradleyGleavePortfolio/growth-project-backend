import { Test } from '@nestjs/testing';
import { CoachService } from '../src/coach/coach.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ConsentService } from '../src/consent/consent.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

// COACH-ROW-SCRUB-130 (AUD-FIN-FOOD-129 B1): opening a client's Food log review
// (GET /coach/clients/:id/timeline) and tapping Archive or Unarchive
// (POST /coach/clients/:id/archive|unarchive) sent the coach's app the client's
// whole User row, phone push address included. These responses now carry the
// client as { id, name, archived_at } only. The controller returns the service
// result unchanged, so the service result is the response body.

const PUSH = 'ExponentPushToken[client-1-device]';
const DELETION_HASH = 'deletion-token-hash-client-1';
const AUTH_ID = 'auth-id-client-1';
const HIDDEN = ['expo_push_token', 'deletion_token_hash', 'deletion_token_expires_at', 'supabase_id'];
const ARCHIVED_AT = new Date('2026-10-01T00:00:00Z');

type Args = { where: Record<string, unknown>; select?: Record<string, boolean>; data?: Record<string, unknown> };

// Every User column, as the database returns the row when a query has no select.
function userRow(archivedAt: Date | null) {
  return {
    id: 'client-1',
    supabase_id: AUTH_ID,
    email: 'client-1@example.test',
    name: 'Client One',
    phone: '+15550100001',
    role: 'student',
    coach_id: 'coach-A',
    coach_practice_type: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    archived_at: archivedAt,
    deletion_scheduled_at: null,
    deleted_at: null,
    deletion_token_hash: DELETION_HASH,
    deletion_token_expires_at: new Date('2026-10-30T00:00:00Z'),
    deletion_requested_at: null,
    deletion_confirmed_at: null,
    expo_push_token: PUSH,
    signup_ref: 'coach-invite',
    default_payout_method_id: 'payout-method-1',
    first_win_completed_at: null,
    show_on_leaderboard: false,
    leaderboard_display_name: null,
  };
}

// The user mocks ignore `select` and return the whole row (the worst case for
// the response); the select each query sends is checked on its own.
async function build(archivedAt: Date | null) {
  const prisma = {
    user: {
      findFirst: jest.fn(async (_args: Args) => userRow(archivedAt)),
      update: jest.fn(async (args: Args) => ({ ...userRow(archivedAt), ...args.data })),
    },
    loggedFoodEntry: { findMany: jest.fn(async () => []) },
    workoutSession: { findMany: jest.fn(async () => []) },
    weightLog: { findMany: jest.fn(async () => []) },
    checkIn: { findMany: jest.fn(async () => []) },
  };
  const mod = await Test.createTestingModule({
    providers: [
      CoachService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: { write: jest.fn(async () => undefined) } },
      { provide: ConsentService, useValue: { coachCanAccess: jest.fn(async () => true) } },
      {
        provide: SubCoachScopeService,
        useValue: { isSubCoach: jest.fn(async () => false), getAuthorizedClientIds: jest.fn(async () => []) },
      },
    ],
  }).compile();
  return { svc: mod.get(CoachService), prisma };
}

function expectClientRow(client: unknown, archived: boolean) {
  expect(client).toEqual({ id: 'client-1', name: 'Client One', archived_at: archived ? expect.any(Date) : null });
}

function expectNothingHidden(body: unknown) {
  const json = JSON.stringify(body);
  for (const secret of [PUSH, DELETION_HASH, AUTH_ID]) expect(json).not.toContain(secret);
  for (const field of HIDDEN) expect(json).not.toContain(`"${field}"`);
}

function expectSelectWithoutHidden(args: Args | undefined) {
  expect(args?.select).toBeDefined();
  for (const field of HIDDEN) expect(args?.select).not.toHaveProperty(field);
}

describe('Coach client rows carry no push address (COACH-ROW-SCRUB-130)', () => {
  it('Food log review: the timeline returns the client as id, name and archived_at only', async () => {
    const { svc, prisma } = await build(null);

    const res = await svc.getClientTimeline('coach-A', 'client-1', 7, 'coach');

    if (!('client' in res)) throw new Error(`timeline returned ${JSON.stringify(res)}`);
    expectClientRow(res.client, false);
    expectNothingHidden(res);
    expectSelectWithoutHidden(prisma.user.findFirst.mock.calls[0]?.[0]);
  });

  it.each([
    { action: 'archive', state: 'an active client', start: null, archived: true, writes: 1 },
    { action: 'archive', state: 'an archived client', start: ARCHIVED_AT, archived: true, writes: 0 },
    { action: 'unarchive', state: 'an archived client', start: ARCHIVED_AT, archived: false, writes: 1 },
    { action: 'unarchive', state: 'an active client', start: null, archived: false, writes: 0 },
  ])('$action on $state returns the client as id, name and archived_at only', async ({ action, start, archived, writes }) => {
    const { svc, prisma } = await build(start);

    const res =
      action === 'archive'
        ? await svc.archiveClient('coach-A', 'client-1', 'coach')
        : await svc.unarchiveClient('coach-A', 'client-1', 'coach');

    expectClientRow(res, archived);
    expectNothingHidden(res);
    expectSelectWithoutHidden(prisma.user.findFirst.mock.calls[0]?.[0]);
    expect(prisma.user.update).toHaveBeenCalledTimes(writes);
    if (writes) expectSelectWithoutHidden(prisma.user.update.mock.calls[0]?.[0]);
  });
});
