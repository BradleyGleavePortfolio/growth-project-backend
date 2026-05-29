import { AutoMessageAssetResolver } from '../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import {
  AutoMessageBodyMissingError,
  SubCoachOutOfScopeError,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

function makeScope(allowed: boolean, isSub = false, headId: string | null = null) {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () => (isSub ? headId : null)),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0]);
}

function makeMessaging() {
  return {
    sendAsCoach: jest.fn(async () => ({ id: 'msg-001' })),
  } as unknown as ConstructorParameters<typeof AutoMessageAssetResolver>[0];
}

// PR-9 R1 — AutoMessageAssetResolver now depends on PrismaService for the
// DripResolverMarker dedup. Pre-PR-9 unit-test surface only exercises the
// non-drip path (no clientPurchaseId/contentId), so the marker branch is
// never taken — a do-nothing stub is sufficient.
function makePrisma() {
  return {
    dripResolverMarker: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  } as unknown as ConstructorParameters<typeof AutoMessageAssetResolver>[2];
}

describe('AutoMessageAssetResolver', () => {
  it('canHandle only auto_message', () => {
    const r = new AutoMessageAssetResolver(makeMessaging(), makeScope(true), makePrisma());
    expect(r.canHandle('auto_message')).toBe(true);
    expect(r.canHandle('workout_plan')).toBe(false);
    expect(r.canHandle('pdf')).toBe(false);
  });

  it('delegates to MessagingService.sendAsCoach with the ACTING (sub-)coach id so the sender is attributed correctly, plus client + trimmed body from displayCaption', async () => {
    // P2(a) regression: an earlier revision of this resolver passed
    // tenantCoachId (head coach) here, which bypassed sendAsCoach's own
    // Phase-11 sub-coach split and attributed drip messages to the head
    // coach. The fix is to pass the raw acting coachId so sendAsCoach
    // resolves the split internally and writes sender_id correctly.
    const msg = makeMessaging();
    const resolver = new AutoMessageAssetResolver(
      msg,
      makeScope(true, true, 'head-1'),
      makePrisma(),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'sub-1',
      assetId: 'tmpl-x',
      displayCaption: '  Welcome aboard!  ',
    });
    expect(res.materialisedRef).toBe('msg-001');
    expect((msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach).toHaveBeenCalledTimes(1);
    const call = (msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach.mock.calls[0];
    expect(call[0]).toBe('sub-1'); // acting (sub-)coach id, NOT 'head-1'
    expect(call[1]).toBe('c1');
    expect(call[2]).toEqual({ body: 'Welcome aboard!' });
  });

  it('head-coach path: passes the head coach id unchanged (resolve() returns actingCoachId === coachId)', async () => {
    const msg = makeMessaging();
    const resolver = new AutoMessageAssetResolver(msg, makeScope(true, false), makePrisma());
    await resolver.materialise({
      clientId: 'c1',
      coachId: 'head-coach-7',
      assetId: 'tmpl-x',
      displayCaption: 'Hi',
    });
    const call = (msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach.mock.calls[0];
    expect(call[0]).toBe('head-coach-7');
  });

  it('falls back to displayTitle when displayCaption is missing', async () => {
    const msg = makeMessaging();
    const resolver = new AutoMessageAssetResolver(msg, makeScope(true), makePrisma());
    await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'tmpl-x',
      displayTitle: 'Hello world',
    });
    expect((msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach.mock.calls[0][2].body).toBe(
      'Hello world',
    );
  });

  it('throws AutoMessageBodyMissingError when both displayCaption and displayTitle are blank', async () => {
    const msg = makeMessaging();
    const resolver = new AutoMessageAssetResolver(msg, makeScope(true), makePrisma());
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach1',
        assetId: 'tmpl-x',
        displayCaption: '   ',
        displayTitle: '',
      }),
    ).rejects.toThrow(AutoMessageBodyMissingError);
    expect((msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach).not.toHaveBeenCalled();
  });

  it('refuses out-of-scope sub-coaches before sending', async () => {
    const msg = makeMessaging();
    const resolver = new AutoMessageAssetResolver(msg, makeScope(false), makePrisma());
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'sub-1',
        assetId: 'tmpl-x',
        displayCaption: 'hi',
      }),
    ).rejects.toThrow(SubCoachOutOfScopeError);
    expect((msg as unknown as { sendAsCoach: jest.Mock }).sendAsCoach).not.toHaveBeenCalled();
  });
});
