// Durable, server-rendered self-serve help surface: /help, /help/setup,
// /help/first-client, /help/tour, /help/faq, /help/support, /help/contact.
//
// These pages are the public, no-vendor coach-facing help destination.
// Content is sourced from docs/help/*.md (PR #101) and rendered as static
// HTML in the same quiet-luxury aesthetic as the trust pages so the public
// surface (https://app.trygrowthproject.com/...) reads as one product.
//
// Editorial guard rails:
//
//  - Plain prose. No emoji, no marketing exclamation, no AI fingerprints.
//  - No placeholders, TODO/FIXME, or "coming soon" copy. If a feature does
//    not exist today, we either omit it or describe the current reality.
//  - Tokens (SUPPORT_EMAIL, COACH_CONSOLE_URL, INVITE_BASE_URL, STATUS_URL)
//    are sourced from a single substitution map; never hardcoded inline.
//    SUPPORT_EMAIL is reused from trust-pages.html so there is exactly one
//    place in the codebase that names the operator's mailbox.
//  - The contact page is a structured intake spec, not a working form.
//    Email is the canonical transport (per docs/help/contact-support.md);
//    no third-party form vendor or new mail provider is introduced.
//
// Mounted outside the /api prefix in main.ts so they resolve as bare paths
// under the public hostname.

import { SUPPORT_EMAIL } from './trust-pages.html';

// Re-export for tests and any future caller that expects to find the
// support address on the help module.
export { SUPPORT_EMAIL } from './trust-pages.html';

// Last-reviewed date for the help copy. Bump on substantive edits so the
// freshness signal at the top of each page reflects reality.
export const HELP_LAST_REVIEWED = '2026-04-30';

// Token defaults align with the staging/production hostnames described in
// docs/help/_tokens.md. The renderer never invents values that depend on
// per-deployment secrets — it just substitutes in copy that already names
// real public URLs the operator can verify.
const COACH_CONSOLE_URL = 'https://console.thegrowthproject.app';
const INVITE_BASE_URL = 'https://app.trygrowthproject.com/join';
const STATUS_URL = 'https://app.trygrowthproject.com/status';

export type HelpPage =
  | 'index'
  | 'setup'
  | 'first-client'
  | 'tour'
  | 'faq'
  | 'support'
  | 'contact';

interface RenderedSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

interface QAndA {
  question: string;
  answer: string;
}

interface RenderedQASection {
  heading: string;
  items: QAndA[];
}

interface ContactField {
  name: string;
  type: string;
  required: 'yes' | 'no';
  notes: string;
}

interface HelpPageContent {
  title: string;
  headline: string;
  intro: string;
  // Either a list of regular sections OR a list of Q&A sections (faq).
  sections?: RenderedSection[];
  qaSections?: RenderedQASection[];
  // Optional "what to include" checklist (contact page).
  checklist?: { heading: string; bullets: string[] };
  // Optional structured intake table (contact page).
  intakeTable?: { heading: string; intro: string; fields: ContactField[] };
  footnote?: string;
}

const NAV_ENTRIES: ReadonlyArray<{ slug: HelpPage; label: string; path: string }> = [
  { slug: 'index', label: 'Overview', path: '/help' },
  { slug: 'setup', label: 'Setup', path: '/help/setup' },
  { slug: 'first-client', label: 'First client', path: '/help/first-client' },
  { slug: 'tour', label: 'Tour', path: '/help/tour' },
  { slug: 'faq', label: 'FAQ', path: '/help/faq' },
  { slug: 'support', label: 'Support', path: '/help/support' },
  { slug: 'contact', label: 'Contact', path: '/help/contact' },
];

