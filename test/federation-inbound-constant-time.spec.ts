import * as fs from 'fs';
import * as path from 'path';

// Audit fix Coach #6: pin the constant-time bearer compare so a
// future edit can never regress it back to `===`.
//
// Two assertions:
//   1. The service file imports `crypto` and uses `timingSafeEqual`
//      somewhere on the auth path.
//   2. The Step-2 bearer compare branch references our wrapper
//      (`constantTimeEqual`) rather than the raw `===` operator.
//
// We also keep a behavioural test: a wrong-token request still
// raises `UnauthorizedException`. That property is already pinned by
// the existing federation-inbound.spec.ts (line 93). This file adds
// the source-level guard.

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'admin', 'federation', 'federation-inbound.service.ts'),
  'utf8',
);

describe('FederationInboundService bearer compare', () => {
  it('imports the node crypto module', () => {
    expect(SRC).toMatch(/import \* as crypto from 'crypto'/);
  });

  it('declares a constantTimeEqual helper', () => {
    expect(SRC).toMatch(/function constantTimeEqual\(a: string, b: string\): boolean/);
  });

  it('uses timingSafeEqual inside the helper', () => {
    expect(SRC).toMatch(/crypto\.timingSafeEqual\(bufA, bufB\)/);
  });

  it('uses constantTimeEqual on the Step-2 bearer compare', () => {
    // Dual-secret rotation (PR for FINANCE_SERVICE_TOKEN_NEXT) splits
    // the compare into a primary + next branch — pin BOTH go through
    // constantTimeEqual so neither branch can regress to `===`.
    expect(SRC).toMatch(/constantTimeEqual\(bearerToken, primary\)/);
    expect(SRC).toMatch(/constantTimeEqual\(bearerToken, next\)/);
  });

  it('does not retain the legacy `bearerToken !== configuredToken` compare', () => {
    expect(SRC).not.toMatch(/bearerToken !== configuredToken/);
    expect(SRC).not.toMatch(/bearerToken !== primary/);
    expect(SRC).not.toMatch(/bearerToken !== next/);
  });
});
