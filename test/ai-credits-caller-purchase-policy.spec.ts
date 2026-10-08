/**
 * CREDIT-PAY-131 (CREDIT-REFILL-130 B3): the coach "AI credits used up" copy
 * names a credit pack only when the calling build sells packs (the app's
 * X-Client-Purchase-Policy and X-Client-Platform headers); otherwise it gives
 * the date the pool renews. Failing-first: on main this module does not exist
 * and every coach is told to add a credit pack, even where none is sold.
 */
import { Controller, Get, HttpException, HttpStatus, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  CallerPurchasePolicyInterceptor,
  creditPacksSoldInCallerApp,
  poolRenewsSentence,
  readCallerPurchaseHeaders,
} from '../src/ai-credits/client-purchase-policy';
import {
  ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH,
  romanCoachPoolEmptyMessage,
} from '../src/roman/roman.constants';
import { AI_GUIDE_POOL_EMPTY_REPLY_COACH, aiGuidePoolEmptyReplyCoach } from '../src/ai/ai.service';

const FIRST_PERSON = /\b(I|me|my|we|our|us)\b/;
const US_LINK = { 'X-Client-Purchase-Policy': 'p2p-and-ai-credits', 'X-Client-Platform': 'ios' };

describe('which builds sell credit packs', () => {
  it.each([
    ['p2p-and-ai-credits', 'ios', true], // iOS US-link build: Stripe Checkout in Safari
    ['all', 'ios', true], // development builds with the in-app checkout
    ['all', 'android', false], // Android release sends 'all' but hides packs
    ['p2p-only', 'ios', false], // iOS store build without the US link
    [null, null, false], // web, server jobs, builds that send no header
  ])('policy %s from %s -> %s', (policy, platform, sold) => {
    expect(creditPacksSoldInCallerApp({ policy, platform })).toBe(sold);
  });

  it('outside a request no pack is named', () => {
    expect(creditPacksSoldInCallerApp()).toBe(false);
  });

  it('reads the header values trimmed and lower-cased; an empty value counts as none', () => {
    expect(
      readCallerPurchaseHeaders({
        'x-client-purchase-policy': ' P2P-and-AI-Credits ',
        'x-client-platform': ['iOS'],
      }),
    ).toEqual({ policy: 'p2p-and-ai-credits', platform: 'ios' });
    expect(readCallerPurchaseHeaders({ 'x-client-purchase-policy': '' })).toEqual({
      policy: null,
      platform: null,
    });
    expect(readCallerPurchaseHeaders(undefined)).toEqual({ policy: null, platform: null });
  });
});

describe('the renewal sentence', () => {
  it('names the first day of the next period (UTC)', () => {
    expect(poolRenewsSentence(new Date('2026-11-01T00:00:00.000Z'))).toBe('They renew on November 1.');
    expect(poolRenewsSentence('2027-01-01T00:00:00.000Z')).toBe('They renew on January 1.');
  });

  it('uses plain words when the date is missing or unreadable', () => {
    expect(poolRenewsSentence(null)).toBe('They renew when the next monthly period starts.');
    expect(poolRenewsSentence('not a date')).toBe('They renew when the next monthly period starts.');
  });
});

describe('coach copy when the pool is used up', () => {
  const renews = 'They renew on November 1.';
  it.each([
    ['Roman', romanCoachPoolEmptyMessage, ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH],
    ['AI guidance', aiGuidePoolEmptyReplyCoach, AI_GUIDE_POOL_EMPTY_REPLY_COACH],
  ])('%s: a pack only where one is sold, otherwise the renewal date', (_name, copy, packCopy) => {
    expect(copy(true, renews)).toBe(packCopy);
    expect(packCopy).toContain('Add a credit pack');
    const noPack = copy(false, renews);
    expect(noPack).toContain(renews);
    expect(noPack).not.toMatch(/credit pack|buy|top up/i);
    for (const text of [packCopy, noPack]) {
      expect(text).not.toMatch(FIRST_PERSON);
      expect(text).not.toContain('!');
    }
  });
});

@Controller('cp131')
class ProbeController {
  @Get('sold')
  async sold(): Promise<{ sold: boolean }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { sold: creditPacksSoldInCallerApp() };
  }

  @Get('refuse')
  async refuse(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new HttpException(
      {
        code: 'COACH_AI_BUDGET_EXHAUSTED',
        message: romanCoachPoolEmptyMessage(
          creditPacksSoldInCallerApp(),
          poolRenewsSentence('2026-11-01T00:00:00.000Z'),
        ),
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

describe('a real Nest app keeps the headers in scope for the whole handler', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: CallerPurchasePolicyInterceptor }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, baseUrl), { headers });

  it.each([
    [US_LINK, true],
    [{ 'X-Client-Purchase-Policy': 'all', 'X-Client-Platform': 'android' }, false],
    [{}, false],
  ])('after an await in the handler, headers %j -> %s', async (headers, sold) => {
    const response = await get('/cp131/sold', headers);
    expect(await response.json()).toEqual({ sold });
  });

  it('a 402 thrown after an await is worded for the calling build', async () => {
    const pack = await get('/cp131/refuse', US_LINK);
    expect(pack.status).toBe(402);
    expect(((await pack.json()) as { message: string }).message).toContain('Add a credit pack');
    const none = await get('/cp131/refuse', {
      'X-Client-Purchase-Policy': 'p2p-only',
      'X-Client-Platform': 'ios',
    });
    expect(none.status).toBe(402);
    expect(((await none.json()) as { message: string }).message).toContain('They renew on November 1.');
  });

  it('requests in flight at the same time keep their own headers', async () => {
    const bodies = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        get('/cp131/sold', i % 2 === 1 ? US_LINK : { 'X-Client-Purchase-Policy': 'p2p-only' }).then(
          (r) => r.json(),
        ),
      ),
    );
    bodies.forEach((body, i) => expect(body).toEqual({ sold: i % 2 === 1 }));
  });
});
