// AUD-OPUS-RA-121 (Claude Opus 5.5 lens, agent 121) — audit-only probes for
// backend #667 @ bacd83e1 and #665 @ eb7cb7a8. Never merge. Each `it` states the
// CORRECT behaviour; a red `it` is a reproduced defect, a green one a control.

import 'reflect-metadata';
import { RomanConsultationIntakeSource } from '../../src/roman/context/roman-consultation.source';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { _resetRomanContextListeners } from '../../src/roman/context/roman-context-invalidation';
import {
  isAllowedWhileLocked,
  normalizePath,
} from '../../src/checkout/dunning-v2/dunning-lockout.guard';
import type { PrismaService } from '../../src/prisma.service';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  NOW,
  LOCAL_TODAY_PT,
  P1,
  COACH_A,
} from './fixtures/roman-personas';

beforeEach(() => _resetRomanContextListeners());

function intakeRow(answers: Record<string, unknown>) {
  return {
    client_id: 'client-x',
    version: 1,
    answers,
    current_revision: 3,
    disclaimer_version: null,
    disclaimer_accepted_at: null,
    screening_any_yes: false,
    saved_at: new Date('2026-09-30T12:00:00Z'),
    completed_at: null,
    created_at: new Date('2026-09-30T11:00:00Z'),
  };
}
function sourceFor(row: unknown): RomanConsultationIntakeSource {
  const prisma = {
    clientOnboardingIntake: { findUnique: async () => row },
  } as unknown as PrismaService;
  return new RomanConsultationIntakeSource(prisma);
}

// ─── B-667-1: a partly answered health screen reads as "completed" ──────────
describe('B-667-1 safety_intake.completed on a partly answered screen (#667 roman-consultation.source.ts:85-88)', () => {
  it('PROBE: 1 of 7 screening questions answered (P1 = no, P2..P7 unanswered) is NOT a completed screen', async () => {
    const s = await sourceFor(intakeRow({ P1: 'no' })).summarize('client-x', NOW);
    // Six health questions have no answer and the intake was never submitted.
    expect(s.safety_intake.clearance_recommended).toBe(false);
    expect(s.safety_intake.completed).toBe(false);
  });
  it('control: all 7 answered "no" is a completed, clear screen', async () => {
    const all = Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((k) => [k, 'no']));
    const s = await sourceFor(intakeRow(all)).summarize('client-x', NOW);
    expect(s.safety_intake.completed).toBe(true);
    expect(s.safety_intake.clearance_recommended).toBe(false);
  });
});

// ─── B-665-1: two connected providers double the wearable numbers ───────────
describe('B-665-1 wearables ignore the read-time provider precedence (#665 roman-client-context.service.ts:546-562,1198-1219)', () => {
  function withSecondProvider() {
    const db = makePersonaDb();
    // P1 already has OURA connected with last night's SLEEP_TOTAL_MIN 378 (ends 06:00 PT 09-30).
    db.raw.wearableConnections.push({
      user_id: P1,
      provider: 'APPLE_HEALTHKIT',
      status: 'connected',
      last_synced_at: new Date('2026-09-30T15:00:00Z'),
      disconnected_at: null,
    });
    // The same night as seen through Apple Health (distinct row by design: dedup_key has the provider;
    // WearableSample doc: "cross-provider overlap ... resolved at read time").
    db.raw.wearableSamples.push({
      user_id: P1,
      provider: 'APPLE_HEALTHKIT',
      metric: 'SLEEP_TOTAL_MIN',
      value: 378,
      start_at: new Date('2026-09-30T06:00:00Z'),
      end_at: new Date('2026-09-30T13:00:00Z'),
      source_tz: 'America/Los_Angeles',
    });
    db.raw.wearableSamples.push({
      user_id: P1,
      provider: 'APPLE_HEALTHKIT',
      metric: 'STEPS',
      value: 6100,
      start_at: new Date('2026-09-30T18:00:00Z'),
      end_at: new Date('2026-09-30T18:00:00Z'),
      source_tz: 'America/Los_Angeles',
    });
    return db;
  }
  it('control: one provider, last night is 6.3 h', async () => {
    const db = makePersonaDb();
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    expect(context.identity.local_date).toBe(LOCAL_TODAY_PT);
    expect(context.wearables.last_night_sleep_hours).toBe(6.3);
  });
  it('PROBE: the same night from OURA and APPLE_HEALTHKIT is still 6.3 h, never 12.6 h', async () => {
    const db = withSecondProvider();
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    expect(context.wearables.providers).toEqual(['apple_healthkit', 'oura']);
    expect(context.wearables.last_night_sleep_hours).toBe(6.3);
  });
  it('PROBE: today\'s steps from both providers are 6,100, never 12,200', async () => {
    const db = withSecondProvider();
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    const today = context.wearables.days.find((d) => d.date === LOCAL_TODAY_PT);
    expect(today?.steps).toBe(6100);
  });
});

