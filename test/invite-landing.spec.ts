import { InviteLandingController } from '../src/invite-landing/invite-landing.controller';
import {
  InviteLandingService,
  buildAndroidIntentUrl,
  landingPlatformFromUserAgent,
} from '../src/invite-landing/invite-landing.service';

// Builds a minimal express-like Response double that records what the
// controller sent. Avoids pulling in supertest/booting Nest for what is
// fundamentally a small render-and-status assertion.
function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: string | undefined;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    send(payload: string) {
      body = payload;
      return this;
    },
    json(payload: any) {
      body = JSON.stringify(payload);
      return this;
    },
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  } as any;
}

describe('InviteLandingController', () => {
  let inviteCodesMock: any;
  let landingService: InviteLandingService;
  let controller: InviteLandingController;

  beforeEach(() => {
    inviteCodesMock = {
      previewCode: jest.fn(),
    };
    landingService = new InviteLandingService(inviteCodesMock as any);
    controller = new InviteLandingController(landingService);
  });

  describe('GET /join/:code', () => {
    it('renders a 200 HTML page with coach name + accent for a valid code', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Lara Hayes',
        business_name: 'Atelier Wellness',
        branding: { accent_color: '#7A5C3C', logo_url: 'https://cdn.example.com/l.png' },
      });
      const res = makeRes();
      await controller.joinHtml('GP-A1B2C3', res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toMatch(/text\/html/);
      expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
      // Must surface the coach card data
      expect(res.body).toContain('Lara Hayes');
      expect(res.body).toContain('Atelier Wellness');
      expect(res.body).toContain('GP-A1B2C3');
      // Accent color flows into CSS as a custom property
      expect(res.body).toContain('--accent: #7A5C3C');
      // No user agent: the page asks for a phone and lists both stores.
      expect(res.body).toContain('Open this invite on your phone to join.');
      expect(res.body).toContain('Google Play');
    });

    it('iPhone visitor without the app gets the App Store, not a reload of the same link', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Lara Hayes',
        business_name: null,
        branding: { accent_color: null, logo_url: null },
      });
      const prevStore = process.env.APP_STORE_URL;
      delete process.env.APP_STORE_URL;
      try {
        const res = makeRes();
        await controller.joinHtml(
          'GP-A1B2C3',
          res,
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers['Vary']).toBe('User-Agent');
        // Unset APP_STORE_URL falls back to the live status page, never a dead id0 listing.
        expect(res.body).toContain(
          'class="primary" href="https://app.trygrowthproject.com/download/ios"',
        );
        expect(res.body).not.toContain('id0');
        expect(res.body).not.toContain('href="https://app.trygrowthproject.com/join/GP-A1B2C3"');
      } finally {
        if (prevStore === undefined) delete process.env.APP_STORE_URL;
        else process.env.APP_STORE_URL = prevStore;
      }
    });

    it('Android visitor gets an intent link that opens the app or Google Play', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Lara Hayes',
        business_name: null,
        branding: { accent_color: null, logo_url: null },
      });
      const res = makeRes();
      await controller.joinHtml(
        'GP-A1B2C3',
        res,
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile Safari/537.36',
      );
      expect(res.body).toContain('href="intent://join/GP-A1B2C3#Intent;scheme=tgp;package=');
    });

    it('renders a 404 generic invalid page when the code is unknown', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({ valid: false });
      const res = makeRes();
      await controller.joinHtml('GP-NOPE99', res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain("isn't available");
      // CRITICAL: the invalid page must not echo the (unknown) code back
      // — confirming "this code existed once" is a privacy leak.
      expect(res.body).not.toContain('GP-NOPE99');
    });

    it('renders 404 when the coach is paused/canceled (preview returns invalid)', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({ valid: false });
      const res = makeRes();
      await controller.joinHtml('GP-PAUSED', res);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('GP-PAUSED');
    });

    it('rejects too-short / too-long codes without hitting the database', async () => {
      const res1 = makeRes();
      await controller.joinHtml('a', res1);
      expect(res1.statusCode).toBe(404);

      const longCode = 'x'.repeat(64);
      const res2 = makeRes();
      await controller.joinHtml(longCode, res2);
      expect(res2.statusCode).toBe(404);

      expect(inviteCodesMock.previewCode).not.toHaveBeenCalled();
    });

    it('falls back to a default accent if branding_accent_color is null', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Eve',
        business_name: null,
        branding: { accent_color: null, logo_url: null },
      });
      const res = makeRes();
      await controller.joinHtml('GP-OK1234', res);
      expect(res.body).toContain('--accent: #1F1B16');
      // No <img> when logo_url is null — keeps the layout clean.
      expect(res.body).not.toMatch(/<img class="logo"/);
    });

    it('refuses to inject a javascript: scheme via logo_url', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Eve',
        business_name: null,
        branding: {
          accent_color: null,
          logo_url: 'javascript:alert(1)//',
        },
      });
      const res = makeRes();
      await controller.joinHtml('GP-OK1234', res);
      expect(res.body).not.toContain('javascript:');
    });

    it('ignores a malformed accent_color value (CSS injection guard)', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Eve',
        business_name: null,
        branding: {
          accent_color: 'red; } body { display:none } /*',
          logo_url: null,
        },
      });
      const res = makeRes();
      await controller.joinHtml('GP-OK1234', res);
      expect(res.body).not.toContain('display:none');
      expect(res.body).toContain('--accent: #1F1B16');
    });

    it('escapes HTML in coach_name and business_name', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: '<script>x</script>',
        business_name: '"><img src=x>',
        branding: { accent_color: null, logo_url: null },
      });
      const res = makeRes();
      await controller.joinHtml('GP-OK1234', res);
      expect(res.body).not.toContain('<script>x</script>');
      expect(res.body).toContain('&lt;script&gt;');
      expect(res.body).not.toMatch(/<img src=x>/);
    });
  });

  describe('GET /invite/:code', () => {
    // /invite/:code mirrors /join/:code so QR codes / printed material can
    // use either scheme. The behavior must be byte-identical for the same
    // code so users can't be funneled to a worse experience by URL choice.
    it('returns the same HTML body for /invite/:code as /join/:code', async () => {
      inviteCodesMock.previewCode.mockResolvedValue({
        valid: true,
        coach_id: 'c1',
        coach_name: 'Eve',
        business_name: null,
        branding: { accent_color: null, logo_url: null },
      });
      const res1 = makeRes();
      await controller.joinHtml('GP-OK1234', res1);
      const res2 = makeRes();
      await controller.inviteHtml('GP-OK1234', res2);
      expect(res2.body).toBe(res1.body);
    });
  });
});

