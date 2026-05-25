// test/coach-brief.controller.spec.ts
//
// P2-2: Coach Brief HTTP surface — guard metadata, role metadata, verb
// mappings, happy-path service delegation, and DTO validation failures.
// The service spec already covers business logic; this spec is the
// boundary contract.

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CoachBriefController } from '../src/coach/brief/coach-brief.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import {
  BriefHistoryQueryDto,
  LogHistoryQueryDto,
  UpdateBriefPreferencesDto,
  UpsertDailyLogDto,
} from '../src/coach/brief/coach-brief.dto';
import type {
  BriefHistoryResponse,
  CoachBriefPreferencesResponse,
  CoachBriefResponse,
  CoachDailyLogResponse,
  EmptyDailyLogResponse,
  LogHistoryResponse,
} from '../src/coach/brief/coach-brief.types';
import type { AuthedRequest } from '../src/auth/auth-request';

// ─── Typed service doubles ─────────────────────────────────────────────

interface BriefServiceShape {
  getOrGenerateTodaysBrief: jest.Mock<Promise<CoachBriefResponse>, [string]>;
  getBriefHistory: jest.Mock<
    Promise<BriefHistoryResponse>,
    [string, number, number]
  >;
  regenerateTodaysBrief: jest.Mock<Promise<CoachBriefResponse>, [string]>;
}

interface LogServiceShape {
  getTodaysLog: jest.Mock<
    Promise<CoachDailyLogResponse | EmptyDailyLogResponse>,
    [string]
  >;
  upsertTodaysLog: jest.Mock<
    Promise<CoachDailyLogResponse>,
    [string, string]
  >;
  getLogHistory: jest.Mock<
    Promise<LogHistoryResponse>,
    [string, number, number]
  >;
}

interface PrefsServiceShape {
  getOrDefault: jest.Mock<
    Promise<CoachBriefPreferencesResponse>,
    [string]
  >;
  upsert: jest.Mock<
    Promise<CoachBriefPreferencesResponse>,
    [string, UpdateBriefPreferencesDto]
  >;
}

function makeBriefResponse(): CoachBriefResponse {
  return {
    id: 'brief-1',
    coach_id: 'coach-1',
    brief_date: '2026-05-25',
    status: 'generated',
    brief_mode: 'solo_coach',
    generated_at: new Date('2026-05-25T07:00:00Z').toISOString(),
    summary: null,
    created_at: new Date('2026-05-25T06:59:50Z').toISOString(),
  };
}

function makePrefsResponse(): CoachBriefPreferencesResponse {
  return {
    coach_id: 'coach-1',
    notification_time: '07:00',
    timezone: 'America/Los_Angeles',
    enabled: true,
    created_at: new Date('2026-05-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-05-25T00:00:00Z').toISOString(),
  };
}

function makeLogResponse(): CoachDailyLogResponse {
  return {
    id: 'log-1',
    coach_id: 'coach-1',
    log_date: '2026-05-25',
    content: 'good day',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeAuthedRequest(): AuthedRequest {
  return {
    user: { id: 'coach-1', role: 'coach' },
  } as AuthedRequest;
}

function makeController(overrides: {
  brief?: Partial<BriefServiceShape>;
  log?: Partial<LogServiceShape>;
  prefs?: Partial<PrefsServiceShape>;
} = {}): {
  controller: CoachBriefController;
  brief: BriefServiceShape;
  log: LogServiceShape;
  prefs: PrefsServiceShape;
} {
  const brief: BriefServiceShape = {
    getOrGenerateTodaysBrief: jest.fn().mockResolvedValue(makeBriefResponse()),
    getBriefHistory: jest.fn().mockResolvedValue({
      items: [makeBriefResponse()],
      total: 1,
      page: 1,
      limit: 10,
    }),
    regenerateTodaysBrief: jest.fn().mockResolvedValue(makeBriefResponse()),
    ...overrides.brief,
  };
  const log: LogServiceShape = {
    getTodaysLog: jest.fn().mockResolvedValue(makeLogResponse()),
    upsertTodaysLog: jest.fn().mockResolvedValue(makeLogResponse()),
    getLogHistory: jest.fn().mockResolvedValue({
      items: [makeLogResponse()],
      total: 1,
      page: 1,
      limit: 10,
    }),
    ...overrides.log,
  };
  const prefs: PrefsServiceShape = {
    getOrDefault: jest.fn().mockResolvedValue(makePrefsResponse()),
    upsert: jest.fn().mockResolvedValue(makePrefsResponse()),
    ...overrides.prefs,
  };
  const controller = new CoachBriefController(
    brief as never,
    log as never,
    prefs as never,
  );
  return { controller, brief, log, prefs };
}

// ─── Class-level metadata ──────────────────────────────────────────────

describe('CoachBriefController — class metadata', () => {
  it('mounts on /coach/brief', () => {
    const path = Reflect.getMetadata(PATH_METADATA, CoachBriefController);
    expect(path).toBe('coach/brief');
  });

  it('declares JwtAuthGuard + CoachGuard at the class level', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CoachBriefController,
    ) as unknown as Array<new (...args: unknown[]) => unknown>;
    expect(Array.isArray(guards)).toBe(true);
    const names = guards.map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(['JwtAuthGuard', 'CoachGuard']));
    // Reference the imported guard classes so the symbol use is real.
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(CoachGuard);
  });

  it("declares @Roles('coach') at the class level (P2-5)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, CoachBriefController);
    expect(roles).toEqual(['coach']);
  });
});

