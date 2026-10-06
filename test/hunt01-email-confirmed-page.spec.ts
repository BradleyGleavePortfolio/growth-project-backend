// HUNT-01-124 — sign-up confirmation landing.
//
// Normal-day story: a new member signs up on the phone, opens the
// confirmation email on a computer and clicks Confirm. Supabase confirms the
// address and redirects to the app link `tgp://verified`, which a computer
// cannot open, so the person sees a blank page (or, when the redirect is not
// allow-listed, the Site URL fallback "Coach landing page — This page isn't
// available") and believes sign-up failed. Production today:
// GET https://app.trygrowthproject.com/verified -> 404 JSON.
//
// This page is the web target for that redirect: it says the email is
// confirmed and what to do next, switches to expired-link copy when Supabase
// appends an error, and strips the session fragment from the address bar.
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import {
  EMAIL_CONFIRMED_LINK_PROBLEM_BODY,
  EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE,
  EMAIL_CONFIRMED_SCRIPT,
} from '../src/public-pages/public-pages.html';

async function serve(controller: Type<unknown>): Promise<{ app: INestApplication; base: string }> {
  const mod = await Test.createTestingModule({ controllers: [controller] }).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base };
}

// Visible text only: drop the one known, server-owned script block by exact
// string (not a regex), then strip tags.
function textOutsideTags(html: string): string {
  const scriptBlock = `<script>\n${EMAIL_CONFIRMED_SCRIPT}\n</script>`;
  expect(html).toContain(scriptBlock);
  return html
    .split(scriptBlock)
    .join(' ')
    .split('<')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join(' ');
}

type FakeEl = { textContent: string; href?: string; setAttribute(k: string, v: string): void };

function runScript(hash: string, search = '') {
  const els: Record<string, FakeEl> = {
    h1: { textContent: 'Email confirmed', setAttribute() {} },
    'main > p': { textContent: 'body', setAttribute() {} },
    'a.cta': {
      textContent: 'Open the app',
      href: 'tgp://verified',
      setAttribute(k: string, v: string) {
        if (k === 'href') this.href = v;
      },
    },
  };
  const replaceState = jest.fn();
  const window = {
    location: { hash, search, pathname: '/verified' },
    history: { replaceState },
  };
  const document = { querySelector: (sel: string) => els[sel] ?? null };
  new Function('window', 'document', EMAIL_CONFIRMED_SCRIPT)(window, document);
  return { els, replaceState };
}

describe('HUNT-01-124 GET /verified (email confirmed landing)', () => {
  let app: INestApplication | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('serves a static confirmation page that opens the app and offers the stores and support', async () => {
    const served = await serve(PublicPagesController);
    app = served.app;
    const res = await fetch(`${served.base}/verified`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(body).toContain('<h1>Email confirmed</h1>');
    expect(body).toContain('href="tgp://verified"');
    expect(body).toContain('href="/download/ios"');
    expect(body).toContain('href="/download/android"');
    expect(body).toContain('mailto:');
    const text = textOutsideTags(body);
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\b(I|I'm|we|We|our|Our|us)\b/);
  });

  it('a successful return strips the session tokens from the address bar and keeps the confirmed copy', () => {
    const { els, replaceState } = runScript(
      '#access_token=AAA.BBB.CCC&expires_in=3600&refresh_token=RRR&token_type=bearer&type=signup',
    );
    expect(replaceState).toHaveBeenCalledWith(null, '', '/verified');
    expect(els.h1.textContent).toBe('Email confirmed');
    expect(els['a.cta'].href).toBe('tgp://verified');
  });

  it('an expired or already-used link switches to the link-problem copy (fragment error)', () => {
    const { els, replaceState } = runScript(
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(replaceState).toHaveBeenCalled();
    expect(els.h1.textContent).toBe(EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE);
    expect(els['main > p'].textContent).toBe(EMAIL_CONFIRMED_LINK_PROBLEM_BODY);
    expect(els['a.cta'].href).toBe('tgp://verified?error=link_problem');
  });

  it('treats a query-string error the same way (PKCE-style error return)', () => {
    const { els } = runScript('', '?error=access_denied&error_code=otp_expired');
    expect(els.h1.textContent).toBe(EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE);
  });

  it('a bare visit changes nothing', () => {
    const { els, replaceState } = runScript('', '');
    expect(replaceState).not.toHaveBeenCalled();
    expect(els.h1.textContent).toBe('Email confirmed');
  });

  it('link-problem copy follows the product copy rules', () => {
    for (const s of [EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE, EMAIL_CONFIRMED_LINK_PROBLEM_BODY]) {
      expect(s).not.toContain('!');
      expect(s).not.toMatch(/\b(I|I'm|we|We|our|Our|us)\b/);
    }
  });
});
