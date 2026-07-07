import { NotFoundException } from '@nestjs/common';
import {
  ExtensionPairingFeatureFlagGuard,
  extensionPairingEnabled,
} from '../extension-pair-feature-flag.guard';

describe('ExtensionPairingFeatureFlagGuard', () => {
  let guard: ExtensionPairingFeatureFlagGuard;
  const original = process.env.FEATURE_EXTENSION_PAIRING;

  beforeEach(() => {
    guard = new ExtensionPairingFeatureFlagGuard();
    delete process.env.FEATURE_EXTENSION_PAIRING;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.FEATURE_EXTENSION_PAIRING;
    else process.env.FEATURE_EXTENSION_PAIRING = original;
  });

  it('is OFF by default (env unset) → 404', () => {
    expect(extensionPairingEnabled()).toBe(false);
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });

  it('treats any non-"true" value as off → 404', () => {
    process.env.FEATURE_EXTENSION_PAIRING = '1';
    expect(extensionPairingEnabled()).toBe(false);
    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });

  it('allows the route through only when explicitly "true"', () => {
    process.env.FEATURE_EXTENSION_PAIRING = 'true';
    expect(extensionPairingEnabled()).toBe(true);
    expect(guard.canActivate()).toBe(true);
  });
});
