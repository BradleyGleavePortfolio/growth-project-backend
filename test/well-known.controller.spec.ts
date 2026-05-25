import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { WellKnownController } from '../src/invite-landing/well-known.controller';

// Audit #3 P1-11 — Apple/Android association docs must NEVER be empty
// in production. assertEnv() already crashes the boot if APPLE_TEAM_ID
// or ANDROID_CERT_SHA256_FINGERPRINTS is missing under prod-like
// NODE_ENV, but the handler also defends in depth: if it somehow runs
// with empty values under prod, it throws 500 rather than teaching the
// OS that no association exists.
//
// Dev/test still serves a syntactically valid stub so contributors
// don't need real signing credentials.

function makeRes() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
}

describe('WellKnownController', () => {
  let controller: WellKnownController;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WellKnownController],
    }).compile();
    controller = module.get(WellKnownController);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('apple-app-site-association', () => {
    it('serves a populated AASA when APPLE_TEAM_ID is set', () => {
      process.env.NODE_ENV = 'production';
      process.env.APPLE_TEAM_ID = 'TEAMID1234';
      process.env.IOS_BUNDLE_ID = 'com.growthproject.app';
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.appleAppSiteAssociation(res as any);
      const body = JSON.parse(res.send.mock.calls[0][0] as string);
      expect(body.applinks.details).toHaveLength(1);
      expect(body.applinks.details[0].appID).toBe(
        'TEAMID1234.com.growthproject.app',
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('P2-1: 404s on non-prod regardless of APPLE_TEAM_ID', () => {
      // AASA is a production-only artifact — no Team ID, bundle ID,
      // or stub doc may be emitted on dev/test.
      process.env.NODE_ENV = 'development';
      delete process.env.APPLE_TEAM_ID;
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.appleAppSiteAssociation(res as any);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.send).toHaveBeenCalled();
    });

    it('P2-1: still 404s on non-prod even when APPLE_TEAM_ID is set', () => {
      // The whole point of P2-1: a prod Team ID accidentally exposed
      // in the dev or test env vars must NOT leak through the AASA
      // endpoint.
      process.env.NODE_ENV = 'development';
      process.env.APPLE_TEAM_ID = 'ABCDE12345';
      process.env.IOS_BUNDLE_ID = 'com.growthproject.app';
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.appleAppSiteAssociation(res as any);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.send).toHaveBeenCalled();
      // send() was called with no body — nothing leaks
      expect(res.send.mock.calls[0][0]).toBeUndefined();
    });

    it('throws 500 in production when APPLE_TEAM_ID is unset (P1-11 belt-and-suspenders)', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.APPLE_TEAM_ID;
      const res = makeRes();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller.appleAppSiteAssociation(res as any),
      ).toThrow(InternalServerErrorException);
    });

    it('throws 500 in staging when APPLE_TEAM_ID is unset', () => {
      process.env.NODE_ENV = 'staging';
      delete process.env.APPLE_TEAM_ID;
      const res = makeRes();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller.appleAppSiteAssociation(res as any),
      ).toThrow(InternalServerErrorException);
    });
  });

  describe('assetlinks.json', () => {
    it('serves a populated assetlinks doc when fingerprints are set', () => {
      process.env.NODE_ENV = 'production';
      process.env.ANDROID_CERT_SHA256_FINGERPRINTS =
        'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
      process.env.ANDROID_PACKAGE_NAME = 'com.growthproject.app';
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.assetLinks(res as any);
      const body = JSON.parse(res.send.mock.calls[0][0] as string);
      expect(body).toHaveLength(1);
      expect(body[0].target.package_name).toBe('com.growthproject.app');
      expect(body[0].target.sha256_cert_fingerprints).toHaveLength(1);
    });

    it('accepts ANDROID_SHA256_FINGERPRINT alias', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ANDROID_CERT_SHA256_FINGERPRINTS;
      process.env.ANDROID_SHA256_FINGERPRINT =
        'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99';
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.assetLinks(res as any);
      const body = JSON.parse(res.send.mock.calls[0][0] as string);
      // Upper-cased canonical form.
      expect(body[0].target.sha256_cert_fingerprints[0]).toMatch(/^AA:BB:/);
    });

    it('serves a stub assetlinks doc in development when fingerprints are unset', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ANDROID_CERT_SHA256_FINGERPRINTS;
      delete process.env.ANDROID_SHA256_FINGERPRINT;
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller.assetLinks(res as any);
      const body = JSON.parse(res.send.mock.calls[0][0] as string);
      expect(body).toEqual([]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('throws 500 in production when fingerprints are unset (P1-11)', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ANDROID_CERT_SHA256_FINGERPRINTS;
      delete process.env.ANDROID_SHA256_FINGERPRINT;
      const res = makeRes();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller.assetLinks(res as any),
      ).toThrow(InternalServerErrorException);
    });
  });
});