function indexContent(): HelpPageContent {
  return {
    title: 'Help — The Growth Project',
    headline: 'Help',
    intro:
      'A short, opinionated guide for coaches getting started on the ' +
      'platform. Each page below answers one question. Read them in order ' +
      'the first time, then keep them as a reference.',
    sections: [
      {
        heading: 'Where to start',
        paragraphs: [
          'New coaches generally read these in order. Thirty minutes from start to first invite is a reasonable budget.',
        ],
        bullets: [
          'Setup checklist — the six steps that move a fresh account to a ready one.',
          'Invite your first client — what to send, what the client sees, and how to confirm they landed.',
          'Coach console tour — a six-scene walkthrough of every screen you will use day to day.',
        ],
      },
      {
        heading: 'When something goes wrong',
        paragraphs: [
          'The next three pages are the ones to open when a question or an issue arises rather than when you are still onboarding.',
        ],
        bullets: [
          'Frequently asked questions — short answers to the questions coaches ask most often.',
          'What support covers — the contract between you and our support team. Read this before you write in.',
          'Contact support — what to include in a message so the first reply is the useful one.',
        ],
      },
      {
        heading: 'How this content is maintained',
        paragraphs: [
          'These pages are versioned alongside the application. The last-reviewed date at the top of each page reflects when the copy was last edited. We update them when product behaviour changes; we do not write speculative documentation for features that do not yet exist.',
        ],
      },
    ],
  };
}

function setupContent(): HelpPageContent {
  return {
    title: 'Coach setup checklist — The Growth Project',
    headline: 'Coach setup checklist',
    intro:
      'Six steps, in order. Each one unblocks the next. Plan for thirty ' +
      'minutes if you have your business details to hand.',
    sections: [
      {
        heading: '1. Confirm your account is a coach account',
        paragraphs: [
          `Sign in to the coach console at ${COACH_CONSOLE_URL}. The header should read Coach. If it reads Client or you cannot reach the console at all, your account has not been promoted yet. Reply to the welcome email so we can promote it.`,
        ],
      },
      {
        heading: '2. Complete your coach profile',
        paragraphs: [
          'In the console, open Settings → Profile and fill in:',
        ],
        bullets: [
          'Display name (this is what clients see).',
          'A one-paragraph bio (two to four sentences is enough).',
          'A profile photo (square, at least 512×512).',
          'Your timezone.',
        ],
      },
      {
        heading: '3. Set your subscription up',
        paragraphs: [
          'Open Settings → Billing and start your subscription. You will be redirected to Stripe to enter card details. The subscription has to be active before you can send messages or invite clients — read-only access works without it, but writing does not.',
          'If billing has already been set up for you (some launch coaches were provisioned manually), this section will say Active and you can skip it.',
        ],
      },
      {
        heading: '4. Generate your default invite link',
        paragraphs: [
          `In the console, open Clients → Invite. The page shows your default invite link in the form ${INVITE_BASE_URL}/AB12CD. Copy it. This is the one link you give to every prospective client unless you have a reason to want a separate link per client (most coaches do not).`,
          'The link is permanent. It does not expire and it is not single-use. If you ever need to rotate it — for example after a phone is lost — the same page has a Rotate button. Rotation invalidates the old link immediately.',
        ],
      },
      {
        heading: '5. Send the invite to one test client',
        paragraphs: [
          'Pick a friend, family member, or second device of your own. Send them the link by whatever channel you would normally use with clients (text, email, DM). Have them open the link, install the app, sign in, and confirm they appear in your roster. If anything in that chain feels confusing, that is feedback — write it down.',
        ],
      },
      {
        heading: '6. Read the support boundaries page',
        paragraphs: [
          'Read What support covers before you send your first real client invite. It tells you which problems we own and which problems sit with you. The line is sharper than most coaches expect on first read, and the cleanest moment to absorb it is before you have a client on the other end.',
        ],
      },
      {
        heading: 'You are done when',
        paragraphs: ['Setup is complete when:'],
        bullets: [
          'Your console header reads Coach.',
          'Your profile is filled in.',
          'Your billing status reads Active.',
          'You have copied your invite link at least once.',
          'A test client has appeared in your roster.',
        ],
      },
    ],
    footnote:
      'Anything outside that list is not a setup step — it is operating the business. Move on.',
  };
}

