// A2 coach code tools — controller: kill switch (default OFF → 404
// coach_code_tools_disabled on every route), guards, and tenancy taken only
// from req.user (never a body or path coach id).
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CoachCodeToolsController } from '../src/invite-codes/coach-code-tools.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';

function build() {
  const tools = {
    list: jest.fn(async () => ({ codes: [] })),
    signups: jest.fn(async () => ({ total: 0 })),
    create: jest.fn(async () => ({ code: {}, replayed: false })),
    rotate: jest.fn(async () => ({ code: {}, previous: null, replayed: false })),
    revoke: jest.fn(async () => ({ code: {}, replayed: false })),
  };
  const toolsDouble: any = tools;
  const controller = new CoachCodeToolsController(toolsDouble);
  const req: any = {
    user: { id: 'coach-a', role: 'coach', email: 'a@example.test' },
    headers: { 'user-agent': 'jest' },
    ip: '10.0.0.1',
  };
  return { tools, controller, req };
}

describe('CoachCodeToolsController', () => {
  const prev = process.env.FEATURE_COACH_CODE_TOOLS;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_COACH_CODE_TOOLS;
    else process.env.FEATURE_COACH_CODE_TOOLS = prev;
  });

  it('is guarded by JwtAuthGuard + CoachGuard at the class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CoachCodeToolsController);
    expect(guards).toEqual([JwtAuthGuard, CoachGuard]);
  });

  it('flag unset: every route answers 404 coach_code_tools_disabled and touches nothing', async () => {
    delete process.env.FEATURE_COACH_CODE_TOOLS;
    const { tools, controller, req } = build();
    const calls = [
      () => controller.list(req),
      () => controller.signups(req, {}),
      () => controller.create(req, {}, 'key-12345678'),
      () => controller.rotate(req, 'ic-1', { grace_hours: 0 }),
      () => controller.revoke(req, 'ic-1'),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        status: 404,
        response: { code: 'coach_code_tools_disabled' },
      });
    }
    for (const fn of Object.values(tools)) expect(fn).not.toHaveBeenCalled();
  });

  it('flag on: tenancy comes from req.user only', async () => {
    process.env.FEATURE_COACH_CODE_TOOLS = 'true';
    const { tools, controller, req } = build();
    await controller.list(req);
    await controller.signups(req, { days: 14 });
    await controller.create(req, { label: 'Clinic' }, 'key-12345678');
    await controller.rotate(req, 'coach-link', { grace_hours: 24, expected_code: 'GP-LNK234' });
    await controller.revoke(req, 'ic-9');
    const actor = { id: 'coach-a', role: 'coach', email: 'a@example.test' };
    const ctx = { ip: '10.0.0.1', userAgent: 'jest' };
    expect(tools.list).toHaveBeenCalledWith('coach-a');
    expect(tools.signups).toHaveBeenCalledWith('coach-a', 14);
    expect(tools.create).toHaveBeenCalledWith(actor, { label: 'Clinic' }, 'key-12345678', ctx);
    expect(tools.rotate).toHaveBeenCalledWith(actor, 'coach-link', 24, ctx, 'GP-LNK234');
    expect(tools.revoke).toHaveBeenCalledWith(actor, 'ic-9', ctx);
  });
});
