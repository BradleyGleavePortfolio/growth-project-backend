/**
 * R2b — wearable AI insights need the client's live box-2 grant.
 *
 * The grant is read BEFORE the insight cache, so an AI insight built from a
 * client's data stops being served the moment they withdraw. Coach callers
 * reach the service only after assertCoachOwnsClient (controller), so the
 * refusal is no cross-tenant oracle. (This spec lives under test/ because
 * src/wearables/insights is not a default jest root.)
 */
import { WearableMetricBucket } from '@prisma/client';
import { WearableInsightsService } from '../../src/wearables/insights/wearable-insights.service';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import { egressWithGrants, fakeOf } from './ai-egress.fakes';

const COACH = 'coach-1111-1111-1111-111111111111';
const CLIENT = 'clnt-2222-2222-2222-222222222222';
const BUCKET = WearableMetricBucket.SLEEP_RECOVERY;

const CACHED_COACH_INSIGHT = {
  observation: 'HRV trended down across five of the last seven nights.',
  hypothesis: 'Accumulated training load alongside shorter sleep windows.',
  suggested_action: 'Pull back tonight session intensity and protect sleep.',
  suggested_message_draft: 'Your recovery has dipped this week. Lets keep tonight light.',
  confidence_level: 'confident',
  source_metrics: ['HRV_MS', 'SLEEP_TOTAL_MIN'],
};

function makeMocks() {
  return {
    prisma: {
      wearableSample: { findMany: jest.fn().mockResolvedValue([]) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Alex Carter', profile: null }),
        findFirst: jest.fn().mockResolvedValue({ id: CLIENT }),
      },
    },
    gateway: {
      invoke: jest.fn().mockResolvedValue({
        reply: JSON.stringify(CACHED_COACH_INSIGHT),
        model: 'claude-sonnet-4.5',
        provider: 'anthropic',
      }),
    },
    cache: {
      get: jest.fn().mockResolvedValue(null),
      getEvenIfStale: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function build(granted: string[]) {
  const mocks = makeMocks();
  const { egress, reader } = egressWithGrants(granted);
  const svc = new WearableInsightsService(
    fakeOf(mocks.prisma),
    fakeOf(mocks.gateway),
    fakeOf(mocks.cache),
    egress,
  );
  return { svc, mocks, reader };
}

describe('WearableInsightsService — R2b box-2 consent', () => {
  it('grant: a cached insight is served', async () => {
    const { svc, mocks } = build([CLIENT]);
    mocks.cache.get.mockResolvedValue(CACHED_COACH_INSIGHT);
    await expect(svc.generateForCoach(COACH, CLIENT, BUCKET)).resolves.toEqual(
      CACHED_COACH_INSIGHT,
    );
  });

  it('grant: a fresh insight is generated through the gateway', async () => {
    const { svc, mocks } = build([CLIENT]);
    await svc.generateForCoach(COACH, CLIENT, BUCKET);
    expect(mocks.gateway.invoke).toHaveBeenCalledTimes(1);
  });

  it('no grant: 403 ai_consent_required; neither the cache nor the model is read', async () => {
    const { svc, mocks } = build([]);
    const err = await svc.generateForCoach(COACH, CLIENT, BUCKET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect((err as AiConsentRequiredException).audience).toBe('coach');
    expect(mocks.cache.get).not.toHaveBeenCalled();
    expect(mocks.gateway.invoke).not.toHaveBeenCalled();
  });

  it('client audience gets the client wording', async () => {
    const { svc } = build([]);
    const err = await svc.generateForClient(CLIENT, BUCKET).catch((e: unknown) => e);
    expect((err as AiConsentRequiredException).audience).toBe('client');
  });

  it('revoked: the previously cached insight is not served after withdrawal', async () => {
    const { svc, mocks, reader } = build([CLIENT]);
    mocks.cache.get.mockResolvedValue(CACHED_COACH_INSIGHT);
    await svc.generateForCoach(COACH, CLIENT, BUCKET);
    reader.revoke(CLIENT);
    await expect(svc.generateForCoach(COACH, CLIENT, BUCKET)).rejects.toBeInstanceOf(
      AiConsentRequiredException,
    );
    expect(mocks.cache.get).toHaveBeenCalledTimes(1);
  });

  it('refusal at send time (gateway) is surfaced, not replaced by stale cache', async () => {
    const { svc, mocks } = build([CLIENT]);
    mocks.cache.getEvenIfStale.mockResolvedValue(CACHED_COACH_INSIGHT);
    mocks.gateway.invoke.mockRejectedValue(new AiConsentRequiredException('coach'));
    await expect(svc.generateForCoach(COACH, CLIENT, BUCKET)).rejects.toBeInstanceOf(
      AiConsentRequiredException,
    );
  });

  it('ledger error: fails closed', async () => {
    const { svc, mocks, reader } = build([CLIENT]);
    reader.failWith = new Error('db down');
    await expect(svc.generateForCoach(COACH, CLIENT, BUCKET)).rejects.toBeInstanceOf(
      AiConsentRequiredException,
    );
    expect(mocks.gateway.invoke).not.toHaveBeenCalled();
  });
});
