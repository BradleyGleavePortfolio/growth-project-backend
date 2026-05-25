// test/_fixtures/coach-brief-mocks.ts
//
// P3-3: typed Prisma + service mock factories for the Coach Brief
// specs. Lets the spec files use real interfaces instead of `as any`
// casts so TypeScript catches contract drift between Prisma → service
// → controller boundaries.
//
// Each Prisma delegate exposes only the methods the Coach Brief module
// actually calls. The shape is structurally compatible with PrismaService
// when passed via `as unknown as PrismaService`, which centralises that
// cast in this file rather than in every individual test.

import type { PrismaService } from '../../src/prisma.service';
import type Anthropic from '@anthropic-ai/sdk';
import type { ConfigService } from '@nestjs/config';
import type {
  BriefContext,
  BriefContextHeadCoach,
} from '../../src/coach/brief/coach-brief.types';

// ─── Prisma delegate shapes (only the methods we mock) ─────────────────

export interface MockUserDelegate {
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
}

export interface MockCoachBriefDelegate {
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
}

export interface MockCoachDailyLogDelegate {
  findUnique: jest.Mock;
  upsert: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
}

export interface MockCoachBriefPreferencesDelegate {
  findUnique: jest.Mock;
  upsert: jest.Mock;
  findMany: jest.Mock;
  updateMany: jest.Mock;
}

export interface MockCoachBriefPushLedgerDelegate {
  upsert: jest.Mock;
  updateMany: jest.Mock;
  findUnique: jest.Mock;
}

export interface MockTeamSubCoachAssignmentDelegate {
  findFirst: jest.Mock;
  count: jest.Mock;
  findMany: jest.Mock;
}

export interface MockSubCoachAssignmentDelegate {
  findMany: jest.Mock;
}

export interface MockClientWorkoutAssignmentDelegate {
  findMany: jest.Mock;
  count: jest.Mock;
}

export interface MockCheckInDelegate {
  findMany: jest.Mock;
}

export interface MockClientPurchaseDelegate {
  aggregate: jest.Mock;
  count: jest.Mock;
  findMany: jest.Mock;
}

export interface MockCoachMessageDelegate {
  findMany: jest.Mock;
}

export interface MockPrisma {
  user: MockUserDelegate;
  coachBrief: MockCoachBriefDelegate;
  coachDailyLog: MockCoachDailyLogDelegate;
  coachBriefPreferences: MockCoachBriefPreferencesDelegate;
  coachBriefPushLedger: MockCoachBriefPushLedgerDelegate;
  teamSubCoachAssignment: MockTeamSubCoachAssignmentDelegate;
  subCoachAssignment: MockSubCoachAssignmentDelegate;
  clientWorkoutAssignment: MockClientWorkoutAssignmentDelegate;
  checkIn: MockCheckInDelegate;
  clientPurchase: MockClientPurchaseDelegate;
  coachMessage: MockCoachMessageDelegate;
  $queryRaw: jest.Mock;
}

export function makeMockPrisma(): MockPrisma {
  return {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachBrief: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachDailyLog: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachBriefPreferences: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    coachBriefPushLedger: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    subCoachAssignment: {
      findMany: jest.fn(),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    checkIn: {
      findMany: jest.fn(),
    },
    clientPurchase: {
      aggregate: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    coachMessage: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

// Use this when constructing the service so the cast is one-shot.
export function asPrismaService(p: MockPrisma): PrismaService {
  return p as unknown as PrismaService;
}

// ─── Anthropic mock ────────────────────────────────────────────────────

export interface MockAnthropic {
  messages: {
    create: jest.Mock;
  };
}

export function makeMockAnthropic(
  scenario: string | Error | Array<string | Error>,
): MockAnthropic {
  const queue: Array<string | Error> = Array.isArray(scenario)
    ? [...scenario]
    : [scenario];

  return {
    messages: {
      create: jest.fn(async () => {
        const next = queue.length > 0 ? queue.shift() : scenario;
        if (next instanceof Error) throw next;
        return { content: [{ type: 'text', text: next as string }] };
      }),
    },
  };
}

export function asAnthropic(a: MockAnthropic): Anthropic {
  return a as unknown as Anthropic;
}

// ─── Config mock ───────────────────────────────────────────────────────

export interface MockConfig {
  get: jest.Mock;
}

export function makeMockConfig(
  values: Record<string, string | undefined> = {},
): MockConfig {
  return {
    get: jest.fn((k: string) => values[k]),
  };
}

export function asConfig(c: MockConfig): ConfigService {
  return c as unknown as ConfigService;
}

// ─── BriefContext factories ────────────────────────────────────────────

export function makeBriefContext(
  overrides: Partial<BriefContext> = {},
): BriefContext {
  return {
    brief_mode: 'solo_coach',
    date: '2026-05-25',
    checked_in_today: 5,
    missed_checkin: 2,
    workouts_pending_approval: 1,
    workouts_approved_today: 0,
    paid_today_count: 0,
    revenue_today_cents: 0,
    renewals_upcoming_7d: 0,
    dunning_in_progress: 0,
    weight_logs_flagged: 0,
    unread_messages: 0,
    coach_name: 'Sarah Johnson',
    coach_first_name: 'Sarah',
    roster_size: 7,
    ...overrides,
  };
}

export function makeHeadCoachContext(
  overrides: Partial<BriefContextHeadCoach> = {},
): BriefContextHeadCoach {
  return {
    brief_mode: 'head_coach',
    date: '2026-05-25',
    coach_name: 'Sarah Johnson',
    coach_first_name: 'Sarah',
    team_size: 2,
    team_clients_total: 24,
    active_clients: 24,
    new_clients_last_24h: 1,
    total_revenue_today_cents: 12000,
    team_revenue_30d_cents: 540000,
    mrr_projected_cents: 480000,
    paid_today_count: 3,
    dunning_in_progress: 1,
    dunning_amount_cents: 8900,
    sub_coach_highlights: [
      { coach_name: 'Marcus', active_clients: 12, new_clients_24h: 1 },
      { coach_name: 'Riley', active_clients: 8, new_clients_24h: 0 },
    ],
    ...overrides,
  };
}

// ─── Default wiring for solo-coach generateBrief path ──────────────────

export function wireSoloDefaults(
  prisma: MockPrisma,
  args: { coachId: string; clientIds: string[]; coachName?: string } = {
    coachId: 'coach1',
    clientIds: [],
  },
): void {
  prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.count.mockResolvedValue(0);
  prisma.user.findMany
    .mockResolvedValueOnce(args.clientIds.map((id) => ({ id })))
    .mockResolvedValueOnce([]); // missing check-in clients
  prisma.user.findUnique.mockResolvedValue({
    name: args.coachName ?? 'Sarah Johnson',
  });
  prisma.checkIn.findMany.mockResolvedValue([]);
  prisma.clientWorkoutAssignment.findMany.mockResolvedValue([]);
  prisma.clientWorkoutAssignment.count.mockResolvedValue(0);
  prisma.clientPurchase.aggregate.mockResolvedValue({
    _sum: { amount_cents: null },
    _count: { _all: 0 },
  });
  prisma.clientPurchase.count.mockResolvedValue(0);
  prisma.coachMessage.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([{ count: 0n, total: 0n }]);
}
