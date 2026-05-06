// Phase 7C — LeaderboardController unit tests.
//
// Pins:
//   1. Auth gating — controller methods pass req.user.id to the service.
//   2. Opt-in flow — POST /me/leaderboard/opt-in delegates correctly.
//   3. Display name is passed through unmodified.
//   4. GET /me/leaderboard returns the service result unchanged.

import { LeaderboardController } from '../src/leaderboard/leaderboard.controller';
import { LeaderboardService }    from '../src/leaderboard/leaderboard.service';
import { OptInDto }              from '../src/leaderboard/leaderboard.dto';

// ─── Mock service ─────────────────────────────────────────────────────────────

function buildMockService() {
  return {
    getLeaderboard: jest.fn(),
    setOptIn:       jest.fn(),
  } as unknown as LeaderboardService;
}

function authedReq(userId: string) {
  return { user: { id: userId } } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LeaderboardController', () => {
  describe('getLeaderboard', () => {
    it('passes req.user.id to LeaderboardService.getLeaderboard', async () => {
      const svc  = buildMockService();
      const ctrl = new LeaderboardController(svc);
      const fake = { entries: [], selfRank: null };
      (svc.getLeaderboard as jest.Mock).mockResolvedValue(fake);

      const result = await ctrl.getLeaderboard(authedReq('u-123'));

      expect(svc.getLeaderboard).toHaveBeenCalledWith('u-123');
      expect(result).toBe(fake);
    });
  });

  describe('optIn', () => {
    it('calls setOptIn with enabled=true and displayName when provided', async () => {
      const svc  = buildMockService();
      const ctrl = new LeaderboardController(svc);
      (svc.setOptIn as jest.Mock).mockResolvedValue(undefined);

      const dto: OptInDto = { enabled: true, displayName: 'Alex T.' };
      const result = await ctrl.optIn(authedReq('u-456'), dto);

      expect(svc.setOptIn).toHaveBeenCalledWith('u-456', true, 'Alex T.');
      expect(result).toEqual({ success: true, enabled: true });
    });

    it('calls setOptIn with enabled=false and no displayName', async () => {
      const svc  = buildMockService();
      const ctrl = new LeaderboardController(svc);
      (svc.setOptIn as jest.Mock).mockResolvedValue(undefined);

      const dto: OptInDto = { enabled: false };
      const result = await ctrl.optIn(authedReq('u-789'), dto);

      expect(svc.setOptIn).toHaveBeenCalledWith('u-789', false, undefined);
      expect(result).toEqual({ success: true, enabled: false });
    });

    it('returns enabled: true in the response when opting in', async () => {
      const svc  = buildMockService();
      const ctrl = new LeaderboardController(svc);
      (svc.setOptIn as jest.Mock).mockResolvedValue(undefined);

      const dto: OptInDto = { enabled: true };
      const result = await ctrl.optIn(authedReq('u-1'), dto);

      expect(result.enabled).toBe(true);
      expect(result.success).toBe(true);
    });
  });
});
