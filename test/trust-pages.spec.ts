import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  renderTrustPage,
  safeHref,
  policyFooterLinks,
  SUPPORT_EMAIL,
  POLICY_LAST_REVIEWED,
  PRIVACY_POLICY_PATH,
  CONSUMER_HEALTH_POLICY_PATH,
  type TrustPage,
} from '../src/public-pages/trust-pages.html';
import { renderHelpPage } from '../src/public-pages/help-pages.html';
import { TRIAGE_CATEGORIES } from '../src/community/ai-triage/triage-output.schema';
import buildInboxTriagePrompt from '../src/community/ai-triage/prompts/inbox-triage.prompt';
import { renderDownloadPage, renderSignupPage } from '../src/public-pages/public-pages.html';

const ALL_TRUST_PAGES: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];

// Visible text of a page: tags removed, entities decoded. Lets copy
// assertions read like the page a person sees.
function visibleText(html: string): string {
  // Text nodes only: drop <head> (styles), then split on tags. Test helper
  // for reading trusted, server-rendered copy; not a sanitizer.
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  return decodeEntities(body.split(/<[^>]*>/).join(' ')).replace(/\s+/g, ' ');
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    '&quot;': '"',
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
  };
  return s.replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m);
}

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

describe('PublicPagesController trust pages', () => {
  const controller = new PublicPagesController();

  it('serves /privacy as a 200 HTML page with privacy-policy copy', () => {
    const res = makeRes();
    controller.privacy(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('Privacy Policy');
    expect(res.body).toContain('What we collect');
    expect(res.body).toContain('Your rights');
    // Practical user-rights path must surface the support email.
    expect(res.body).toContain(SUPPORT_EMAIL);
    // Last-reviewed signal so reviewers and customers see freshness.
    expect(res.body).toContain(POLICY_LAST_REVIEWED);
  });

  it('serves /terms as a 200 HTML page with terms-of-service copy', () => {
    const res = makeRes();
    controller.terms(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Terms of Service');
    expect(res.body).toContain('Acceptable use');
    expect(res.body).toContain('Subscriptions and billing');
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('serves /security as a 200 HTML page describing practical controls', () => {
    const res = makeRes();
    controller.security(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Security');
    expect(res.body).toContain('Transport and storage');
    expect(res.body).toContain('Incident response');
    // Honest about not holding audit certifications today — this is the
    // failure mode we are explicitly avoiding (no fake SOC 2 claim).
    expect(res.body).toMatch(/do not, however, currently hold/i);
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('serves /status as a 200 HTML page that lists current public endpoints honestly', () => {
    const res = makeRes();
    controller.status(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Status');
    // The endpoints section should enumerate the real surface area.
    expect(res.body).toContain('https://app.trygrowthproject.com/signup');
    expect(res.body).toContain('https://app.trygrowthproject.com/download/ios');
    expect(res.body).toContain('https://app.trygrowthproject.com/download/android');
    expect(res.body).toContain('https://app.trygrowthproject.com/health');
    // Explicit reporting channel.
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('sets a sensible Cache-Control on every trust page', () => {
    for (const route of [
      'privacy',
      'consumerHealthPrivacy',
      'terms',
      'security',
      'status',
    ] as const) {
      const res = makeRes();
      (controller as any)[route](res);
      expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    }
  });

  it('does not claim certifications it does not hold (no SOC2 / HIPAA / ISO claims)', () => {
    const html = renderTrustPage('security');
    // Allow the *negative* mention ("we do not hold SOC 2") but reject any
    // affirmative claim. We assert by pattern: no "SOC 2 compliant",
    // "ISO 27001 certified", "HIPAA compliant" (case-insensitive).
    expect(html).not.toMatch(/SOC\s*2\s*(compliant|certified)/i);
    expect(html).not.toMatch(/ISO\s*27001\s*(compliant|certified)/i);
    expect(html).not.toMatch(/HIPAA\s*(compliant|certified)/i);
    expect(html).not.toMatch(/PCI[- ]DSS\s*(compliant|certified)/i);
  });

  it('avoids AI fingerprints / boilerplate hedging in trust copy', () => {
    for (const slug of ['privacy', 'terms', 'security', 'status'] as const) {
      const html = renderTrustPage(slug);
      expect(html).not.toMatch(/as an AI/i);
      expect(html).not.toMatch(/As a language model/i);
      expect(html).not.toMatch(/I cannot provide/i);
    }
  });

  it('includes a navigation header linking every trust page from each page', () => {
    for (const slug of ALL_TRUST_PAGES) {
      const html = renderTrustPage(slug);
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/consumer-health-privacy"');
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/security"');
      expect(html).toContain('href="/status"');
    }
  });

  it('escapes the support email correctly into both display text and mailto', () => {
    const html = renderTrustPage('privacy');
    expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(html).toContain(SUPPORT_EMAIL);
  });

  it('uses the owner-confirmed support email (Bradleyapple1031@gmail.com)', () => {
    expect(SUPPORT_EMAIL).toBe('Bradleyapple1031@gmail.com');
  });

  it('emits a last-reviewed date in ISO-8601 (YYYY-MM-DD) form', () => {
    expect(POLICY_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('marks the consumer health page active in the nav on that page only', () => {
    expect(renderTrustPage('consumer-health')).toContain(
      '<a class="nav-link active" href="/consumer-health-privacy">',
    );
    expect(renderTrustPage('privacy')).toContain(
      '<a class="nav-link" href="/consumer-health-privacy">',
    );
  });
});

describe('Consumer Health Data Privacy Policy (/consumer-health-privacy)', () => {
  const controller = new PublicPagesController();

  it('is served as a 200 HTML page on the bare consumer-health-privacy path', () => {
    const res = makeRes();
    controller.consumerHealthPrivacy(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('Consumer Health Data Privacy Policy');
    expect(res.body).toContain(POLICY_LAST_REVIEWED);
    expect(
      Reflect.getMetadata(PATH_METADATA, PublicPagesController.prototype.consumerHealthPrivacy),
    ).toBe('consumer-health-privacy');
    expect(CONSUMER_HEALTH_POLICY_PATH).toBe('/consumer-health-privacy');
    expect(PRIVACY_POLICY_PATH).toBe('/privacy');
  });

  it('is excluded from the /api global prefix in main.ts', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toContain("'consumer-health-privacy',");
  });

  it('covers every RCW 19.373.020 disclosure', () => {
    const text = visibleText(renderTrustPage('consumer-health'));
    for (const heading of [
      'Categories we collect and why',
      'Where it comes from',
      'Categories we share',
      'Who we do not share with',
      'Your rights',
      'How to make a request',
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('RCW 19.373');
    // Named recipients, including the AI provider.
    for (const vendor of [
      'Supabase',
      'Fly.io',
      'Anthropic',
      'Sentry',
      'PostHog',
      'Crisp',
      'Resend',
      'Expo',
    ]) {
      expect(text).toContain(vendor);
    }
    expect(text).toMatch(/No affiliates/);
  });

  it('states the RCW 19.373.040 rights, timelines and appeal path', () => {
    const text = visibleText(renderTrustPage('consumer-health'));
    expect(text).toMatch(/Confirm and access/);
    expect(text).toMatch(/Recipient list .*email address or online contact/);
    expect(text).toMatch(/Withdraw consent/);
    expect(text).toMatch(/Delete — have your consumer health data deleted/);
    expect(text).toMatch(/within 45 days of receiving your request/);
    expect(text).toMatch(/extend that once by up to 45 more days/);
    expect(text).toMatch(/free up to twice a year/);
    expect(text).toMatch(/never need to create a new account/);
    expect(text).toMatch(/never kept more than six months after a confirmed deletion request/);
    expect(text).toMatch(/tell every service provider we shared it with/);
    expect(text).toMatch(/Appeals/);
    expect(text).toMatch(/in writing .* within 45 days of receiving your appeal/);
    expect(text).toContain('https://www.atg.wa.gov/file-complaint');
    expect(text).toContain(SUPPORT_EMAIL);
  });

  it('states no sale, no advertising use and no clinic-partner exchange', () => {
    const text = visibleText(renderTrustPage('consumer-health'));
    expect(text).toMatch(/do not sell consumer health data/);
    expect(text).toMatch(/do not use it for advertising or marketing/);
    expect(text).toMatch(/No clinic partner/);
    expect(text).toMatch(/Roman conversations are never shared with your coach/);
  });

  it('states the owner-approved D2 Consent section byte for byte (approved 2026-10-01 09:07 PDT)', () => {
    const text = visibleText(renderTrustPage('consumer-health'));
    const approved = [
      "Before we collect your consultation answers, the app shows two separate boxes on one screen. The first, which you need to tick to continue, covers the personal-training waiver and lets TGP and your coach collect and use your information to coach you. The second is optional: it lets Roman and your coach's AI drafts use your information, names Anthropic as the AI provider and lists the data it receives. If you leave it unticked, nothing about you is sent to Anthropic. Connecting Apple Health or Health Connect asks for separate permission on your phone. We will not collect new categories of health data, or use or share it for new purposes, without telling you first and asking for your agreement.",
      'You can withdraw the optional AI agreement at any time in Settings > Privacy; Roman and AI drafts about you then stop. To stop all collection, delete your account in Settings > Account. You can also disconnect Apple Health or Health Connect, and delete your data, as described below.',
    ];
    for (const paragraph of approved) expect(text).toContain(paragraph);
    // Box 2 withdrawal and the delete-account path for stopping all collection.
    expect(text).toContain('in Settings > Privacy; Roman and AI drafts about you then stop.');
    expect(text).toContain('To stop all collection, delete your account in Settings > Account.');
    // Rendered escaped, as plain paragraphs inside the Consent section.
    const html = renderTrustPage('consumer-health');
    const consent = html.slice(html.indexOf('>Consent<'), html.indexOf('>Your rights<'));
    expect(consent).toContain('Settings &gt; Privacy;');
    expect(consent).toContain('your coach&#39;s AI drafts');
  });

  it('links back to the Privacy Policy and keeps the counsel-review notice', () => {
    const html = renderTrustPage('consumer-health');
    expect(html).toContain('<a href="/privacy">Read the full Privacy Policy</a>');
    expect(html).toMatch(/counsel review is recommended/);
  });
});

describe('Privacy Policy accuracy (/privacy)', () => {
  const html = renderTrustPage('privacy');
  const text = visibleText(html);

  it('links prominently to the consumer health policy', () => {
    expect(html).toContain(
      '<a href="/consumer-health-privacy">Read the Consumer Health Data Privacy Policy</a>',
    );
  });

  it('names every service provider the code calls', () => {
    for (const vendor of [
      'Supabase',
      'Fly.io',
      'Stripe',
      'Anthropic',
      'Perplexity',
      'PostHog',
      'Sentry',
      'Crisp',
      'Resend',
      'Expo',
      'Sign in with Apple',
      'Google sign-in',
      'Apple Health',
      'Health Connect',
      'USDA FoodData Central',
      'Open Food Facts',
    ]) {
      expect(text).toContain(vendor);
    }
  });

  it('describes Roman: Anthropic, private from the coach, kept until deleted, client delete, staff access', () => {
    expect(text).toMatch(/Roman is an AI assistant powered by Anthropic/);
    expect(text).toMatch(/Roman conversations are not visible to your coach/);
    // Owner rule (OR-110-1): past AI chats are kept, no time-based purge.
    expect(text).toMatch(/Roman conversations are kept until you delete them or your account/);
    expect(text).toMatch(/Roman conversations — kept until you delete them or your account/);
    expect(text).toMatch(/delete a conversation at any time/);
    expect(text).toMatch(/only for support, safety and debugging/);
    expect(text).toMatch(/two separate boxes on one screen/);
  });

  // R11-L1 (owner A6.4: notes survive chat deletion and the policy says so;
  // owner 10:18 10-07: memory is on by default inside the Roman permission,
  // notes come from chats and everything the client logs or connects, and the
  // client can turn memory off; owner 11:46 10-07: notes are deleted only
  // with the account, never by memory off, withdrawal or chat deletion). Coach-method wording
  // follows the owner-approved v5 paragraph (ai-consent.constants.ts).
  it('describes Roman’s memory: on within the Roman permission, chats and logs, off switch, survives chat deletion', () => {
    expect(text).not.toContain(
      'Only your own data is used — never another client’s, and never your coach’s private notes about you.',
    );
    expect(text).toContain(
      'With Roman’s memory off, only your own data is used — never another client’s, and never your coach’s private notes about you.',
    );
    expect(text).toContain(
      'Roman’s memory is part of the Roman permission you give in the consultation, and it is on unless you turn it off. Roman keeps notes and summaries about your training, preferences and circumstances, from your Roman chats and from everything you log or connect in the app, to personalise his replies. Roman may also learn your coach’s methods, including from your coach’s private session notes, and information about your training may help with that without identifying you. Roman never quotes those notes or shows you another client’s information. Your coach never sees your conversations with Roman or his notes about you. You can turn Roman’s memory off at any time in Settings > Privacy > Roman and AI; Roman then stops using his notes until you turn it back on. Turning memory off, withdrawing the AI agreement or deleting a chat does not delete the notes: they are kept with your account and deleted when you delete your account.',
    );
    expect(text).toContain('food, water and habit logs, workouts and workout history, check-ins, bookings,');
    expect(text).toContain(
      'Roman’s notes and summaries — short notes Roman keeps about your training, preferences and circumstances, from your Roman chats and from everything you log or connect in the app, as part of the Roman permission (see “Roman and AI” below).',
    );
    expect(text).toContain(
      'Deleting a chat removes its messages but not Roman’s notes; deleting your account removes them.',
    );
    expect(text).toContain(
      'Roman’s notes and summaries — kept with your account until you delete it, including while Roman’s memory is off; deleting a chat does not remove them.',
    );
    expect(POLICY_LAST_REVIEWED >= '2026-10-07').toBe(true);
  });

  it('no policy offers a separate way to delete Roman’s notes (owner 11:46 10-07)', () => {
    for (const slug of ['privacy', 'consumer-health'] as const) {
      expect(visibleText(renderTrustPage(slug))).not.toMatch(/and delete (his|the) notes|deleting the notes in/);
    }
  });

  // R11-T1b (#843, read_history): fasting logs, past Roman chats the client has
  // not deleted, the client's own community posts and per-day device health
  // (sleep stages, bedtime and wake time, body weight and body fat, blood
  // pressure); never the raw HEART_RATE_BPM stream. /privacy already names the
  // community posts the client writes in the sentence before.
  it('both policies name what Roman may read (R11-T1b), never raw heart-rate readings', () => {
    const device =
      'daily summaries of your connected health data, including sleep stages, bedtime and wake time, body weight and body fat, and blood pressure.';
    const never = 'Roman never reads the raw heart-rate readings your device records.';
    expect(text).toContain(
      'When your coach asks for an AI draft about you, the same kinds of data are sent. Roman may also read, and send to Anthropic, your fasting logs, your earlier Roman conversations that you have not deleted and ' +
        device +
        ' ' +
        never +
        ' With Roman’s memory off, only your own data is used',
    );
    const health = visibleText(renderTrustPage('consumer-health'));
    expect(health).toContain(
      'After you tick the optional AI box, Roman may read, and send to Anthropic, your fasting logs, your earlier Roman conversations that you have not deleted, the community posts you wrote and ' +
        device +
        ' ' +
        never,
    );
  });

  it('health-data policy: Roman’s notes are collected and derived information, with the off switch', () => {
    const health = visibleText(renderTrustPage('consumer-health'));
    expect(health).toContain(
      'Derived information — calorie and macro targets, the plan assigned to you, trends in your readings, Roman’s replies, and Roman’s notes and summaries.',
    );
    expect(health).toContain(
      'Roman’s notes and summaries — short notes Roman keeps about your training, preferences and circumstances, from your Roman chats and from everything you log or connect, as part of the Roman permission you give in the consultation. Used to personalise Roman’s replies. Roman’s memory is on unless you turn it off in Settings > Privacy > Roman and AI; while it is off, Roman does not use the notes. Turning memory off or deleting a chat does not remove them; they are kept with your account and deleted when you delete your account.',
    );
  });

  it('no page states a time-based purge of Roman conversations', () => {
    const pages: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];
    for (const page of pages) {
      expect(visibleText(renderTrustPage(page))).not.toMatch(/180 days|deleted automatically/);
    }
  });

  // Owner rule: the income/body/lifestyle diagnostic quiz is another product.
  it('says nothing about a diagnostic quiz or income questions', () => {
    const pages: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];
    for (const page of pages) {
      expect(visibleText(renderTrustPage(page))).not.toMatch(/quiz|income|diagnostic (test|assessment|questionnaire)/i);
    }
  });

  // Sol B-611-2: deletion keeps more than payment records; say exactly what.
  it('deletion retention names every category kept, not only payment records', () => {
    expect(text).not.toMatch(/We keep only the payment records the law requires\./);
    expect(text).toContain('We keep only what we must: the payment records the law requires; security and audit logs;');
    expect(text).toContain('one deletion record with a random reference, the date and the result');
    // Sol B-611-2 (round 5): three different periods, never one combined
    // 30-day promise. #608 keeps the tombstone User row (no expiry), keeps the
    // auth provider id only while removal retries, and replaces the 30-day
    // receipt hash with `deleted-<id>` (an UPDATE, not a row delete).
    expect(text).toContain(
      'a closed-account record with no name, contact details or profile, holding only an internal account number, the account type and dates such as when the account was opened and closed, so the records we must keep still point to one closed account.',
    );
    expect(text).toContain(
      'While removing your sign-in account at your sign-in provider is still being retried, we also keep that provider’s account ID.',
    );
    expect(text).toContain(
      'Once it is removed, we keep only a one-way code made from it, for 30 days, so the app can tell you the account was deleted if you sign in again; then the code is discarded.',
    );
    expect(text).not.toMatch(/for 30 days, a minimal closed-account record/);
    expect(text).not.toMatch(/closed-account record[^.]*for 30 days/);
  });

  it('covers retention, deletion, rights, no sale and children 16+', () => {
    expect(text).toMatch(/How long we keep it/);
    expect(text).toMatch(/Settings, then Delete account/);
    expect(text).toMatch(/14-day grace period/);
    expect(text).toMatch(/We do not sell personal data/);
    expect(text).toMatch(/do not use health data for advertising or marketing/);
    expect(text).toMatch(/You must be 16 or older/);
    expect(text).toMatch(
      /No account, consultation, coaching, health, wearable or Roman data is exchanged with any clinic partner/,
    );
  });

  it('no longer makes the old inaccurate claims', () => {
    expect(text).not.toMatch(/store only the subscription identifiers/);
    expect(text).not.toMatch(/Your coaching data is visible to your coach \(that is the point/);
    expect(text).not.toMatch(/minimum context required/);
  });

  it('keeps the company-drafted, counsel-review notice', () => {
    expect(text).toMatch(/company-drafted statement of practice/);
    expect(text).toMatch(/counsel review is recommended/);
  });
});

describe('Terms of Service eligibility', () => {
  it('requires 16+ and links both privacy documents', () => {
    const html = renderTrustPage('terms');
    expect(visibleText(html)).toMatch(/You must be 16 or older to use the service/);
    expect(html).toContain('<a href="/privacy">Privacy Policy</a>');
    expect(html).toContain(
      '<a href="/consumer-health-privacy">Consumer Health Data Privacy Policy</a>',
    );
    expect(visibleText(html)).toMatch(/company-drafted statement of terms/);
  });
});

describe('policy copy hygiene', () => {
  it('mentions a clinic only as “clinic partner” (never by name)', () => {
    for (const slug of ALL_TRUST_PAGES) {
      const text = visibleText(renderTrustPage(slug));
      const mentions = text.match(/clinic\s*\w*/gi) ?? [];
      for (const m of mentions) expect(m.toLowerCase()).toMatch(/^clinic partners?$/);
    }
  });

  it('uses no exclamation marks in policy copy', () => {
    for (const slug of ['privacy', 'consumer-health', 'terms'] as const) {
      expect(visibleText(renderTrustPage(slug))).not.toContain('!');
    }
  });

  it('bumped the last-reviewed date for the D2 consent rewrite', () => {
    expect(POLICY_LAST_REVIEWED >= '2026-10-01').toBe(true);
  });

  it('no page still describes the old single-box agreement (D2: two boxes)', () => {
    for (const slug of ['privacy', 'consumer-health', 'terms'] as const) {
      const text = visibleText(renderTrustPage(slug));
      expect(text).not.toMatch(/single “I agree” box/);
      expect(text).not.toMatch(/single "I agree" box/);
    }
  });

  // B-611-1 (round 2): the community AI disclosure must describe what
  // src/community/ai-triage does once backend #626 (R2b AI egress gateway,
  // branch agent/clinic/r2b-ai-consent-gateway) is live: coach inbox sorting
  // (classify into TRIAGE_CATEGORIES + summarise; fields from
  // inbox-triage.prompt.ts; coach/owner only; read-only), and ONLY for authors
  // with a live box-2 grant. The gate is in #626 at
  //   src/community/ai-triage/ai-triage.service.ts  (`egress.consentedClients`
  //     drops every item whose author has no grant before the prompt is built)
  //   src/ai-egress/ai-egress.service.ts            (`consentedClients`, and the
  //     live grant re-check on every send; fails closed)
  // and is proven by #626's test/community/ai-triage/ai-triage.service.spec.ts
  // ("AiTriageService — R2b box-2 consent"). #611 must not ship the triage
  // flag on before #626: FEATURE_COMMUNITY_AI_TRIAGE stays off until then.
  // Never "moderation" or "review"; never "does not depend on the AI box".
  it('describes community AI as coach inbox sorting, only for members who ticked box 2', () => {
    const privacy = visibleText(renderTrustPage('privacy'));
    const health = visibleText(renderTrustPage('consumer-health'));
    for (const text of [privacy, health]) {
      expect(text).not.toMatch(/community content (review|for moderation)/i);
      expect(text).not.toMatch(/review community content/i);
      expect(text).not.toMatch(/does not depend on the optional AI box/i);
      expect(text).not.toMatch(/separate from this box/i);
      expect(text).not.toMatch(/for Roman or AI drafts/);
    }
    // The owner-approved box-2 sentence is back, byte for byte, in both places.
    expect(privacy).toContain(
      'If you leave it unticked, nothing about you is sent to Anthropic, and your plan, your coach, the community and Roman’s guided tour work as usual.',
    );
    expect(health).toContain('If you leave it unticked, nothing about you is sent to Anthropic.');
    expect(privacy).toContain(
      'Anthropic sorts the community posts and messages a coach has not yet answered into five groups (urgent, a win to celebrate, a form check, general, no action needed)',
    );
    expect(privacy).toContain(
      'Sorting only includes posts and messages from members who ticked the optional AI box; everything else stays in the coach’s regular inbox, unsorted.',
    );
    expect(privacy).toContain(
      'it receives up to 240 characters of the text, the name of the member who wrote it, the cohort name and how many hours ago it was posted.',
    );
    expect(privacy).toContain(
      'it never replies, posts or acts on anything, and only the coach sees the result',
    );
    expect(privacy).toContain(
      'Anthropic — Roman and coach AI drafts, after you agree; sorting and summarising a coach’s unanswered community posts and messages for that coach, if turned on, only for members who agreed.',
    );
    expect(health).toContain(
      'up to 240 characters of each community post or message your coach has not yet answered, with your name, the cohort name and its age, so it can sort and summarise them for your coach (only if you ticked the optional AI box)',
    );
  });

  it('keeps the community AI disclosure tied to the code it describes', () => {
    // Five groups named in the policy == the implemented categories.
    expect(TRIAGE_CATEGORIES).toEqual([
      'urgent',
      'win_to_celebrate',
      'form_check',
      'general',
      'no_action_needed',
    ]);
    // The fields the policy lists are exactly the ones rendered into the prompt.
    const prompt = buildInboxTriagePrompt([
      {
        id: 'item-1',
        kind: 'post',
        preview: 'x'.repeat(300),
        cohortName: 'Spring plan',
        authorDisplayName: 'Sam Member',
        ageHours: 5,
      },
    ]).user;
    expect(prompt).toContain('cohort: Spring plan');
    expect(prompt).toContain('from: Sam Member');
    expect(prompt).toContain('age_hours: 5');
    expect(prompt).toContain(`text: ${'x'.repeat(240)}`);
    expect(prompt).not.toContain('x'.repeat(241));
  });

  // Owner ruling 2026-10-01 16:30: the public website diagnostic quiz
  // (src/diagnostic, Perplexity "roadmap") belongs to another product and is
  // being switched off, so no policy may mention it or the data it collected.
  // "Device, usage and diagnostic data" is the technical-diagnostics category
  // (crash and performance reports), not the quiz, and is the only allowed use.
  it('no longer mentions the website diagnostic or its roadmap on any public page', () => {
    const pages = [
      ...ALL_TRUST_PAGES.map((p) => visibleText(renderTrustPage(p))),
      ...(
        [
          'index',
          'setup',
          'first-client',
          'tour',
          'faq',
          'support',
          'contact',
          'delete-account',
        ] as const
      ).map((p) => visibleText(renderHelpPage(p))),
    ];
    for (const text of pages) {
      const rest = text.split('Device, usage and diagnostic data').join('');
      expect(rest).not.toMatch(/diagnostic/i);
      expect(rest).not.toMatch(/roadmap/i);
      expect(rest).not.toMatch(/quiz/i);
      expect(rest).not.toMatch(/on our website/i);
    }
    // Perplexity stays only for first-milestone encouragement, which
    // src/first-win/first-win.service.ts still sends to Perplexity on main
    // (generateFirstDataPointMessage: only the win type, no client data).
    const privacy = visibleText(renderTrustPage('privacy'));
    expect(privacy).toContain(
      'Perplexity, if enabled, is used to write short generic encouragement after your first logged milestones (it receives only the type of milestone, not your data).',
    );
    expect(privacy).toContain('Perplexity — generic milestone messages, if enabled.');
    expect(visibleText(renderTrustPage('consumer-health'))).not.toMatch(/Perplexity/);
  });

  it('describes box 2 as optional AI processing by Anthropic, withdrawn in Settings > Privacy > Roman and AI', () => {
    const privacy = visibleText(renderTrustPage('privacy'));
    expect(privacy).toContain(
      'The second is optional and starts unticked: it lets Roman and your coach’s AI drafts use your information, names Anthropic as the AI provider and lists the data it receives.',
    );
    expect(privacy).toContain(
      'You can allow or withdraw the optional AI agreement at any time in Settings > Privacy > Roman and AI',
    );
    expect(privacy).toContain('Settings, then Delete account');
    const terms = visibleText(renderTrustPage('terms'));
    expect(terms).toContain(
      'A separate, optional box lets Roman and your coach’s AI drafts use your information, processed by Anthropic.',
    );
  });
});

describe('HTML escaping and link safety', () => {
  it('escapes ampersands and quotes in policy copy', () => {
    const html = renderTrustPage('privacy');
    expect(html).toContain('Trust &amp; Privacy');
    expect(html).not.toMatch(/Trust & Privacy/);
    const body = html.slice(html.indexOf('<body>'));
    // No raw double quotes leak into text nodes (only attributes use them).
    expect(body.split(/<[^>]*>/).join('')).not.toContain('"');
  });

  it('renders no script tags or inline event handlers', () => {
    for (const slug of ALL_TRUST_PAGES) {
      const html = renderTrustPage(slug);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toMatch(/javascript:/i);
    }
  });

  it('safeHref only allows site-relative, mailto and https links', () => {
    expect(safeHref('/consumer-health-privacy')).toBe('/consumer-health-privacy');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('https://www.atg.wa.gov/file-complaint')).toBe(
      'https://www.atg.wa.gov/file-complaint',
    );
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('//evil.example')).toBe('#');
    expect(safeHref('data:text/html,x')).toBe('#');
    expect(safeHref('http://plain.example')).toBe('#');
    expect(safeHref('/x" onmouseover="y')).toBe('#');
    expect(safeHref('https://a.example/"><script>')).toBe('#');
  });
});

describe('consumer health policy link on other public pages', () => {
  it('appears in the footer of every trust page', () => {
    for (const slug of ALL_TRUST_PAGES) {
      expect(renderTrustPage(slug)).toContain(policyFooterLinks());
    }
  });

  it('appears in the footer of every help page', () => {
    for (const page of [
      'index',
      'setup',
      'first-client',
      'tour',
      'faq',
      'support',
      'contact',
    ] as const) {
      expect(renderHelpPage(page)).toContain('href="/consumer-health-privacy"');
    }
  });

  it('appears on the signup and download pages', () => {
    expect(renderSignupPage(null)).toContain('href="/consumer-health-privacy"');
    expect(renderSignupPage('GP-TEST1')).toContain('href="/consumer-health-privacy"');
    expect(renderDownloadPage('ios')).toContain('href="/consumer-health-privacy"');
    expect(renderDownloadPage('android')).toContain('href="/consumer-health-privacy"');
  });
});

describe('community and leaderboard disclosure (B-PRIVACY-1, after b#747)', () => {
  const community =
    'Members of the community spaces you join can see your display name and the posts, ' +
    'comments, reactions, shared wins and group messages you choose to share in those spaces. ' +
    'Messages sent directly to your coach are not group messages.';
  const leaderboard =
    'If you opt in to a leaderboard, other clients assigned to the same coach can see your ' +
    'display name, rank and participation information, such as workout counts or a ' +
    'habit-consistency score and its change. The habit score uses check-in, workout, meal-log ' +
    'and coach-message activity, not the content of your private messages. You can opt out to ' +
    'hide your leaderboard entry.';

  it('/privacy "Who can see your data" names community spaces and the opt-in leaderboard', () => {
    const text = visibleText(renderTrustPage('privacy'));
    const section = text.slice(
      text.indexOf('Who can see your data'),
      text.indexOf('Roman and AI', text.indexOf('Who can see your data')),
    );
    expect(section).toContain(community);
    expect(section).toContain(leaderboard);
    expect(section).toContain('Coaches can sort the members of their spaces by when they joined.');
  });

  it('/consumer-health-privacy "Categories we share" names community spaces and the opt-in leaderboard', () => {
    const text = visibleText(renderTrustPage('consumer-health'));
    const section = text.slice(
      text.indexOf('Categories we share'),
      text.indexOf('Who we do not share with'),
    );
    expect(section).toContain(community);
    expect(section).toContain(leaderboard);
    expect(text).not.toContain('only the health information you choose to post there');
  });
});

describe('Terms of Service community zero tolerance (Apple Guideline 1.2)', () => {
  it('carries the in-app Community terms sentence word for word', () => {
    expect(visibleText(renderTrustPage('terms'))).toContain(
      'There is no tolerance for objectionable content or abusive users. Content that breaks ' +
        'these guidelines is removed, and the account that posted it can be removed.',
    );
  });
});

describe('status page signup endpoint label (B-STORECOPY-2)', () => {
  it('describes /signup as open signup, not invite-only', () => {
    const text = visibleText(renderTrustPage('status'));
    expect(text).toContain(
      'https://app.trygrowthproject.com/signup — signup information and coaching invitations.',
    );
    expect(text).not.toMatch(/invite-only/i);
  });
});

describe('Terms of Service intro (F10, S-IOSREV C-4)', () => {
  it('does not call the live terms a draft', () => {
    const text = visibleText(renderTrustPage('terms'));
    expect(text).toContain(
      'These terms describe the agreement between you and The Growth Project (“TGP”) when you use our software.',
    );
    expect(text).not.toMatch(/company policy draft|written as a company policy/i);
  });
});