function firstClientContent(): HelpPageContent {
  return {
    title: 'Invite your first client — The Growth Project',
    headline: 'Invite your first client',
    intro:
      'This walks through the first real invite, end to end. Use it once, ' +
      'then keep it as a reference for the moments your client gets stuck.',
    sections: [
      {
        heading: 'Before you send anything',
        paragraphs: ['Confirm three things in the coach console:'],
        bullets: [
          'Settings → Profile has a display name, bio, and photo. The client will see all three when they open the link.',
          'Settings → Billing reads Active.',
          'Clients → Invite shows a link. Copy it.',
        ],
      },
      {
        heading: 'Send the link',
        paragraphs: [
          `Send the link to one client by the channel you actually use with them. Text and email are the most common. The link looks like ${INVITE_BASE_URL}/AB12CD.`,
          'Anything you write alongside the link is up to you, but the link itself does the heavy lifting — it shows your photo, your bio, and an Open in app button when the client taps it. You do not need to explain what the app is in the message.',
        ],
      },
      {
        heading: 'What the client sees',
        paragraphs: [
          'Tapping the link opens a landing page in the browser. The page shows your card and one button. The button does one of two things:',
        ],
        bullets: [
          'If the client already has the app installed, it deep-links into the app and starts the sign-in flow.',
          'If the client does not have the app installed, it routes to the App Store or Play Store, and the deep link is preserved through the install. After installing and opening the app for the first time, they land on the same sign-in flow with your invite already attached.',
        ],
      },
      {
        heading: 'Confirm they landed',
        paragraphs: [
          'In the console, open Clients → Roster. The client should appear within a few seconds of completing sign-in. If they do not, ask them which step they got stuck on:',
        ],
        bullets: [
          'Could they open the link in their browser? A failure here is usually a DNS or carrier issue on their end.',
          'Did the Open in app button appear? Yes means the link resolved correctly. No means the link they used was incomplete (often from a copy-paste that dropped characters).',
          'Did they finish sign-in? If they bailed on the Apple or Google prompt, there is no row to show; they need to retry.',
        ],
      },
      {
        heading: 'Common first-invite snags',
        paragraphs: ['Four issues account for most stuck clients:'],
        bullets: [
          'The client has an existing account from a different coach. They cannot be moved by sending a new invite. Ask them to delete their account in the app first, then sign up again with your invite. If that is not viable, see the Contact page.',
          'The link looks like .../join/ with no code. The code did not copy. Re-copy from Clients → Invite.',
          'The client tapped the link but it opened a generic app store page. The link did not contain the code, or they tapped a shortened version that dropped path segments. Send the original link without a URL shortener.',
          'Apple or Google sign-in returned them to a blank screen. Their browser blocked the redirect. Have them open the original link in Safari (iOS) or Chrome (Android) rather than an in-app browser.',
        ],
      },
      {
        heading: 'After the first invite',
        paragraphs: [
          'For every subsequent client, send the same link. The link does not change between clients. There is no per-client setup on your side until a client appears in your roster, at which point you can open their thread and message them in the console.',
        ],
      },
    ],
  };
}

function tourContent(): HelpPageContent {
  return {
    title: 'Coach console tour — The Growth Project',
    headline: 'Coach console tour',
    intro:
      'A six-scene walkthrough of the coach console. Read it as a tour, ' +
      'or use it as a screen-by-screen reference when something is not ' +
      'where you expected.',
    sections: [
      {
        heading: 'Sign in',
        paragraphs: [
          `The sign-in page lives at ${COACH_CONSOLE_URL}. Sign in with the email you used during setup. Apple, Google, and email all land you in the same place.`,
        ],
      },
      {
        heading: 'Dashboard at a glance',
        paragraphs: [
          'The header shows the account you are signed in as. If the chip reads Coach, you are in the right place. Three tiles below it are everything you need to glance at on a normal day — how many clients you have, how many messages are waiting, and whether billing is healthy.',
        ],
      },
      {
        heading: 'Roster and a single client',
        paragraphs: [
          'Roster is the source of truth for who is on your books. Each row links to a thread. The thread is a conversation, with read markers on both sides, so you can see at a glance whether your last message has been opened.',
        ],
      },
      {
        heading: 'Send a message',
        paragraphs: [
          'Sending is instant. The client gets a push notification on their phone. If you save a draft instead of sending, it stays attached to the thread; you can come back to it from any device.',
        ],
      },
      {
        heading: 'Invite link',
        paragraphs: [
          'Your invite link does not change between clients. Copy it once, send it to whoever you want to bring on. If you ever need to retire the current link, Rotate generates a new one and makes the old one stop working.',
        ],
      },
      {
        heading: 'Settings and billing',
        paragraphs: [
          'Billing lives in Stripe. The console shows the current status and a button into the Stripe portal, where you can update a card, see invoices, or cancel. If billing ever lapses, this tile is the first place to look.',
        ],
      },
    ],
  };
}

