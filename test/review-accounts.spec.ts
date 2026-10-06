import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, isUUID } from 'class-validator';
import { LoginDto, AttachInviteCodeDto } from '../src/auth/auth.dto';
import { CreatePackageDto } from '../src/packages/packages.dto';
import { CreateProgramDto, SetProgramDayDto, BulkAssignProgramDto } from '../src/workout-builder/program-library.dto';
import { UpsertExerciseRowsDto } from '../src/workout-builder/workout-builder.dto';
import { CreateWorkoutDto } from '../src/workout/workout.dto';
import { LogFoodDto } from '../src/log/log.dto';
import { CreateCheckInDto } from '../src/check-ins/check-ins.dto';
import { CreateMessageDto } from '../src/messaging/messaging.dto';
import {
  ApproveSessionDto, CreateSessionTypeDto, RequestSessionDto, SetAvailabilityDto,
} from '../src/scheduling/dto/scheduling.dto';
import {
  describePlan, httpTransport, key, readConfig, seed,
  type RequestPlan, type ReviewConfig, type Role,
} from '../scripts/review-accounts/review';

// Inert fixtures, not credentials for any account or endpoint.
const coachId = '11111111-1111-4111-a111-111111111111';
const clientId = '22222222-2222-4222-a222-222222222222';
const config: ReviewConfig = {
  baseUrl: 'http://127.0.0.1:3000/api', endDate: '2026-10-06', local: true,
  coachEmail: 'coach@example.invalid', clientEmail: 'client@example.invalid',
  coachPassword: 'inert-test-fixture', clientPassword: 'inert-test-fixture',
  expectedCoachEmail: 'coach@example.invalid', expectedClientEmail: 'client@example.invalid',
};
type Row = Record<string, unknown>;
interface Call { role: Role; method: string; path: string; body?: Row; token?: string; idem?: string }
type Dto = new () => object;

const contracts: Array<[string, RegExp, Dto]> = [
  ['POST', /^\/auth\/login$/, LoginDto],
  ['POST', /^\/auth\/attach-invite-code$/, AttachInviteCodeDto],
  ['POST', /^\/v1\/coach\/packages$/, CreatePackageDto],
  ['POST', /^\/v1\/coach\/programs$/, CreateProgramDto],
  ['PUT', /^\/v1\/coach\/programs\/[^/]+\/days\/0\/[024]$/, SetProgramDayDto],
  ['PUT', /^\/workout-plans\/[^/]+\/exercises$/, UpsertExerciseRowsDto],
  ['POST', /^\/v1\/coach\/programs\/[^/]+\/assign$/, BulkAssignProgramDto],
  ['POST', /^\/workouts$/, CreateWorkoutDto],
  ['POST', /^\/log\/food$/, LogFoodDto],
  ['POST', /^\/check-ins$/, CreateCheckInDto],
  ['POST', /^\/(messages|coach\/clients\/[^/]+\/messages)$/, CreateMessageDto],
  ['POST', /^\/scheduling\/session-types$/, CreateSessionTypeDto],
  ['POST', /^\/scheduling\/coaches\/[^/]+\/availability$/, SetAvailabilityDto],
  ['POST', /^\/scheduling\/sessions$/, RequestSessionDto],
  ['POST', /^\/scheduling\/sessions\/[^/]+\/approve$/, ApproveSessionDto],
];

