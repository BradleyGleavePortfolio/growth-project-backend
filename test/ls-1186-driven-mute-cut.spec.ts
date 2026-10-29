import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';

// Equivalent to removing this directly driven sender's Mute all veto.
const stub = <T>(value: unknown): T => value as T;
const gate = stub<{ muteAllStopsNudgePush: (client: string, nudge: string) => Promise<boolean> }>(
  ChurnInterventionService.prototype,
);
jest.spyOn(gate, 'muteAllStopsNudgePush').mockResolvedValue(false);
require('../src/notifications/__tests__/sender-registry.spec');