function faqContent(): HelpPageContent {
  return {
    title: 'Frequently asked questions — The Growth Project',
    headline: 'Frequently asked questions',
    intro:
      'Short answers to the questions coaches ask most often. Each answer ' +
      'is one paragraph. If a question needs more, it has its own page.',
    qaSections: [
      {
        heading: 'Account and access',
        items: [
          {
            question: 'Why does my account say Client instead of Coach?',
            answer:
              'Promotion to coach is manual at sign-up. Reply to your welcome email and we will promote it within one business day.',
          },
          {
            question:
              'I signed in with the wrong provider — can I switch from Google to Apple?',
            answer:
              'The provider is part of your identity in our system, so the two sign-ins map to two separate accounts. If you signed up with the wrong one, write in via the Contact page and we will merge the accounts.',
          },
          {
            question: 'Can two people share one coach account?',
            answer:
              'No. Each coach is one human. If you have an assistant or co-coach, they need their own account, which we can promote to coach access on your roster.',
          },
        ],
      },
      {
        heading: 'Clients and invites',
        items: [
          {
            question: 'Does my invite link expire?',
            answer: 'No. The default link is permanent until you rotate it.',
          },
          {
            question: 'How many clients can I invite?',
            answer:
              'There is no fixed limit. Performance starts to degrade in the console only past several hundred active threads, which is well beyond a typical coaching practice.',
          },
          {
            question: 'A client signed up with the wrong coach. Can I take them over?',
            answer:
              'Not by sending a new invite. The client has to delete their account in the app and sign up again with your link. If that is not viable, write in.',
          },
          {
            question: 'Can I send a different invite link to different clients?',
            answer:
              'Yes, but it is rarely worth the bookkeeping. The default link already attaches every signup to you. Use a separate link only when you have a campaign-tracking reason.',
          },
        ],
      },
      {
        heading: 'Messaging and sessions',
        items: [
          {
            question: 'Are messages real-time?',
            answer:
              'Sends are instant; the client gets a push notification. The client sees a typing-style indicator only briefly — we do not stream keystrokes.',
          },
          {
            question: 'Can I schedule a message to send later?',
            answer:
              'Not yet. You can save a draft and send it manually when ready.',
          },
          {
            question: 'Are messages encrypted?',
            answer:
              'Yes, in transit and at rest. They are not end-to-end encrypted — operators can read them in the course of a support investigation, under the same audit log that covers every other read of client data.',
          },
          {
            question: 'The client says they did not receive my message.',
            answer:
              'First confirm the message shows as delivered in the thread. If it does, the message reached our servers and the client device. If push notifications are silent on their side, that is almost always a phone-side notification setting; have them open the app to see the message.',
          },
        ],
      },
      {
        heading: 'Billing',
        items: [
          {
            question: 'My billing status is past due. Why?',
            answer:
              'A charge failed. Open Settings → Billing → Manage in Stripe and update the card. The system retries automatically; you do not need to write in unless the retries also fail.',
          },
          {
            question: 'I am on past-due status — can I still message clients?',
            answer:
              'You have a seven-day grace window after the failed charge. After that, message sends are blocked until billing is restored.',
          },
          {
            question: 'Where do I get an invoice?',
            answer:
              'Stripe portal, accessible from Settings → Billing → Manage in Stripe. Every paid month is downloadable as a PDF.',
          },
        ],
      },
      {
        heading: 'Data',
        items: [
          {
            question: 'Can I export my client data?',
            answer:
              'A client can export their own data from the mobile app. A coach cannot bulk-export client data — that is a privacy decision, not a gap. If you need a specific record for a legal or medical reason, write in.',
          },
          {
            question: 'A client deleted their account. Where did they go?',
            answer:
              'They are gone from your roster and their data is in a thirty-day soft-delete window before permanent removal. Within that window the deletion can be reversed if the client requests it. After thirty days, recovery is not possible.',
          },
        ],
      },
      {
        heading: 'Other',
        items: [
          {
            question: 'Is there a coach app, or is the console web-only?',
            answer:
              'The coach surface is web-only today. The mobile app is the client surface. Some coach functions are also available inside the mobile app for coaches who prefer it.',
          },
          {
            question: 'How do I report a bug?',
            answer: 'See the Contact page.',
          },
        ],
      },
    ],
  };
}