function apiDouble(options: {
  pendingConsent?: boolean; clientRole?: string; clientCoach?: string; badAssignment?: boolean;
  coachSignedEmail?: string; clientSignedEmail?: string; roster?: Row[];
} = {}) {
  const calls: Call[] = [];
  const packages: Row[] = [];
  const workouts: Row[] = [];
  const foodLogs: Row[] = [];
  const checkIns: Row[] = [];
  const messages: Row[] = [];
  const types: Row[] = [];
  const windows: Row[] = [];
  const bookings: Row[] = [];
  const plans = new Map<string, Row>();
  const assignees: Row[] = [];
  let program: Row | undefined;
  let clientCoach = options.clientCoach;
  let active = false;
  let counter = 0;
  const id = () => key(`fixture-resource-${++counter}`);
  const request: RequestPlan = async (role, method, path, body, token, idem) => {
    const url = new URL(path, 'http://127.0.0.1');
    const route = url.pathname;
    calls.push({ role, method, path, body, token, idem });
    expect(path).toMatch(/^\//);
    expect(path).not.toMatch(/(admin|payment-method|subscription-intent|checkout\/sessions|consent\/grant|register|become-coach)/);
    if (route !== '/auth/login') expect(token).toBe(`fixture-${role}-session`);
    if (idem) expect(isUUID(idem)).toBe(true);
    const contract = contracts.find(([verb, pattern]) => method === verb && pattern.test(route));
    if (contract) {
      const dto = plainToInstance(contract[2], body);
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    } else if (method !== 'GET') {
      // These two routes deliberately have no body DTO.
      expect(route).toMatch(/^\/v1\/(coach\/packages\/[^/]+\/publish|packages\/[^/]+\/claim-free)$/);
      expect(body === undefined || Object.keys(body).length === 0).toBe(true);
    }
    if (route === '/auth/login') {
      expect(token).toBeUndefined();
      return {
        access_token: `fixture-${role}-session`,
        user: {
          id: role === 'coach' ? coachId : clientId,
          role: role === 'coach' ? 'coach' : options.clientRole || 'student',
          coach_id: clientCoach,
          email: role === 'coach' ? options.coachSignedEmail || config.coachEmail : options.clientSignedEmail || config.clientEmail,
        },
      };
    }
    if (route === '/coach/clients') {
      expect(role).toBe('coach');
      expect(url.searchParams.get('status')).toBe('all');
      expect(url.searchParams.get('take')).toBe('2');
      return (options.roster || (clientCoach === coachId ? [{ id: clientId }] : [])).slice(0, 2);
    }
    if (route === '/coaches/me/invite-link') return { code: 'GP-REVIEW' };
    if (route === '/auth/attach-invite-code') {
      expect(role).toBe('client');
      clientCoach = coachId;
      return { coach_id: coachId, role: 'student', already_attached: false };
    }
    if (route === '/community/me') return {
      feature_flag_state: 'enabled', workspace_id: coachId,
      membership: role === 'client' && clientCoach === coachId ? { id: clientId, role: 'client' } : null,
    };
    if (route === '/v1/coach/packages' && method === 'GET') return { packages };
    if (route === '/v1/coach/packages' && method === 'POST') {
      expect(role).toBe('coach');
      const pkg = { ...body, id: id(), is_active: true, published_at: null };
      packages.push(pkg);
      return pkg;
    }
    if (/\/packages\/[^/]+\/publish$/.test(route)) {
      packages[0].published_at = '2026-10-06T12:00:00.000Z';
      return packages[0];
    }
    if (route === '/v1/checkout/entitlement') return { active };
    if (/\/claim-free$/.test(route)) {
      expect(role).toBe('client');
      expect(clientCoach).toBe(coachId);
      active = !options.pendingConsent;
      return { active, status: active ? 'created' : 'pending_consent' };
    }
    if (route === '/v1/coach/programs' && method === 'GET') return { items: program ? [program] : [], next_cursor: null };
    if (route === '/v1/coach/programs' && method === 'POST') {
      program = { ...body, id: id(), days: [] };
      return program;
    }
    if (/^\/v1\/coach\/programs\/[^/]+$/.test(route)) return program;
    if (/\/days\/0\/[024]$/.test(route)) {
      const planId = id();
      const slot = { week_index: 0, day_index: Number(route.slice(-1)), plan_id: planId };
      (program?.days as Row[]).push(slot);
      plans.set(planId, { id: planId, exercises: [] });
      return program;
    }
    if (route === '/exercises/search') return { items: [{ id: '0001', name: 'Squat' }], nextCursor: null };
    if (/^\/workout-plans\/[^/]+$/.test(route)) return plans.get(route.split('/')[2]);
    if (/\/exercises$/.test(route)) {
      const plan = plans.get(route.split('/')[2]);
      if (plan) plan.exercises = body?.rows;
      return body?.rows;
    }
    if (/\/assignees$/.test(route)) return { items: assignees, next_cursor: null };
    if (/\/assign$/.test(route)) {
      expect(role).toBe('coach');
      const result = { client_id: clientId, status: options.badAssignment ? 'failed' : 'assigned' };
      if (!options.badAssignment) assignees.push(result);
      return { results: [result] };
    }
    if (route === '/workouts' && method === 'GET') return workouts;
    if (route === '/workouts' && method === 'POST') {
      expect(role).toBe('client');
      workouts.push({ ...body, id: id() });
      return workouts[workouts.length - 1];
    }
    if (route === '/foods/search') return { results: [{ id: `fixture-food-${url.searchParams.get('q')}` }] };
    if (route === '/log/daily') return { entries: foodLogs.filter(row => row.date === url.searchParams.get('date')) };
    if (route === '/log/food') {
      foodLogs.push({ ...body, id: id() });
      return foodLogs[foodLogs.length - 1];
    }
    if (route === '/check-ins' && method === 'GET') return checkIns;
    if (route === '/check-ins') { checkIns.push({ ...body, id: id() }); return checkIns[0]; }
    if (/\/messages$/.test(route) && method === 'GET') return messages;
    if (/\/messages$/.test(route)) {
      expect(body?.client_message_id).toBe(idem);
      messages.push({ ...body, sender_id: role === 'coach' ? coachId : clientId });
      return messages[messages.length - 1];
    }
    if (/\/session-types$/.test(route) && method === 'GET') return types;
    if (route === '/scheduling/session-types') {
      types.push({ ...body, id: id() });
      return types[0];
    }
    if (/\/availability$/.test(route) && method === 'GET') return windows;
    if (/\/availability$/.test(route)) { windows.push(...body?.windows as Row[]); return windows; }
    if (route === '/scheduling/sessions' && method === 'GET') return url.searchParams.get('scope') === 'past' ? [] : bookings;
    if (/\/open-slots$/.test(route)) return { slots: [{
      start_at: '2026-10-07T16:00:00.000Z', end_at: '2026-10-07T16:30:00.000Z',
    }] };
    if (route === '/scheduling/sessions') {
      expect(role).toBe('client');
      bookings.push({ ...body, id: id(), status: 'requested' });
      return bookings[0];
    }
    if (/\/approve$/.test(route)) {
      expect(role).toBe('coach');
      bookings[0].status = 'pending_provider';
      return bookings[0];
    }
    throw new Error(`Unexpected request in offline double: ${method} ${route}`);
  };
  return { request, calls, packages, workouts, foodLogs, checkIns, messages, bookings, windows };
}

describe('store review public-HTTP request plan', () => {
  it('fills the requested synthetic data with controller-valid bodies and the right caller', async () => {
    const api = apiDouble();
    const report = await seed(config, api.request);
    expect(report).toMatchObject({
      activePlan: true, communityMembership: true, bookingStatus: 'pending_provider',
      created: { pairing: 1, package: 1, entitlement: 1, program: 1, programWorkouts: 3,
        assignment: 1, trainingLogs: 7, meals: 21, checkIn: 1, messages: 2, sessionType: 1, availability: 1, booking: 1 },
    });
    expect(api.workouts.map(row => String(row.date).slice(0, 10))).toEqual([
      '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
    ]);
    expect(api.foodLogs).toHaveLength(21);
    expect(api.messages.map(row => row.sender_id)).toEqual([clientId, coachId]);
    expect(api.packages[0]).toMatchObject({ amount_cents: 0, billing_type: 'one_time' });
    expect(api.calls.some(call => call.path === '/foods' && call.method === 'POST')).toBe(false);
  });

  it('a second pass skips existing samples rather than sending another write', async () => {
    const api = apiDouble();
    const first = await seed(config, api.request);
    api.calls.length = 0;
    const second = await seed(config, api.request);
    expect(second.packageId).toBe(first.packageId);
    expect(second.programId).toBe(first.programId);
    expect(second.bookingId).toBe(first.bookingId);
    expect(second.created).toEqual({});
    expect(second.skipped).toMatchObject({ trainingLogs: 7, meals: 21, messages: 2, assignment: 1, booking: 1 });
    expect(api.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/auth/login', '/auth/login']);
  });

  it('does not create logs or fabricate consent when the free grant is pending', async () => {
    const api = apiDouble({ pendingConsent: true });
    await expect(seed(config, api.request)).rejects.toThrow('Complete the client onboarding agreement');
    expect(api.workouts).toHaveLength(0);
    expect(api.foodLogs).toHaveLength(0);
    expect(api.calls.some(call => call.path.includes('consent/grant'))).toBe(false);
  });

  it.each([
    { clientRole: 'coach', error: 'student' },
    { clientCoach: '33333333-3333-4333-a333-333333333333', error: 'another coach' },
  ])('refuses a wrong role or an existing different coach before sample writes', async ({ error, ...options }) => {
    const api = apiDouble(options);
    await expect(seed(config, api.request)).rejects.toThrow(error);
    expect(api.calls.every(call => call.path === '/auth/login')).toBe(true);
  });

  it('refuses an unrelated valid coach/client login pair before any dataset write', async () => {
    const api = apiDouble({
      coachSignedEmail: 'unrelated-coach@example.invalid',
      clientSignedEmail: 'unrelated-client@example.invalid',
    });
    await expect(seed({
      ...config, coachEmail: 'unrelated-coach@example.invalid', clientEmail: 'unrelated-client@example.invalid',
    }, api.request)).rejects.toThrow('approved reviewer identity');
    expect(api.calls.every(call => call.path === '/auth/login')).toBe(true);
  });

  it('also refuses a different signed-in client before first-open bootstrap or pairing', async () => {
    const api = apiDouble({ clientSignedEmail: 'unrelated-client@example.invalid' });
    await expect(seed(config, api.request)).rejects.toThrow('approved reviewer identity');
    expect(api.calls.every(call => call.path === '/auth/login')).toBe(true);
  });

  it('refuses a coach with any other client, including archived clients, before any dataset write', async () => {
    const api = apiDouble({
      roster: [{ id: clientId }, { id: '33333333-3333-4333-a333-333333333333', archived_at: '2026-10-06T12:00:00.000Z' }],
    });
    await expect(seed(config, api.request)).rejects.toThrow('another client');
    expect(api.calls.every(call => call.path === '/auth/login' ||
      (call.method === 'GET' && call.path.startsWith('/coach/clients?')))).toBe(true);
  });

  it('accepts only a case-insensitive exact identity match, with the review client as the only roster entry', async () => {
    const api = apiDouble({ clientCoach: coachId, roster: [{ id: clientId }] });
    const report = await seed({
      ...config, expectedCoachEmail: config.expectedCoachEmail?.toUpperCase(),
      expectedClientEmail: config.expectedClientEmail?.toUpperCase(),
    }, api.request);
    expect(report.activePlan).toBe(true);
    expect(report.skipped.pairing).toBe(1);
  });

  it('requires separate approval pins before any HTTP request', async () => {
    const api = apiDouble();
    await expect(seed({ ...config, expectedCoachEmail: undefined }, api.request)).rejects.toThrow('approved reviewer identity');
    expect(api.calls).toHaveLength(0);
  });

  it('does not claim completion when bulk assignment returns a per-client failure', async () => {
    const api = apiDouble({ badAssignment: true });
    await expect(seed(config, api.request)).rejects.toThrow('program assignment did not succeed');
    expect(api.workouts).toHaveLength(0);
  });

  it('retains an existing check-in and coach availability', async () => {
    const api = apiDouble();
    api.checkIns.push({ date: config.endDate, notes: 'Existing synthetic entry' });
    api.windows.push({ day_of_week: 3, start_minute: 540, end_minute: 1020 });
    const result = await seed(config, api.request);
    expect(result.skipped).toMatchObject({ checkIn: 1, availability: 1 });
    expect(api.checkIns).toHaveLength(1);
    expect(api.windows).toHaveLength(1);
  });
});

describe('operator destination and private-output gates', () => {
  const env = { REVIEW_API_BASE_URL: config.baseUrl, REVIEW_END_DATE: config.endDate };
  it('defaults to an offline plan with no credentials needed or displayed', () => {
    const output = JSON.stringify(describePlan(readConfig(env)));
    expect(output).toContain('no HTTP requests');
    expect(output).not.toMatch(/inert-test-fixture|example\.invalid|access_token/);
  });
  it('blocks apply before reading credentials without synthetic-account acknowledgement', () => {
    expect(() => readConfig(env, true)).toThrow('REVIEW_CONFIRM_SYNTHETIC');
  });
  it('blocks a remote apply without both approval and an exact approved origin', () => {
    const remote = { ...env, REVIEW_API_BASE_URL: 'https://review.example.invalid', REVIEW_CONFIRM_SYNTHETIC: 'yes' };
    expect(() => readConfig(remote, true)).toThrow('owner approval');
    expect(() => readConfig({ ...remote, REVIEW_OWNER_APPROVED: 'yes', REVIEW_EXPECTED_ORIGIN: 'https://other.example.invalid' }, true)).toThrow('owner approval');
    expect(() => readConfig({ ...remote, REVIEW_OWNER_APPROVED: 'yes', REVIEW_EXPECTED_ORIGIN: 'https://review.example.invalid' }, true)).toThrow('REVIEW_EXPECTED_COACH_EMAIL');
  });
  it.each(['http://review.example.invalid', 'https://review.example.invalid?token=fixture',
    'https://user:fixture@review.example.invalid', 'https://review.example.invalid/admin'])('rejects unsafe base %s', base => {
    expect(() => readConfig({ ...env, REVIEW_API_BASE_URL: base })).toThrow();
  });
  it('requires a valid sample date rather than silently changing the dataset', () => {
    expect(() => readConfig({ ...env, REVIEW_END_DATE: '2026-02-30' })).toThrow('valid YYYY-MM-DD');
  });
  it('forbids redirects and hides response bodies and network exception details', async () => {
    const forbidden = jest.fn().mockResolvedValue({ ok: false, status: 401, json: () => ({ password: 'do-not-print' }) });
    await expect(httpTransport(config, forbidden)('client', 'POST', '/auth/login', { password: 'do-not-print' })).rejects.toThrow('HTTP 401');
    expect(forbidden.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    const failing = jest.fn().mockRejectedValue(new Error('private-token-from-provider'));
    await expect(httpTransport(config, failing)('client', 'POST', '/auth/login')).rejects.toThrow('could not reach the API');
    try { await httpTransport(config, failing)('client', 'POST', '/auth/login'); } catch (error) {
      expect(String(error)).not.toContain('private-token-from-provider');
    }
  });
});