// ─── B-665-2: GET /roman/context/me is reachable while locked out ───────────
describe('B-665-2 the disclosure route inherits the /roman lockout carve-out (#665 roman-context.controller.ts:37-50; spec line 178)', () => {
  it('control: the Roman chat surface stays reachable (lockout explanation carve-out)', () => {
    expect(isAllowedWhileLocked(normalizePath('/api/roman/sessions'))).toBe(true);
  });
  it('control: paid value surfaces are locked', () => {
    expect(isAllowedWhileLocked(normalizePath('/api/workouts'))).toBe(false);
    expect(isAllowedWhileLocked(normalizePath('/api/ai/chat'))).toBe(false);
  });
  it('PROBE: GET /roman/context/me (returns the coach plan, meal plan, guidelines, targets, coach messages) is locked', () => {
    expect(isAllowedWhileLocked(normalizePath('/api/roman/context/me'))).toBe(false);
  });
});

// ─── B-665-3: the coach thread / plan Roman reads is not the client's thread ─
describe('B-665-3 sub-coach rows are dropped (#665 roman-client-context.service.ts:407-413,489-501,780-788)', () => {
  const SUB = 'subcoach-S';
  /** The open delegation (SubCoachAssignment overlay; User.coach_id stays the head coach). */
  function withDelegation(db: ReturnType<typeof makePersonaDb>) {
    const open = {
      id: 'sca-1',
      head_coach_id: COACH_A.id,
      sub_coach_id: SUB,
      client_id: P1,
      unassigned_at: null,
      assigned_at: new Date('2026-09-01T00:00:00Z'),
    };
    (db.prisma as unknown as Record<string, unknown>).subCoachAssignment = {
      findFirst: async () => open,
      findMany: async () => [open],
    };
    return db;
  }
  it('PROBE: a delegated sub-coach message in the head-coach thread (MessagingService pins coach_id to the head coach, sender_id = sub-coach) is in recent_messages', async () => {
    const db = withDelegation(makePersonaDb());
    db.raw.users.push({ id: SUB, name: 'Sam Subcoach', role: 'sub_coach', coach_id: null });
    db.raw.coachMessages.push({
      coach_id: COACH_A.id,
      client_id: P1,
      sender_id: SUB,
      body: 'SUBCOACH-MSG-CANARY swap lunges for step-ups this week',
      created_at: new Date('2026-09-30T20:00:00Z'),
    });
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    const text = JSON.stringify(context.coach.recent_messages);
    expect(text).toContain('SUBCOACH-MSG-CANARY');
  });
  it('PROBE: a workout the delegated sub-coach assigned for today is today_session', async () => {
    const db = withDelegation(makePersonaDb());
    const base = db.raw.assignments.find((a) => a.client_id === P1) as Record<string, unknown>;
    db.raw.assignments.push({
      ...base,
      id: 'a-sub-today',
      assigned_by_coach_id: SUB,
      scheduled_for: new Date('2026-09-30T20:00:00Z'),
      completed_at: null,
      post_rpe: null,
      post_notes: null,
      snapshot: { plan_name: 'SUBCOACH-PLAN-CANARY', plan_type: 'strength', exercises_json: [] },
    });
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    expect(context.plan?.today_session?.name).toBe('SUBCOACH-PLAN-CANARY');
  });
});