describe('InviteLandingService.renderValid', () => {
  // The renderer is reused for both /join and /invite, so its output is the
  // single source of truth for the landing-page button contract. Pin it.
  const inviteCodesMock = { previewCode: jest.fn() } as any;
  const svc = new InviteLandingService(inviteCodesMock);
  const base = {
    code: 'GP-X1Y2Z3',
    coach_name: 'A',
    business_name: null,
    accent_color: null,
    logo_url: null,
    deep_link_url: 'tgp://join/GP-X1Y2Z3',
    app_store_url: 'https://apps.apple.com/app/x',
    play_store_url: 'https://play.google.com/store/apps/details?id=x',
    android_package: 'com.growthproject.app',
  };

  it('never offers the shared link itself as a button (same-domain tap only reloads the page)', () => {
    for (const platform of ['ios', 'android', 'other'] as const) {
      const html = svc.renderValid({ ...base, platform });
      expect(html).not.toContain('href="https://app.tgp.com/join/GP-X1Y2Z3"');
      expect(html).not.toContain('Continue on web');
      expect(html).toContain('GP-X1Y2Z3');
    }
  });

  it('iPhone: the main button is the App Store, with an open-the-app link for installed apps', () => {
    const html = svc.renderValid({ ...base, platform: 'ios' });
    expect(html).toMatch(/class="primary" href="https:\/\/apps\.apple\.com\/app\/x"/);
    expect(html).toContain('href="tgp://join/GP-X1Y2Z3"');
    expect(html).toContain('enter code GP-X1Y2Z3 when you create your account');
  });

  it('Android: the main button opens the app through an intent link that falls back to Google Play', () => {
    const html = svc.renderValid({ ...base, platform: 'android' });
    const fallback = encodeURIComponent(base.play_store_url);
    expect(html).toContain(
      `class="primary" href="intent://join/GP-X1Y2Z3#Intent;scheme=tgp;package=com.growthproject.app;S.browser_fallback_url=${fallback};end"`,
    );
    expect(html).toContain('href="https://play.google.com/store/apps/details?id=x"');
  });

  it('other devices: asks for a phone and lists both stores', () => {
    const html = svc.renderValid({ ...base, platform: 'other' });
    expect(html).not.toContain('class="primary"');
    expect(html).toContain('Open this invite on your phone to join.');
    expect(html).toContain('apps.apple.com');
    expect(html).toContain('play.google.com');
  });
});

describe('landing helpers', () => {
  it('maps user agents to a platform', () => {
    expect(
      landingPlatformFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      ),
    ).toBe('ios');
    expect(
      landingPlatformFromUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile Safari/537.36',
      ),
    ).toBe('android');
    expect(landingPlatformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe(
      'other',
    );
    expect(landingPlatformFromUserAgent(undefined)).toBe('other');
  });

  it('falls back to the app package when the env value is not a package name', () => {
    expect(buildAndroidIntentUrl('GP-1', 'x;S.evil=1', 'https://play.example/x')).toContain(
      'package=com.growthproject.app;',
    );
  });
});
