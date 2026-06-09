import { isDunningV2Enabled } from '../src/checkout/dunning-v2/dunning-v2.feature';

// R66 gate (flag default OFF): the master switch must default OFF and flip ON
// ONLY for an exact, case-insensitive 'true'. Every other value → OFF.
describe('FEATURE_DUNNING_V2 flag', () => {
  it('defaults OFF when the env var is absent', () => {
    expect(isDunningV2Enabled({})).toBe(false);
  });

  it('is OFF for empty string', () => {
    expect(isDunningV2Enabled({ FEATURE_DUNNING_V2: '' })).toBe(false);
  });

  it.each(['false', '0', 'yes', 'on', 'TRUEISH', '1', 'enabled'])(
    'is OFF for non-"true" value %s',
    (v) => {
      expect(isDunningV2Enabled({ FEATURE_DUNNING_V2: v })).toBe(false);
    },
  );

  it.each(['true', 'TRUE', 'True', 'tRuE'])(
    'is ON for case-insensitive "true" value %s',
    (v) => {
      expect(isDunningV2Enabled({ FEATURE_DUNNING_V2: v })).toBe(true);
    },
  );
});