function supportContent(): HelpPageContent {
  return {
    title: 'What support covers — The Growth Project',
    headline: 'What support covers',
    intro:
      'This page is the contract between you and our support team. It is ' +
      'written flatly so there is no ambiguity at the moment a coach is ' +
      'deciding whether to write in.',
    sections: [
      {
        heading: 'In scope',
        paragraphs: ['We respond to, and own, the following:'],
        bullets: [
          `The platform is down or returning errors. Confirm at ${STATUS_URL} first; if the status page is green and you are still seeing failures, write in.`,
          'A client cannot complete sign-up after tapping a valid invite link.',
          'A billing charge failed and Stripe is showing a state that does not match what your console shows.',
          'Data we hold is wrong (a client appears in the wrong roster, a message is missing, a profile field will not save).',
          'A security or privacy concern of any kind. These get same-day attention.',
          'Account merge requests (you signed up with the wrong provider) and account-deletion reversals within the thirty-day soft-delete window.',
        ],
      },
      {
        heading: 'Out of scope',
        paragraphs: [
          'We do not provide help with the following. The list is firm — we will redirect rather than try to help:',
        ],
        bullets: [
          'Coaching methodology, programming, or business strategy. The platform is a tool; the practice is yours.',
          'Tax, legal, or accounting advice, including questions about how to handle invoices, contracts, or jurisdiction-specific regulations.',
          'Marketing your services. We do not write copy, run ads, or consult on positioning.',
          'Personalised configuration of third-party services (your Stripe account, your domain, your email signature).',
          'Health or medical advice for a client, even hypothetically.',
          'Performance complaints attributable to the client device or network. We will help confirm whether the issue is on our side; beyond that, it is on the client IT setup.',
        ],
      },
      {
        heading: 'How fast we respond',
        paragraphs: ['Our response targets are deliberately narrow:'],
        bullets: [
          'Same business day for security, privacy, billing-blocked, and platform-down reports.',
          'Within two business days for everything else in scope.',
        ],
      },
      {
        heading: 'When to use the status page instead of writing in',
        paragraphs: [
          `Before you write in for anything that smells like an outage — errors on every action, blank screens, slow loads across the board — check ${STATUS_URL}. If an incident is posted there, we are already aware. Writing in adds noise without speeding the fix. Writing in is the right move when the status page is green and you are still seeing the problem; that gap is information we want.`,
        ],
      },
    ],
    footnote:
      'We do not run a 24/7 desk. There is no on-call line. The status page is updated by an on-call engineer when an incident is open.',
  };
}

