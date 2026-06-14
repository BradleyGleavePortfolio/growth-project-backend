/**
 * Unit tests for DegradedConnectorFallbackService (v3-4).
 *
 * Pins the PREFLIGHT §2/§4 correction: there is NO `disabled` connector state.
 * A connector is degraded iff its status !== CONNECTED. The gate:
 *   - ok=true only when AT LEAST ONE connection is CONNECTED;
 *   - ok=false with a BOUNDED enum reason otherwise (never a raw DB string),
 *     preference EXPIRED > ERROR > DISCONNECTED, and 'none' when no connector
 *     exists. An unknown/garbage status collapses to DISCONNECTED (fail-explicit);
 *   - emits the fallback telemetry event (counts/ids/bounded-reason only) when
 *     the flag is on, and never when it is off.
 */
import { WearableConnectionStatus } from '../../../wearables/connections/types';
import { DegradedConnectorFallbackService } from '../degraded-connector-fallback.service';
import { COMMUNITY_TELEMETRY_EVENTS } from '../../community-events';

const WS = 'ws-1';
const COACH = 'coach-1';
const CLIENT = 'client-1';

function build(statuses: string[]) {
  const prisma = {
    wearableConnection: {
      findMany: jest.fn().mockResolvedValue(statuses.map((status) => ({ status }))),
    },
  };
  const analytics = { capture: jest.fn() };
  const service = new DegradedConnectorFallbackService(
    prisma as never,
    analytics as never,
  );
  return { service, prisma, analytics };
}

describe('DegradedConnectorFallbackService.gate', () => {
  const ORIGINAL = process.env.FEATURE_COMMUNITY_TELEMETRY;
  afterEach(() => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = ORIGINAL;
    jest.clearAllMocks();
  });

  it('ok=true when at least one connector is CONNECTED', async () => {
    const { service, analytics } = build([
      WearableConnectionStatus.ERROR,
      WearableConnectionStatus.CONNECTED,
    ]);
    const res = await service.gate(WS, COACH, CLIENT);
    expect(res).toEqual({ ok: true, reason: 'none' });
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it('reason none when the client has no connector', async () => {
    const { service } = build([]);
    const res = await service.gate(WS, COACH, CLIENT);
    expect(res).toEqual({ ok: false, reason: 'none' });
  });

  it('prefers EXPIRED over ERROR over DISCONNECTED', async () => {
    const { service } = build([
      WearableConnectionStatus.DISCONNECTED,
      WearableConnectionStatus.ERROR,
      WearableConnectionStatus.EXPIRED,
    ]);
    const res = await service.gate(WS, COACH, CLIENT);
    expect(res).toEqual({ ok: false, reason: WearableConnectionStatus.EXPIRED });
  });

  it('collapses an unknown status to DISCONNECTED (fail-explicit)', async () => {
    const { service } = build(['totally-bogus-status']);
    const res = await service.gate(WS, COACH, CLIENT);
    expect(res).toEqual({
      ok: false,
      reason: WearableConnectionStatus.DISCONNECTED,
    });
  });

  it('emits a bounded fallback telemetry event when the flag is on', async () => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
    const { service, analytics } = build([WearableConnectionStatus.ERROR]);
    await service.gate(WS, COACH, CLIENT);
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    const [actor, event, payload] = analytics.capture.mock.calls[0]!;
    expect(actor).toBe(COACH);
    expect(event).toBe(COMMUNITY_TELEMETRY_EVENTS.wearablePromptFallbackFired);
    expect(payload).toEqual({
      workspace_id: WS,
      client_id: CLIENT,
      reason: WearableConnectionStatus.ERROR,
    });
  });

  it('does NOT emit telemetry when the flag is off', async () => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'false';
    const { service, analytics } = build([WearableConnectionStatus.DISCONNECTED]);
    await service.gate(WS, COACH, CLIENT);
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});
