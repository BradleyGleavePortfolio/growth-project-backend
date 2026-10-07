// B-DIGEST-127 — digest emails carry links that work.
//
// Fails on main: the coach digest CTA went to https://console.thegrowthproject.app
// and the client CTA to https://app.thegrowthproject.app (hosts that do not
// exist), both unsubscribe links went to <host>/settings/notifications (no
// such route), no List-Unsubscribe header was sent, there was no
// unsubscribe route at all, and the seeded contracts system coach got a
// coach digest every night.

import { INestApplication, Provider, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import {
  DIGEST_OPEN_APP_URL,
  UnsubscribeKeyMissingError,
  digestLinksFor,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/notifications/digest-links';
import { DigestService } from '../src/notifications/digest.service';
import { DigestUnsubscribeController } from '../src/notifications/digest-unsubscribe.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { PublicPagesController } from '../src/public-pages/public-pages.controller';

const SECRET = 'r'.repeat(48);
const ENV = { RECENT_AUTH_SECRET: SECRET };
// The service and the controller read the secret from the process env, as
// production does (Fly secrets); every test below runs with this one.
const ORIGINAL_SECRET = process.env.RECENT_AUTH_SECRET;
beforeEach(() => {
  process.env.RECENT_AUTH_SECRET = SECRET;
});
afterAll(() => {
  process.env.RECENT_AUTH_SECRET = ORIGINAL_SECRET;
});
const NOW = new Date('2026-10-07T16:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** The characters outside `<...>` tags: the copy a reader sees (plus any inline CSS). */
function textOutsideTags(html: string): string {
  return html
    .split('<')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join(' ');
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&#x3D;/g, '='));
}

describe('unsubscribe token', () => {
  it('round-trips user and kind, and expires after 60 days', () => {
    const t = signUnsubscribeToken('user-1', 'digest', NOW, ENV);
    expect(verifyUnsubscribeToken(t, NOW, ENV)).toEqual({ ok: true, userId: 'user-1', kind: 'digest' });
    expect(verifyUnsubscribeToken(t, new Date(NOW.getTime() + 59 * DAY_MS), ENV).ok).toBe(true);
    expect(verifyUnsubscribeToken(t, new Date(NOW.getTime() + 61 * DAY_MS), ENV)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a token edited to name another user or kind, or signed with another secret', () => {
    const t = signUnsubscribeToken('user-1', 'digest', NOW, ENV);
    const parts = t.split('.');
    const otherUser = [parts[0], Buffer.from('user-2').toString('base64url'), ...parts.slice(2)].join('.');
    const otherKind = [...parts.slice(0, 2), 'billing', ...parts.slice(3)].join('.');
    const longer = [...parts.slice(0, 3), String(Number(parts[3]) + 1e6), parts[4]].join('.');
    for (const bad of [otherUser, otherKind, longer, `${t}x`, 'user-1', '', undefined]) {
      expect(verifyUnsubscribeToken(bad, NOW, ENV)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(verifyUnsubscribeToken(t, NOW, { RECENT_AUTH_SECRET: 's'.repeat(48) }).ok).toBe(false);
  });

  it('is never minted without a usable server secret', () => {
    expect(() => signUnsubscribeToken('user-1', 'digest', NOW, {})).toThrow(UnsubscribeKeyMissingError);
    expect(verifyUnsubscribeToken('v1.a.digest.1.x', NOW, {}).ok).toBe(false);
  });
});

describe('DigestService links and headers (all four templates)', () => {
  let fetchMock: jest.SpyInstance;
  afterEach(() => jest.restoreAllMocks());

  function service(env: Record<string, string>) {
    const notifications = Object.create(NotificationsService.prototype);
    const calls = { sent: 0, failed: [] as string[] };
    Object.defineProperty(notifications, 'claimDigestWindow', { value: async () => 'log-1' });
    Object.defineProperty(notifications, 'markDigestSent', { value: async () => { calls.sent += 1; } });
    Object.defineProperty(notifications, 'markDigestFailed', {
      value: async (_id: string, failure: string) => { calls.failed.push(failure); },
    });
    Object.defineProperty(notifications, 'createNotification', { value: async () => ({}) });
    const svc = new DigestService(Object.create(PrismaService.prototype), notifications, new ConfigService(env));
    Object.defineProperty(svc, '_buildClientDigestData', {
      value: async () => ({ date: '7 October 2026', checkins: [], weekStats: { consistencyPct: 0 }, streaks: {} }),
    });
    Object.defineProperty(svc, '_buildCoachDigestData', {
      value: async () => ({ date: '7 October 2026', rosterStats: { needingReview: 0 }, needingAttention: [] }),
    });
    return { svc, calls };
  }

  const LIVE = {
    EMAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM_ADDRESS: 'The Growth Project <noreply@growthprojectapp.com>',
    APP_URL: 'https://app.thegrowthproject.app',
    CONSOLE_URL: 'https://console.thegrowthproject.app',
  };

  const cases: Array<['client' | 'coach', 'daily' | 'weekly']> = [
    ['client', 'daily'],
    ['client', 'weekly'],
    ['coach', 'daily'],
    ['coach', 'weekly'],
  ];

  it.each(cases)('%s %s: CTA opens /open, unsubscribe is a signed /email/unsubscribe link, one-click headers set', async (role, type) => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"id":"m"}', { status: 200 }));
    const { svc, calls } = service(LIVE);
    const user = { id: `${role}-1`, email: `${role}@example.com`, name: 'Sam Lee' };
    if (role === 'client') await svc['_sendClientDigest'](user, `${role}_${type}`, '2026-10-07', type);
    else await svc['_sendCoachDigest'](user, `${role}_${type}`, '2026-10-07', type);

    expect(calls.failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const links = hrefs(body.html);
    expect(links).toHaveLength(2);
    expect(links[0]).toBe(DIGEST_OPEN_APP_URL);
    expect(links[1]).toMatch(/^https:\/\/app\.trygrowthproject\.com\/email\/unsubscribe\?t=/);
    const token = decodeURIComponent(new URL(links[1]).searchParams.get('t') ?? '');
    expect(verifyUnsubscribeToken(token, new Date(), ENV)).toEqual({ ok: true, userId: user.id, kind: 'digest' });
    expect(body.html).not.toMatch(/thegrowthproject\.app|settings\/notifications|coach console/i);
    expect(textOutsideTags(body.html)).not.toContain('!');
    expect(body.headers).toEqual({
      'List-Unsubscribe': `<${links[1]}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('sends nothing (row marked failed) when no unsubscribe link can be signed', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    process.env.RECENT_AUTH_SECRET = '';
    const { svc, calls } = service(LIVE);
    await svc['_sendCoachDigest']({ id: 'c1', email: 'c@example.com', name: 'C' }, 'coach_daily', '2026-10-07', 'daily');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.sent).toBe(0);
    expect(calls.failed).toHaveLength(1);
  });

  it('digestLinksFor builds the same two links for every recipient host', () => {
    const l = digestLinksFor('u-9', NOW, ENV);
    expect(l.openAppUrl).toBe('https://app.trygrowthproject.com/open');
    expect(l.unsubscribeUrl.startsWith('https://app.trygrowthproject.com/email/unsubscribe?t=v1.')).toBe(true);
  });
});

describe('DigestService skips system accounts', () => {
  it.each(['_activeCoachesWithEmailDigest', '_activeClientsWithEmailDigest'] as const)(
    '%s excludes the platform-waiver owner (seeded contracts system coach)',
    async (method) => {
      const prisma = Object.create(PrismaService.prototype);
      const findMany = jest.fn().mockResolvedValue([]);
      Object.defineProperty(prisma, 'user', { value: { findMany } });
      const svc = new DigestService(prisma, Object.create(NotificationsService.prototype), new ConfigService({}));
      if (method === '_activeCoachesWithEmailDigest') await svc['_activeCoachesWithEmailDigest']();
      else await svc['_activeClientsWithEmailDigest']();
      expect(findMany.mock.calls[0][0].where).toMatchObject({
        contract_templates: { none: { is_platform: true } },
      });
    },
  );
});

async function serve(
  controller: Type<unknown>,
  providers: Provider[] = [],
): Promise<{ app: INestApplication; base: string }> {
  const mod = await Test.createTestingModule({ controllers: [controller], providers }).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base };
}

describe('public routes behind the digest links', () => {
  let app: INestApplication | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('GET /open is a static page that opens the app', async () => {
    const served = await serve(PublicPagesController);
    app = served.app;
    const res = await fetch(`${served.base}/open`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('href="tgp://"');
    expect(body).toContain('href="/download/ios"');
    expect(body).toContain('href="/download/android"');
    expect(textOutsideTags(body)).not.toContain('!');
  });

  describe('/email/unsubscribe', () => {
    const updatePreferences = jest.fn().mockResolvedValue({});
    let base = '';
    beforeEach(async () => {
      updatePreferences.mockClear();
      const served = await serve(DigestUnsubscribeController, [
        { provide: NotificationsService, useValue: { updatePreferences } },
      ]);
      app = served.app;
      base = served.base;
    });
    const url = (t: string) => `${base}/email/unsubscribe?t=${encodeURIComponent(t)}`;

    it('GET confirms without changing anything; the button POSTs back with the token', async () => {
      const t = signUnsubscribeToken('user-1', 'digest', new Date(), ENV);
      const res = await fetch(url(t));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(body).toContain('<form method="post" action="/email/unsubscribe?t=');
      expect(body).toContain('Turn off summary emails');
      expect(updatePreferences).not.toHaveBeenCalled();
      expect(textOutsideTags(body)).not.toContain('!');
    });

    it('one-click POST (RFC 8058 body) turns that user\'s digest_email off', async () => {
      const t = signUnsubscribeToken('user-1', 'digest', new Date(), ENV);
      const res = await fetch(url(t), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Summary emails are off');
      expect(updatePreferences).toHaveBeenCalledTimes(1);
      expect(updatePreferences.mock.calls[0][0]).toBe('user-1');
      expect(updatePreferences.mock.calls[0][1]).toEqual({ digest_email: false });
    });

    it('a forged, edited or expired token changes nothing', async () => {
      const good = signUnsubscribeToken('user-1', 'digest', new Date(), ENV);
      const parts = good.split('.');
      const forged = [parts[0], Buffer.from('user-2').toString('base64url'), ...parts.slice(2)].join('.');
      const expired = signUnsubscribeToken('user-1', 'digest', new Date(Date.now() - 61 * DAY_MS), ENV);
      for (const t of [forged, expired, 'nonsense']) {
        const res = await fetch(url(t), { method: 'POST' });
        expect(res.status).toBe(400);
      }
      const get = await fetch(url(expired));
      expect(get.status).toBe(400);
      expect(await get.text()).toContain('This link has expired');
      expect(updatePreferences).not.toHaveBeenCalled();
    });
  });

  it('both routes are mounted outside the /api prefix (bare paths on the public host)', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain("'open',");
    expect(main).toContain("'email/unsubscribe',");
  });
});
