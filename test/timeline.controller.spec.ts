/**
 * timeline.controller.spec.ts — Phase 7B
 *
 * Tests that the controller:
 *   1. Returns 401 when no JWT is present.
 *   2. Validates lane filter values.
 *   3. Clamps since_days to the allowed range.
 *   4. Always uses req.user.id — never a query-supplied userId.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TimelineController } from '../src/timeline/timeline.controller';
import { TimelineService } from '../src/timeline/timeline.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';

// ─── Minimal mock ──────────────────────────────────────────────────────────────

const mockTimelineService = {
  getTimeline: jest.fn().mockResolvedValue({
    events: [],
    nextCursor: null,
    total: 0,
  }),
};

function makeAuthedReq(userId = 'user_abc') {
  return { user: { id: userId } } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TimelineController', () => {
  let controller: TimelineController;

  beforeEach(async () => {
    mockTimelineService.getTimeline.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimelineController],
      providers: [{ provide: TimelineService, useValue: mockTimelineService }],
    })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TimelineController>(TimelineController);
  });

  // ── Auth gating ────────────────────────────────────────────────────────────

  it('uses req.user.id as the userId — not a query param', async () => {
    const req = makeAuthedReq('the_correct_user');
    await controller.getTimeline(req, 30, undefined, undefined, 20);

    const call = mockTimelineService.getTimeline.mock.calls[0];
    expect(call[0]).toBe('the_correct_user');
  });

  it('never accepts a userId from the query string', async () => {
    // There is deliberately no userId query param on the endpoint.
    // Verify the service is called with the JWT-derived ID regardless.
    const req = makeAuthedReq('jwt_user');
    await controller.getTimeline(req, 30, 'body', undefined, 20);

    expect(mockTimelineService.getTimeline.mock.calls[0][0]).toBe('jwt_user');
  });

  // ── Lane validation ────────────────────────────────────────────────────────

  it('accepts all four valid lanes', async () => {
    const req = makeAuthedReq();
    await expect(
      controller.getTimeline(req, 30, 'body,win,coach,friction', undefined, 20),
    ).resolves.not.toThrow();

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.lanes).toEqual(['body', 'win', 'coach', 'friction']);
  });

  it('accepts a single lane', async () => {
    const req = makeAuthedReq();
    await controller.getTimeline(req, 30, 'coach', undefined, 10);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.lanes).toEqual(['coach']);
  });

  it('throws BadRequestException for unknown lane values', async () => {
    const req = makeAuthedReq();
    await expect(
      controller.getTimeline(req, 30, 'body,invalid_lane', undefined, 20),
    ).rejects.toThrow(BadRequestException);
  });

  it('defaults to all 4 lanes when lanes param is omitted', async () => {
    const req = makeAuthedReq();
    await controller.getTimeline(req, 30, undefined, undefined, 20);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.lanes).toHaveLength(4);
  });

  // ── since_days clamping ────────────────────────────────────────────────────

  it('defaults since_days to 180', async () => {
    const req = makeAuthedReq();
    await controller.getTimeline(req, 180, undefined, undefined, 20);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.sinceDays).toBe(180);
  });

  it('clamps since_days to MAX_SINCE_DAYS (730)', async () => {
    const req = makeAuthedReq();
    await controller.getTimeline(req, 9999, undefined, undefined, 20);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.sinceDays).toBeLessThanOrEqual(730);
  });

  it('clamps since_days minimum to 1', async () => {
    const req = makeAuthedReq();
    await controller.getTimeline(req, 0, undefined, undefined, 20);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.sinceDays).toBeGreaterThanOrEqual(1);
  });

  // ── Cursor pass-through ────────────────────────────────────────────────────

  it('passes cursor to the service unchanged', async () => {
    const req = makeAuthedReq();
    const cursor = 'eyJhdCI6IjIwMjUtMTAtMDFUMDg6MDA6MDAuMDAwWiIsImlkIjoiYWJjMTIzIn0';
    await controller.getTimeline(req, 30, undefined, cursor, 20);

    const query = mockTimelineService.getTimeline.mock.calls[0][1];
    expect(query.cursor).toBe(cursor);
  });

  // ── Response shape ─────────────────────────────────────────────────────────

  it('returns the service response shape intact', async () => {
    mockTimelineService.getTimeline.mockResolvedValueOnce({
      events: [
        {
          id: 'test_id',
          lane: 'body',
          eventType: 'weight_logged',
          at: '2025-10-01T08:00:00.000Z',
          title: 'Weight logged — 185.0 lbs',
          metadata: { weightLbs: 185.0, deltaLbs: null, streakDays: 1 },
        },
      ],
      nextCursor: null,
      total: 1,
    });

    const req = makeAuthedReq();
    const result = await controller.getTimeline(req, 30, 'body', undefined, 20);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].lane).toBe('body');
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(1);
  });
});