function contactContent(): HelpPageContent {
  return {
    title: 'Contact support — The Growth Project',
    headline: 'Contact support',
    intro:
      `Write to ${SUPPORT_EMAIL}. Email is the canonical transport. Read ` +
      'What support covers first — the fastest support reply is the one ' +
      'that fits a request we can actually answer.',
    checklist: {
      heading: 'What to include',
      bullets: [
        'Account email. The address on your coach account. If you signed in with Apple hidden-relay address, send the relay address — it is what we look up by.',
        'What you were trying to do. One sentence. "Send my first invite", "open the billing portal", "see a client thread".',
        'What actually happened. One or two sentences. Include the exact error text if there was one.',
        'When it happened. Approximate time and timezone is fine. We use it to find the request in the logs.',
        'Screenshots, if a UI is involved. Crop to the relevant region; we do not need the whole desktop.',
        'A client account email, if the issue involves them. Only share an email; do not share their password, payment details, or health information.',
      ],
    },
    intakeTable: {
      heading: 'Intake schema',
      intro:
        'For operators or vendors building a contact form against this inbox in the future, the canonical intake fields are listed below. There is no separate API endpoint today; email is the transport.',
      fields: [
        {
          name: 'account_email',
          type: 'email',
          required: 'yes',
          notes: 'Coach account email or Apple relay address.',
        },
        {
          name: 'category',
          type: 'enum',
          required: 'yes',
          notes:
            'One of: outage, billing, client_signup, data, security, account_merge, other.',
        },
        {
          name: 'subject',
          type: 'string',
          required: 'yes',
          notes: 'Free-form, up to 120 characters.',
        },
        {
          name: 'body',
          type: 'string',
          required: 'yes',
          notes: 'Free-form. Plain text is fine; markdown is rendered.',
        },
        {
          name: 'client_email',
          type: 'email',
          required: 'no',
          notes: 'Set only when the issue is about a specific client.',
        },
        {
          name: 'attachments',
          type: 'file[]',
          required: 'no',
          notes:
            'Up to 5 files, 10 MB each. Images, PDFs, plain text only.',
        },
        {
          name: 'console_url',
          type: 'string',
          required: 'no',
          notes: 'The URL the coach was on when the issue happened.',
        },
        {
          name: 'user_agent',
          type: 'string',
          required: 'no',
          notes:
            'Auto-filled by the form, useful for browser-specific issues.',
        },
        {
          name: 'ts_iso',
          type: 'datetime',
          required: 'yes',
          notes: 'ISO-8601 client timestamp, auto-filled.',
        },
      ],
    },
    sections: [
      {
        heading: 'What not to send',
        paragraphs: ['A few items we will never need and cannot use:'],
        bullets: [
          'Passwords. We will never ask, and we cannot use them.',
          'Card numbers. Card management lives in the Stripe portal.',
          'Personal health information that the client did not consent to share with us. Coach-client conversations can stay between you and your client; support does not need them to investigate account or platform issues.',
        ],
      },
      {
        heading: 'Response expectations',
        paragraphs: [
          'See the SLAs on What support covers. If you have not heard back within the stated window, reply to your own thread — do not open a second one. Replies bump priority; new threads start from the back.',
        ],
      },
    ],
    footnote:
      'There is no chat or phone line. Email is the only support channel today; if and when a form or in-app channel is added, this page will say so.',
  };
}

export function renderHelpPage(page: HelpPage): string {
  const content =
    page === 'index'
      ? indexContent()
      : page === 'setup'
        ? setupContent()
        : page === 'first-client'
          ? firstClientContent()
          : page === 'tour'
            ? tourContent()
            : page === 'faq'
              ? faqContent()
              : page === 'support'
                ? supportContent()
                : contactContent();
  return baseDocument(page, content);
}