// ─── Per-endpoint verb + path metadata ─────────────────────────────────

describe('CoachBriefController — endpoint verb + path mappings', () => {
  const cases: Array<{
    method: keyof CoachBriefController;
    path: string;
    requestMethod: RequestMethod;
  }> = [
    {
      method: 'getTodaysBrief',
      path: 'today',
      requestMethod: RequestMethod.GET,
    },
    {
      method: 'getHistory',
      path: 'history',
      requestMethod: RequestMethod.GET,
    },
    {
      method: 'regenerate',
      path: 'regenerate',
      requestMethod: RequestMethod.POST,
    },
    {
      method: 'getTodaysLog',
      path: 'log/today',
      requestMethod: RequestMethod.GET,
    },
    {
      method: 'upsertTodaysLog',
      path: 'log/today',
      requestMethod: RequestMethod.PUT,
    },
    {
      method: 'getLogHistory',
      path: 'log/history',
      requestMethod: RequestMethod.GET,
    },
    {
      method: 'getPreferences',
      path: 'preferences',
      requestMethod: RequestMethod.GET,
    },
    {
      method: 'updatePreferences',
      path: 'preferences',
      requestMethod: RequestMethod.PUT,
    },
  ];

  for (const c of cases) {
    it(`${String(c.method)} → ${RequestMethod[c.requestMethod]} ${c.path}`, () => {
      const proto = CoachBriefController.prototype as unknown as Record<
        string,
        unknown
      >;
      const handler = proto[c.method as string] as unknown;
      const path = Reflect.getMetadata(PATH_METADATA, handler as object);
      const requestMethod = Reflect.getMetadata(
        METHOD_METADATA,
        handler as object,
      );
      expect(path).toBe(c.path);
      expect(requestMethod).toBe(c.requestMethod);
    });
  }

  it('regenerate is wired @HttpCode(200)', () => {
    const proto = CoachBriefController.prototype as unknown as Record<
      string,
      unknown
    >;
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      proto.regenerate as object,
    );
    expect(httpCode).toBe(200);
  });
});

// ─── Happy-path service delegation ─────────────────────────────────────

