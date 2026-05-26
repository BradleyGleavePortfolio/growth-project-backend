/**
 * R51 controller tests — coach-facing endpoints.
 *
 * Auth gating (the @Roles decorator + global guards) is exercised by
 * test/roles-enforced.spec.ts in the repo's pattern, so we focus here
 * on shape + dispatch correctness.
 */

import { OnboardingController } from '../src/onboarding/onboarding.controller';

function makeSvcStub() {
  return {
    getStateForCoach: jest.fn().mockResolvedValue({
      id: 's1',
      coach_id: 'coach-1',
      signup_at: new Date('2026-05-20T17:00:00Z'),
      first_client_at: null,
      opted_out_at: null,
      last_milestone: 'shared_link',
      day_1_sent: true,
      day_2_sent: true,
      day_3_sent: false,
      day_5_sent: false,
      day_7_sent: false,
    }),
    detectMilestone: jest.fn().mockResolvedValue('shared_link'),
    optOut: jest.fn().mockResolvedValue({
      id: 's1',
      coach_id: 'coach-1',
      opted_out_at: new Date('2026-05-26T10:00:00Z'),
    }),
    buildShareTemplatesForCoach: jest.fn().mockResolvedValue([
      {
        platform: 'instagram_bio',
        label: 'Instagram bio',
        copy: 'Apply below ↓',
        url: 'https://joingrowthproject.com/v1/packages/public/join/tok_x',
      },
    ]),
  };
}

const req = { user: { id: 'coach-1', role: 'coach' } } as any;

describe('OnboardingController', () => {
  let svc: ReturnType<typeof makeSvcStub>;
  let ctrl: OnboardingController;

  beforeEach(() => {
    svc = makeSvcStub();
    ctrl = new OnboardingController(svc as any);
  });

  describe('GET /onboarding/state', () => {
    it('returns the state snapshot AND a freshly-detected current_milestone', async () => {
      const out = await ctrl.getState(req);
      expect(out.coach_id).toBe('coach-1');
      expect(out.last_milestone_snapshot).toBe('shared_link');
      expect(out.current_milestone).toBe('shared_link');
      expect(out.days_sent.day_1).toBe(true);
      expect(out.days_sent.day_3).toBe(false);
      expect(svc.getStateForCoach).toHaveBeenCalledWith('coach-1');
      expect(svc.detectMilestone).toHaveBeenCalledWith('coach-1');
    });

    it('returns first_client_at when set', async () => {
      svc.getStateForCoach.mockResolvedValueOnce({
        id: 's1',
        coach_id: 'coach-1',
        signup_at: new Date(),
        first_client_at: new Date('2026-05-25T00:00:00Z'),
        opted_out_at: null,
        last_milestone: 'first_client',
        day_1_sent: true,
        day_2_sent: true,
        day_3_sent: true,
        day_5_sent: false,
        day_7_sent: false,
      });
      svc.detectMilestone.mockResolvedValueOnce('first_client');
      const out = await ctrl.getState(req);
      expect(out.first_client_at).toEqual(new Date('2026-05-25T00:00:00Z'));
      expect(out.current_milestone).toBe('first_client');
    });
  });

  describe('POST /onboarding/opt-out', () => {
    it('returns ok + opted_out_at timestamp', async () => {
      const out = await ctrl.optOut(req);
      expect(out.ok).toBe(true);
      expect(out.opted_out_at).toBeInstanceOf(Date);
      expect(svc.optOut).toHaveBeenCalledWith('coach-1');
    });
  });

  describe('GET /share-templates', () => {
    it('returns templates array under `templates` key', async () => {
      const out = await ctrl.shareTemplates(req);
      expect(out.templates).toHaveLength(1);
      expect(out.templates[0].platform).toBe('instagram_bio');
    });

    it('returns empty array when coach has no share_token', async () => {
      svc.buildShareTemplatesForCoach.mockResolvedValueOnce([]);
      const out = await ctrl.shareTemplates(req);
      expect(out.templates).toEqual([]);
    });
  });
});