function baseDocument(active: HelpPage, c: HelpPageContent): string {
  const title = escapeHtml(c.title);
  const headline = escapeHtml(c.headline);
  const intro = escapeHtml(c.intro);
  const reviewed = escapeHtml(HELP_LAST_REVIEWED);
  const supportEmail = escapeHtml(SUPPORT_EMAIL);
  const supportEmailHref = escapeAttr(`mailto:${SUPPORT_EMAIL}`);

  const sections = (c.sections ?? []).map(renderSection).join('\n');
  const qaSections = (c.qaSections ?? []).map(renderQASection).join('\n');
  const checklist = c.checklist ? renderChecklist(c.checklist) : '';
  const intakeTable = c.intakeTable ? renderIntakeTable(c.intakeTable) : '';
  const footnote = c.footnote
    ? `\n  <p class="footnote">${escapeHtml(c.footnote)}</p>`
    : '';

  const nav = NAV_ENTRIES.map((entry) => {
    const cls = entry.slug === active ? 'nav-link active' : 'nav-link';
    return `<a class="${cls}" href="${escapeAttr(entry.path)}">${escapeHtml(entry.label)}</a>`;
  }).join('');

  const body = [checklist, intakeTable, qaSections, sections]
    .filter((part) => part.length > 0)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #FBF8F3; color: #1F1B16; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; min-height: 100vh; padding: 32px 20px 64px; }
  main { max-width: 760px; width: 100%; margin: 0 auto; text-align: left; }
  header.brand { display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; gap: 16px; flex-wrap: wrap; }
  header.brand .wordmark { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 18px; letter-spacing: 0.02em; color: #1F1B16; text-decoration: none; }
  nav.help-nav { display: flex; gap: 16px; flex-wrap: wrap; }
  nav.help-nav .nav-link { color: #8A7F6E; text-decoration: none; font-size: 14px; }
  nav.help-nav .nav-link.active { color: #1F1B16; }
  nav.help-nav .nav-link:hover { color: #1F1B16; }
  h1 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 40px; line-height: 1.1; letter-spacing: -0.01em; margin: 0 0 8px 0; }
  p.reviewed { margin: 0 0 28px 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #8A7F6E; }
  p.intro { font-size: 18px; line-height: 1.6; margin: 0 0 36px 0; color: #3A332B; }
  section { margin: 0 0 32px 0; }
  section h2 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 22px; line-height: 1.3; margin: 0 0 12px 0; color: #1F1B16; }
  section h3 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 17px; line-height: 1.35; margin: 18px 0 6px 0; color: #1F1B16; }
  section p { font-size: 16px; line-height: 1.6; margin: 0 0 12px 0; color: #3A332B; }
  section ul { margin: 0 0 12px 0; padding: 0 0 0 20px; }
  section li { font-size: 16px; line-height: 1.6; margin: 0 0 6px 0; color: #3A332B; }
  table.intake { border-collapse: collapse; width: 100%; margin: 0 0 12px 0; font-size: 14px; }
  table.intake th, table.intake td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #E8E1D4; vertical-align: top; color: #3A332B; }
  table.intake th { font-weight: 600; color: #1F1B16; background: #F4EFE6; }
  p.footnote { margin: 40px 0 0 0; font-size: 13px; line-height: 1.55; color: #8A7F6E; font-style: italic; }
  footer.brand-footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #E8E1D4; font-size: 13px; color: #8A7F6E; display: flex; gap: 16px; flex-wrap: wrap; justify-content: space-between; }
  footer.brand-footer a { color: #8A7F6E; text-decoration: underline; }
</style>
</head>
<body>
<main>
  <header class="brand">
    <a class="wordmark" href="/">The Growth Project</a>
    <nav class="help-nav">${nav}</nav>
  </header>
  <h1>${headline}</h1>
  <p class="reviewed">Last reviewed ${reviewed}</p>
  <p class="intro">${intro}</p>
${body}${footnote}
  <footer class="brand-footer">
    <span>The Growth Project</span>
    <span><a href="${supportEmailHref}">${supportEmail}</a></span>
  </footer>
</main>
</body>
</html>`;
}

function renderSection(s: RenderedSection): string {
  const heading = escapeHtml(s.heading);
  const paragraphs = s.paragraphs
    .map((p) => `    <p>${escapeHtml(p)}</p>`)
    .join('\n');
  const bullets =
    s.bullets && s.bullets.length > 0
      ? '\n    <ul>\n' +
        s.bullets.map((b) => `      <li>${escapeHtml(b)}</li>`).join('\n') +
        '\n    </ul>'
      : '';
  return `  <section>
    <h2>${heading}</h2>
${paragraphs}${bullets}
  </section>`;
}

function renderQASection(s: RenderedQASection): string {
  const heading = escapeHtml(s.heading);
  const items = s.items
    .map(
      (qa) =>
        `    <h3>${escapeHtml(qa.question)}</h3>\n    <p>${escapeHtml(qa.answer)}</p>`,
    )
    .join('\n');
  return `  <section>
    <h2>${heading}</h2>
${items}
  </section>`;
}

function renderChecklist(c: { heading: string; bullets: string[] }): string {
  const heading = escapeHtml(c.heading);
  const bullets = c.bullets
    .map((b) => `      <li>${escapeHtml(b)}</li>`)
    .join('\n');
  return `  <section>
    <h2>${heading}</h2>
    <ul>
${bullets}
    </ul>
  </section>`;
}

function renderIntakeTable(t: {
  heading: string;
  intro: string;
  fields: ContactField[];
}): string {
  const heading = escapeHtml(t.heading);
  const intro = escapeHtml(t.intro);
  const rows = t.fields
    .map(
      (f) =>
        `      <tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.type)}</td><td>${escapeHtml(f.required)}</td><td>${escapeHtml(f.notes)}</td></tr>`,
    )
    .join('\n');
  return `  <section>
    <h2>${heading}</h2>
    <p>${intro}</p>
    <table class="intake">
      <thead>
        <tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