describe('CoachBriefController — happy paths', () => {
  it('GET today delegates to briefService with req.user.id', async () => {
    const { controller, brief } = makeController();
    const res = await controller.getTodaysBrief(makeAuthedRequest());
    expect(brief.getOrGenerateTodaysBrief).toHaveBeenCalledWith('coach-1');
    expect(res.id).toBe('brief-1');
  });

  it('GET history forwards page/limit defaults when query omitted', async () => {
    const { controller, brief } = makeController();
    const dto = await plainToInstance(BriefHistoryQueryDto, {});
    const res = await controller.getHistory(makeAuthedRequest(), dto);
    expect(brief.getBriefHistory).toHaveBeenCalledWith('coach-1', 1, 10);
    expect(res.total).toBe(1);
  });

  it('GET history honours supplied page/limit', async () => {
    const { controller, brief } = makeController();
    const dto = plainToInstance(BriefHistoryQueryDto, { page: 3, limit: 5 });
    await controller.getHistory(makeAuthedRequest(), dto);
    expect(brief.getBriefHistory).toHaveBeenCalledWith('coach-1', 3, 5);
  });

  it('POST regenerate delegates to briefService.regenerateTodaysBrief', async () => {
    const { controller, brief } = makeController();
    await controller.regenerate(makeAuthedRequest());
    expect(brief.regenerateTodaysBrief).toHaveBeenCalledWith('coach-1');
  });

  it('GET log/today delegates to logService.getTodaysLog', async () => {
    const { controller, log } = makeController();
    const res = await controller.getTodaysLog(makeAuthedRequest());
    expect(log.getTodaysLog).toHaveBeenCalledWith('coach-1');
    expect(res).toBeDefined();
  });

  it('PUT log/today forwards the body content to upsertTodaysLog', async () => {
    const { controller, log } = makeController();
    const body = plainToInstance(UpsertDailyLogDto, { content: 'great day' });
    const res = await controller.upsertTodaysLog(makeAuthedRequest(), body);
    expect(log.upsertTodaysLog).toHaveBeenCalledWith('coach-1', 'great day');
    expect(res.content).toBe('good day');
  });

  it('GET log/history applies default pagination', async () => {
    const { controller, log } = makeController();
    const dto = plainToInstance(LogHistoryQueryDto, {});
    await controller.getLogHistory(makeAuthedRequest(), dto);
    expect(log.getLogHistory).toHaveBeenCalledWith('coach-1', 1, 10);
  });

  it('GET preferences delegates to prefsService.getOrDefault', async () => {
    const { controller, prefs } = makeController();
    const res = await controller.getPreferences(makeAuthedRequest());
    expect(prefs.getOrDefault).toHaveBeenCalledWith('coach-1');
    expect(res.notification_time).toBe('07:00');
  });

  it('PUT preferences delegates to prefsService.upsert with the validated DTO', async () => {
    const { controller, prefs } = makeController();
    const body = plainToInstance(UpdateBriefPreferencesDto, {
      notification_time: '08:30',
      timezone: 'America/Los_Angeles',
      enabled: false,
    });
    await controller.updatePreferences(makeAuthedRequest(), body);
    expect(prefs.upsert).toHaveBeenCalledWith('coach-1', body);
  });
});

// ─── DTO validation failures ───────────────────────────────────────────

describe('CoachBriefController DTOs — validation failure paths', () => {
  it('BriefHistoryQueryDto rejects limit > 30', async () => {
    const dto = plainToInstance(BriefHistoryQueryDto, { page: 1, limit: 999 });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors.map((e) => e.property)).toContain('limit');
  });

  it('LogHistoryQueryDto rejects page < 1', async () => {
    const dto = plainToInstance(LogHistoryQueryDto, { page: 0, limit: 10 });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors.map((e) => e.property)).toContain('page');
  });

  it('UpsertDailyLogDto rejects content over 4000 chars', async () => {
    const dto = plainToInstance(UpsertDailyLogDto, {
      content: 'x'.repeat(4001),
    });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors.map((e) => e.property)).toContain('content');
  });

  it('UpsertDailyLogDto rejects missing content', async () => {
    const dto = plainToInstance(UpsertDailyLogDto, {});
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
  });

  it('UpdateBriefPreferencesDto rejects notification_time not matching HH:MM', async () => {
    const dto = plainToInstance(UpdateBriefPreferencesDto, {
      notification_time: '7am',
    });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors.map((e) => e.property)).toContain('notification_time');
  });

  it('UpdateBriefPreferencesDto rejects invalid IANA timezone', async () => {
    const dto = plainToInstance(UpdateBriefPreferencesDto, {
      timezone: 'Mars/Olympus_Mons',
    });
    const errors = await validate(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors.map((e) => e.property)).toContain('timezone');
  });

  it('UpdateBriefPreferencesDto accepts valid optional fields', async () => {
    const dto = plainToInstance(UpdateBriefPreferencesDto, {
      notification_time: '08:00',
      timezone: 'America/New_York',
      enabled: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
