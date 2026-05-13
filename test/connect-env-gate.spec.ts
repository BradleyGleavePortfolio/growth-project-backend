import { ConnectController } from '../src/connect/connect.controller';
import { ConnectModuleState } from '../src/connect/connect.module-state';

// Env-gate smoke: when ConnectModuleState.ready === false (the boot probe
// failed or STRIPE_SECRET_KEY is unset), every endpoint returns 503 with
// the operator-actionable reason. No fake responses.

function makeReq() {
  return { user: { id: 'coach-1', role: 'coach' } } as any;
}

describe('ConnectController — env gate', () => {
  it('returns 503 when state.ready is false', async () => {
    const state = new ConnectModuleState();
    state.ready = false;
    state.reason =
      'Stripe Connect platform not enabled — visit https://dashboard.stripe.com/connect/overview';
    const ctrl = new ConnectController(state, {} as any);
    await expect(ctrl.createAccount(makeReq(), {})).rejects.toMatchObject({
      status: 503,
    });
    await expect(ctrl.onboardingLink(makeReq())).rejects.toMatchObject({
      status: 503,
    });
    await expect(ctrl.dashboardLink(makeReq())).rejects.toMatchObject({
      status: 503,
    });
    await expect(ctrl.me(makeReq())).rejects.toMatchObject({ status: 503 });
  });

  it('surfaces the boot-probe reason in the 503 body', async () => {
    const state = new ConnectModuleState();
    state.ready = false;
    state.reason = 'STRIPE_SECRET_KEY is unset — Stripe Connect routes are disabled.';
    const ctrl = new ConnectController(state, {} as any);
    try {
      await ctrl.createAccount(makeReq(), {});
      fail('expected 503');
    } catch (err: any) {
      const body = err.response ?? err.getResponse?.();
      expect(body).toMatchObject({
        error: 'CONNECT_NOT_CONFIGURED',
        message: expect.stringContaining('STRIPE_SECRET_KEY is unset'),
      });
    }
  });

  it('delegates to ConnectService when state.ready is true', async () => {
    const state = new ConnectModuleState();
    state.ready = true;
    const svc = {
      createAccountForCoach: jest.fn(async () => ({
        id: 'ca-1',
        coach_user_id: 'coach-1',
        stripe_account_id: 'acct_abc',
        is_fully_onboarded: false,
      })),
      getStatusForCoach: jest.fn(async () => null),
      createOnboardingLink: jest.fn(async () => ({
        url: 'https://connect.stripe.com/setup/c/abc',
        expires_at: 1,
      })),
      createDashboardLoginLink: jest.fn(async () => ({
        url: 'https://connect.stripe.com/express/abc',
      })),
    };
    const ctrl = new ConnectController(state, svc as any);
    const out = await ctrl.createAccount(makeReq(), {});
    expect(out).toMatchObject({ stripe_account_id: 'acct_abc' });
    expect(svc.createAccountForCoach).toHaveBeenCalledWith('coach-1', {
      country: undefined,
      email: undefined,
    });

    const meOut = await ctrl.me(makeReq());
    expect(meOut).toMatchObject({ connected: false });
  });
});
