import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CoachOnboardingController } from '../src/coach/coach-onboarding.controller';
import {
  CoachOnboardingService,
  COACH_ONBOARDING_TOTAL_STEPS,
} from '../src/coach/coach-onboarding.service';

// Phase 6D — coach-scoped controller. Verifies that:
//   * the controller passes req.user.id straight through (a coach only ever
//     touches their own row)
//   * each handler delegates to the service
//   * 404 / 409 / 400 from the service surface unchanged

function makeService() {
  // In-memory rows keyed by coach_id, manipulated via the same shape the
  // service exposes. Keeps the test focused on the controller wiring.
  const rows = new Map<string, any>();
  let seq = 0;

  const toDto = (r: any) => ({
    id: r.id,
    coach_id: r.coach_id,
    started_at: r.started_at.toISOString(),
    completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    current_step: r.current_step,
    current_step_name: 'profile',
    total_steps: COACH_ONBOARDING_TOTAL_STEPS,
    step_data: r.step_data ?? {},
    is_complete: r.completed_at != null,
  });

  return {
    _rows: rows,
    startWizard: jest.fn(async (id: string) => {
      let row = rows.get(id);
      if (!row) {
        row = {
          id: `obp-${++seq}`,
          coach_id: id,
          started_at: new Date(),
          completed_at: null,
          current_step: 1,
          step_data: {},
        };
        rows.set(id, row);
      }
      return toDto(row);
    }),
    getProgress: jest.fn(async (id: string) => {
      const row = rows.get(id);
      if (!row) throw new NotFoundException('Onboarding not started');
      return toDto(row);
    }),
    advanceStep: jest.fn(async (id: string, input: any) => {
      const row = rows.get(id);
      if (!row) throw new NotFoundException('Onboarding not started');
      if (row.completed_at) throw new ConflictException();
      if (input.step !== row.current_step && input.step !== row.current_step + 1) {
        throw new BadRequestException();
      }
      row.current_step = Math.min(input.step + 1, COACH_ONBOARDING_TOTAL_STEPS);
      row.step_data = {
        ...(row.step_data ?? {}),
        [String(input.step)]: input.data ?? null,
      };
      return toDto(row);
    }),
    completeWizard: jest.fn(async (id: string) => {
      const row = rows.get(id);
      if (!row) throw new NotFoundException();
      if (!row.completed_at) {
        if (row.current_step < COACH_ONBOARDING_TOTAL_STEPS) {
          throw new BadRequestException();
        }
        row.completed_at = new Date();
      }
      return toDto(row);
    }),
    listAllProgress: jest.fn(),
  } as unknown as CoachOnboardingService & { _rows: Map<string, any> };
}

function makeReq(userId: string) {
  return {
    user: { id: userId, role: 'coach', email: 'x@y.z' },
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

describe('CoachOnboardingController', () => {
  let svc: ReturnType<typeof makeService>;
  let ctrl: CoachOnboardingController;

  beforeEach(() => {
    svc = makeService();
    ctrl = new CoachOnboardingController(svc);
  });

  it('GET /coach/onboarding returns the caller-scoped progress', async () => {
    await ctrl.start(makeReq('coach-A'));
    const got = await ctrl.get(makeReq('coach-A'));
    expect(got.coach_id).toBe('coach-A');
    expect(svc.getProgress).toHaveBeenCalledWith('coach-A');
  });

  it('GET /coach/onboarding 404s when wizard not started', async () => {
    await expect(ctrl.get(makeReq('coach-A'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a coach cannot read another coach’s progress (no path param leaks identity)', async () => {
    await ctrl.start(makeReq('coach-A'));
    // coach-B reading their own row gets 404 — the controller has no way
    // to fetch coach-A's row because it always uses req.user.id. This is
    // the test that guarantees the doctrine.
    await expect(ctrl.get(makeReq('coach-B'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(svc.getProgress).toHaveBeenLastCalledWith('coach-B');
  });

  it('POST /start is idempotent', async () => {
    const a = await ctrl.start(makeReq('coach-A'));
    const b = await ctrl.start(makeReq('coach-A'));
    expect(a.id).toBe(b.id);
  });

  it('POST /steps/:n forwards the body as the step data blob', async () => {
    await ctrl.start(makeReq('coach-A'));
    const after = await ctrl.advance(makeReq('coach-A'), 1, {
      business_name: 'Acme',
    });
    expect(after.current_step).toBe(2);
    expect(svc.advanceStep).toHaveBeenCalledWith('coach-A', {
      step: 1,
      data: { business_name: 'Acme' },
    });
  });

  it('POST /steps/:n surfaces BadRequest on out-of-order jumps', async () => {
    await ctrl.start(makeReq('coach-A'));
    await expect(
      ctrl.advance(makeReq('coach-A'), 4, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST /complete locks the row', async () => {
    await ctrl.start(makeReq('coach-A'));
    for (let i = 1; i <= COACH_ONBOARDING_TOTAL_STEPS; i++) {
      await ctrl.advance(makeReq('coach-A'), i, {});
    }
    const done = await ctrl.complete(makeReq('coach-A'));
    expect(done.is_complete).toBe(true);
    await expect(
      ctrl.advance(makeReq('coach-A'), 1, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
