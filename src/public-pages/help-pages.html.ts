// Durable, server-rendered self-serve help surface: /help, /help/setup,
// /help/first-client, /help/tour, /help/faq, /help/support, /help/contact,
// /help/delete-account (public account-deletion page for Google Play).
//
// These pages are the public, no-vendor coach-facing help destination.
// Current copy lives below; docs/help contains summaries and support notes.
// Content is rendered as static
// HTML in the same quiet-luxury aesthetic as the trust pages so the public
// surface (https://app.trygrowthproject.com/...) reads as one product.
//
// Editorial guard rails:
//
//  - Plain prose. No emoji, no marketing exclamation, no AI fingerprints.
//  - No placeholders, TODO/FIXME, or "coming soon" copy. If a feature does
//    not exist today, we either omit it or describe the current reality.
//  - Tokens (SUPPORT_EMAIL, INVITE_BASE_URL, STATUS_URL)
//    are sourced from a single substitution map; never hardcoded inline.
//    SUPPORT_EMAIL is reused from trust-pages.html so there is exactly one
//    place in the codebase that names the operator's mailbox.
//  - The contact page is a structured intake spec, not a working form.
//    Email is the canonical transport (per docs/help/contact-support.md);
//    no third-party form vendor or new mail provider is introduced.
//
// Mounted outside the /api prefix in main.ts so they resolve as bare paths
// under the public hostname.

import {
  ANTHROPIC_RETENTION_TEXT,
  APPLE_SIGN_IN_SUPPORT_LINK,
  CLOSED_ACCOUNT_RECORD_TEXT,
  CONSUMER_HEALTH_POLICY_PATH,
  DEIDENTIFIED_TEXT,
  DELETE_ACCOUNT_HELP_PATH,
  ONE_WAY_CODE_TEXT,
  PRIVACY_POLICY_PATH,
  SIGN_IN_WITH_APPLE_DELETION_TEXT,
  SUPPORT_EMAIL,
  policyFooterLinks,
  safeHref,
} from './trust-pages.html';

// Re-export for tests and any future caller that expects to find the
// support address on the help module.
export { SUPPORT_EMAIL } from './trust-pages.html';

// Last-reviewed date for the help copy. Bump on substantive edits so the
// freshness signal at the top of each page reflects reality.
export const HELP_LAST_REVIEWED = '2026-10-07';

// Token defaults align with the staging/production hostnames described in
// docs/help/_tokens.md. The renderer never invents values that depend on
// per-deployment secrets — it just substitutes in copy that already names
// real public URLs the operator can verify.
const INVITE_BASE_URL = 'https://app.trygrowthproject.com/join';
const STATUS_URL = 'https://app.trygrowthproject.com/status';

export type HelpPage =
  'index' | 'setup' | 'first-client' | 'tour' | 'faq' | 'support' | 'contact' | 'delete-account';

// App name (operator, 2026-10-01) and developer name for the Google Play
// listing; the account-deletion page must name both (Play "Data deletion").
// The developer name is the company name the policies use; the owner must
// confirm it matches the Play Console developer name exactly.
export const PLAY_APP_NAME = 'TGP Fitness';
export const PLAY_DEVELOPER_NAME = 'The Growth Project';

// Subject line we ask people to use for an emailed deletion request.
export const DELETION_EMAIL_SUBJECT = 'Delete my account';

interface RenderedSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  // Optional paragraphs rendered after the bullets.
  closing?: string[];
  // Optional links rendered last (site-relative, mailto: or https: only).
  links?: ReadonlyArray<{ label: string; href: string }>;
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
  { slug: 'delete-account', label: 'Delete account', path: DELETE_ACCOUNT_HELP_PATH },
];

function indexContent(): HelpPageContent {
  return {
    title: 'Help — The Growth Project',
    headline: 'Help',
    intro:
      'A guide to coaching in The Growth Project mobile app. ' +
      'Each page below answers one question. Read them in order ' +
      'the first time, then keep them as a reference.',
    sections: [
      {
        heading: 'Where to start',
        paragraphs: [
          'Start with setup, then send an invite and explore the coach tabs in the app.',
        ],
        bullets: [
          'Setup checklist — account setup, Stripe payouts, packages, invites, programs and booking hours.',
          'Invite your first client — what to send, what the client sees, and how to confirm they landed.',
          'Coach app tour — Overview, Clients, Programs, Messages and Settings.',
        ],
      },
      {
        heading: 'When something goes wrong',
        paragraphs: [
          'The next three pages are the ones to open when a question or an issue arises rather than when you are still onboarding.',
        ],
        bullets: [
          'Frequently asked questions — short answers to the questions coaches ask most often.',
          'What support covers — which issues to send to support.',
          'Contact support — what to include in a message so the first reply is the useful one.',
        ],
      },
      {
        heading: 'Your account',
        paragraphs: [
          'Delete account explains deletion in the app or by email, which records are removed or retained, and how long it takes.',
        ],
        links: [{ label: 'Delete your account', href: DELETE_ACCOUNT_HELP_PATH }],
      },
      {
        heading: 'How this content is maintained',
        paragraphs: [
          'These pages are versioned alongside the application. The last-reviewed date at the top of each page reflects when the copy was last edited.',
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
      'Set up coaching in The Growth Project mobile app. Ordinary coach tools do not require a coach subscription. ' +
      'Stripe setup is for receiving client payments, not buying access to coach tools.',
    sections: [
      {
        heading: '1. Create a coach account in the app',
        paragraphs: [
          'Choose the coach option when creating an account. Sign in to an existing coach account with the sign-in method used to create it. If the account opens as a client instead, contact support before creating another account.',
        ],
      },
      {
        heading: '2. Complete setup and connect Stripe',
        paragraphs: [
          'The coach setup wizard covers practice basics, Get paid, a first package and an invite. Steps left for later can be opened from the checklist on Overview.',
          'To accept client payments, open Overview → Get paid or Settings → Payouts (Stripe Connect). Complete the details Stripe requests, then check the payment and payout status shown in the app. Free packages work without Stripe.',
        ],
      },
      {
        heading: '3. Create your first package',
        paragraphs: [
          'Create a package in the setup wizard, from the Overview checklist, or in Settings → Packages. Give it a name and review its price and included coaching before publishing.',
          'Settings → Packages supports one-time and recurring packages. Client package payments are separate from access to coach tools.',
        ],
      },
      {
        heading: '4. Share an invite link or code',
        paragraphs: [
          `Open Invite your first client on the Overview checklist to copy or share a link. Or open Clients → Invite or Settings → Invite Codes to create and share a code. Invite links use ${INVITE_BASE_URL}/ followed by the code.`,
          'Send the complete link and code to one client. After installing the app, the client should open the invite link again or enter the code when creating an account. Confirm they appear in Clients.',
        ],
      },
      {
        heading: '5. Build and assign a program',
        paragraphs: [
          'Open Programs to build a training program and assign it to a client. Settings → Workout Builder opens the workout-plan editor. Open the client in Clients to review their training and meal plan.',
        ],
      },
      {
        heading: '6. Set booking hours and appointment types',
        paragraphs: [
          'Open Settings → Availability to set weekly booking hours. Settings → Appointment Types sets the sessions clients can book. Use Time Off for dates that should not be available, and Booking Inbox to review requests.',
        ],
      },
      {
        heading: 'You are done when',
        paragraphs: ['Setup is complete when:'],
        bullets: [
          'The coach tabs are available in the app.',
          'The package intended for clients is published.',
          'A client has joined and appears in Clients.',
          'A program is assigned and booking hours match the coaching offered.',
          'For paid packages, the Stripe status confirms client payments can be accepted.',
        ],
      },
    ],
    footnote:
      'For help with a setup problem, open Contact support and include the screen and the message shown.',
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
        paragraphs: ['Start in the coach mobile app:'],
        bullets: [
          'Open Invite your first client on Overview to copy or share the setup link.',
          'For a new code, open Clients → Invite or Settings → Invite Codes. Review any expiry or use limit before sharing.',
          'If offering a paid package, check Settings → Packages and Payouts (Stripe Connect). Inviting and messaging do not require a coach subscription.',
        ],
      },
      {
        heading: 'Send the link',
        paragraphs: [
          `Send the complete link and its code by text, email or another channel used with the client. The link uses ${INVITE_BASE_URL}/ followed by the code.`,
          'Explain that the client needs The Growth Project mobile app and should use the invite to join the correct coach.',
        ],
      },
      {
        heading: 'What the client sees',
        paragraphs: [
          'The link can open the installed app or a browser page. The browser page shows the coach name, business name when set, invite code and app-opening or download instructions for the device.',
        ],
        bullets: [
          'With the app installed, open the invite on the phone and follow the join instructions in the app.',
          'Without the app, follow the download instructions. After installing, open the invite link again or enter the code when creating an account. Do not assume the install will keep the code.',
        ],
      },
      {
        heading: 'Confirm they landed',
        paragraphs: [
          'Open Clients in the coach app after the client completes the join flow. If the client is missing, check:',
        ],
        bullets: [
          'Did they receive the complete link and code?',
          'Did they open the invite again after installing, or enter the code in the app?',
          'Did they finish creating or signing in to the account and joining the coach?',
        ],
      },
      {
        heading: 'Common first-invite snags',
        paragraphs: ['Check the message shown before sending another invite:'],
        bullets: [
          'Invite unavailable: check that the code is active and has not expired, been revoked or reached its use limit. Share an active code from Invite Codes.',
          'Missing code after install: send the original link and ask the client to reopen it or enter the code.',
          'Already linked to another coach: a new invite does not transfer that relationship. Contact support about the existing account rather than asking the client to delete it.',
          'Sign-in does not finish: note the sign-in method and the message shown, then contact support if the client cannot continue.',
        ],
      },
      {
        heading: 'After the first invite',
        paragraphs: [
          'Open the client in Clients to review their details, assign training or a meal plan, and open their conversation. Messages also lists client conversations. Share an active invite for the next client.',
        ],
      },
    ],
  };
}

function tourContent(): HelpPageContent {
  return {
    title: 'Coach app tour — The Growth Project',
    headline: 'Coach app tour',
    intro:
      'Coach tools are in The Growth Project mobile app. Sign in with a coach account, ' +
      'then use the tabs below for daily coaching.',
    sections: [
      {
        heading: 'Overview',
        paragraphs: [
          'Overview brings together the setup checklist and coaching activity. Use Get paid, Create your first package and Invite your first client to finish any setup left for later.',
        ],
      },
      {
        heading: 'Clients',
        paragraphs: [
          'Clients lists the people linked to the coach. Open a client to review their consultation and logs, manage training and meal plans, or open their conversation. Invite opens the invite-code screen.',
        ],
      },
      {
        heading: 'Programs',
        paragraphs: [
          'Programs is the training-program library. Build and edit programs, then assign them to clients. Settings → Workout Builder opens the workout-plan editor.',
        ],
      },
      {
        heading: 'Messages',
        paragraphs: [
          'Messages lists client conversations. Open a conversation to read and send messages. If a send fails, follow the message shown in the app. Phone notifications depend on notification permissions and settings.',
        ],
      },
      {
        heading: 'Settings',
        paragraphs: [
          'Settings contains Packages, Payouts (Stripe Connect), Money, Invite Codes, Availability, Appointment Types, Time Off and Booking Inbox. Help centre and Contact support are also available here.',
        ],
      },
      {
        heading: 'Client payments are separate',
        paragraphs: [
          'Ordinary coach tools do not require a coach subscription. Packages define what clients buy; Stripe Connect handles client payments and coach payouts. Open Settings → Money to review earnings and payouts.',
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
            question: 'Why does an account say Client instead of Coach?',
            answer:
              'New accounts can choose the coach option during sign-up. If an existing account opens as a client, confirm the sign-in method and contact support before creating another account.',
          },
          {
            question: 'What happens when a different sign-in method is used?',
            answer:
              'Use the sign-in method used to create the account. If another method opens an unexpected account, contact support with the methods used and the screen shown.',
          },
          {
            question: 'Can two people share one coach account?',
            answer:
              'Each person should use their own account. Do not share sign-in credentials.',
          },
        ],
      },
      {
        heading: 'Clients and invites',
        items: [
          {
            question: 'Can an invite code expire?',
            answer: 'Invite Codes supports expiry dates and use limits. Check the code status before sharing it. A revoked, expired or fully used code needs to be replaced with an active code.',
          },
          {
            question: 'Where are client invitations?',
            answer:
              'Open Clients → Invite or Settings → Invite Codes to create and share codes. The Overview setup checklist also opens the first-client share link.',
          },
          {
            question: 'Can an invite move a client from another coach?',
            answer:
              'A new invite does not transfer an existing coach relationship. Contact support about the account rather than asking the client to delete it.',
          },
          {
            question: 'Can different clients receive different invite codes?',
            answer:
              'Yes. Create codes in Invite Codes and review any expiry date or use limit for each one.',
          },
        ],
      },
      {
        heading: 'Messaging and sessions',
        items: [
          {
            question: 'Are messages real-time?',
            answer:
              'Read and send messages in the mobile app. Notifications depend on phone permissions and settings; open the conversation to check for messages.',
          },
          {
            question: 'Can a message be scheduled to send later?',
            answer: 'Message scheduling is not available in the app. A message is sent when Send is tapped.',
          },
          {
            question: 'What information should stay out of messages?',
            answer:
              'Do not send passwords, sign-in codes or full payment-card details. Use Contact support for an account or security problem.',
          },
          {
            question: 'A client has not seen a message. What should be checked?',
            answer:
              'Check the conversation for a send failure. Ask the client to open the app and the conversation, then check phone notification permissions if alerts are missing. Contact support if the message still cannot be found.',
          },
        ],
      },
      {
        heading: 'Client payments and payouts',
        items: [
          {
            question: 'Is a coach subscription required?',
            answer:
              'Ordinary coach tools do not require a coach subscription. Inviting and messaging clients are not blocked by a coach-software subscription. Paid client packages, including recurring packages, are separate and still require client payment.',
          },
          {
            question: 'How are client payments set up?',
            answer:
              'Open Overview → Get paid or Settings → Payouts (Stripe Connect), complete the details Stripe requests and check the status shown. Create and publish the package in Settings → Packages.',
          },
          {
            question: 'Where are earnings and payouts?',
            answer:
              'Open Settings → Money for earnings and payout information. Settings → Payouts (Stripe Connect) opens the connected-account payment and payout controls, not a coach-subscription checkout.',
          },
        ],
      },
      {
        heading: 'Data',
        items: [
          {
            question: 'Can a coach bulk-export client data?',
            answer:
              'The coach app does not offer a bulk client-data export. Clients can export their own data from the mobile app. Contact support about a specific record needed for a legal or medical reason.',
          },
          {
            question: 'What happens when a client deletes their account?',
            answer:
              'During the 14-day grace period they stay on your roster and can cancel the deletion in the app. When it ends, they leave your roster and their data is permanently deleted and cannot be recovered.',
          },
        ],
      },
      {
        heading: 'Other',
        items: [
          {
            question: 'Is there a coach app?',
            answer:
              'Coach tools are available in The Growth Project mobile app. Sign in with a coach account to manage clients, messages, training programs, coaching packages and availability.',
          },
          {
            question: 'How is a bug reported?',
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
          'Account merge requests (you signed up with the wrong provider) and questions about a pending account deletion. A deletion can be cancelled in the app during its 14-day grace period; once it is complete it cannot be reversed.',
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
          notes: 'One of: outage, billing, client_signup, data, security, account_merge, other.',
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
          notes: 'Up to 5 files, 10 MB each. Images, PDFs, plain text only.',
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
          notes: 'Auto-filled by the form, useful for browser-specific issues.',
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
      `In the app, open Settings, then Support to use the in-app support chat when it is available. You can also email ${SUPPORT_EMAIL}, including when chat cannot open. There is no phone line.`,
  };
}

// ---------------------------------------------------------------------------
// /help/delete-account — Google Play account-deletion page.
//
// Public, no login. Every fact here comes from code or the published policy:
//  - Current in-app path (client: profile tab > Settings >
//    Account > Delete account; coach: Settings tab > Privacy & Data >
//    Delete my account; DeleteAccountScreen re-auth and "Keep my account").
//  - 14-day grace + nightly finalization within a day: backend #608
//    src/account-deletion/account-deletion.service.ts (graceDays default 14,
//    FINALIZE_WINDOW_MS one day); admin force-delete has no grace period.
//  - Deleted vs kept: #608 account-deletion.manifest.ts / README "Operator
//    policy" and #313 PERMANENTLY_DELETED / KEPT_RECORDS / BILLING_NOTE.
//  - Roman kept until deleted (owner OR-110-1), backups six months, 30-day reply, 45 days for consumer
//    health data: the Privacy Policy and Consumer Health Data Privacy Policy
//    (./trust-pages.html.ts).
// Ships with #608/#313: do not publish before that behaviour is live.
// ---------------------------------------------------------------------------
function deleteAccountContent(): HelpPageContent {
  return {
    title: `Delete your ${PLAY_APP_NAME} account — ${PLAY_DEVELOPER_NAME}`,
    headline: 'Delete your account',
    intro:
      `How to delete your ${PLAY_APP_NAME} account and the data linked to it, ` +
      'in the app or by email if you no longer have the app. ' +
      `${PLAY_APP_NAME} is made by ${PLAY_DEVELOPER_NAME}.`,
    sections: [
      {
        heading: 'Delete your account in the app',
        paragraphs: [
          'You can delete your account yourself in the app. You do not need to email us.',
        ],
        bullets: [
          'If you are a client: open the profile tab (the person icon in the bottom bar), tap Settings, then under Account tap Delete account.',
          'If you are a coach: open the Settings tab, then under Privacy & Data tap Delete my account.',
          'Read what will be deleted and what we keep, type DELETE or your account email, then confirm it is you with your password, Sign in with Apple or Google, whichever you use to sign in.',
          'Your deletion is scheduled straight away and the app shows the date it becomes permanent. Until then you can open the same screen and tap Keep my account to cancel it.',
        ],
        // Same words as the Privacy Policy (B-611-17 / B-611-12).
        closing: [SIGN_IN_WITH_APPLE_DELETION_TEXT],
        links: [APPLE_SIGN_IN_SUPPORT_LINK],
      },
      {
        heading: 'Ask us by email if you do not have the app',
        paragraphs: [
          `Email ${SUPPORT_EMAIL} with the subject line “${DELETION_EMAIL_SUBJECT}”. So we can confirm the account is yours:`,
        ],
        bullets: [
          'Send it from the email address you use to sign in to the app.',
          'Include the name on the account and say whether you are a client or a coach.',
          'If you can no longer send from that address, tell us which address the account uses. We will email that address and delete nothing until you reply from it to confirm.',
          'We will never ask for your password, a card number or a sign-in code. Do not send them.',
        ],
        closing: [
          'You can also ask us to delete only some of your health data instead of your whole account. Say which data in the same email.',
          'Once we have confirmed the account is yours, we delete it straight away. There is no 14-day grace period for a deletion we carry out at your request, so it cannot be cancelled.',
        ],
        links: [
          {
            label: `Email ${SUPPORT_EMAIL}`,
            href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(DELETION_EMAIL_SUBJECT)}`,
          },
        ],
      },
      {
        heading: 'What we delete',
        paragraphs: ['When the deletion completes, we permanently delete or irreversibly scrub:'],
        bullets: [
          'Your sign-in account, name, email address and phone number',
          'Your profile, body measurements and consultation answers',
          'Food, water, fasting, weight and workout logs, check-ins and habits',
          'Health and activity data synced from Apple Health or connected devices, and bloodwork you entered, including uploaded files',
          'Your conversations with Roman, the AI assistant',
          'Your messages, community posts, comments, direct messages, voice notes and reactions',
          'Coach media, notes and briefs, if you coach',
          'Your targets, recipes, lists and preferences',
          'Notification settings and push notification tokens',
        ],
        closing: [
          'Any subscription or payment plan you have, as a client or as a coach, is cancelled when the deletion completes, and scheduled reminders and emails stop. Until then it stays active.',
        ],
      },
      {
        heading: 'What we keep, and for how long',
        paragraphs: [],
        bullets: [
          'Payment and tax records held by Stripe, our payment processor, for as long as the law requires. Our own copies keep only amounts, dates and payment references, with no name or contact details.',
          'One deletion record with a random reference, the date and the result. It holds no name, email or account details.',
          // B-611-10 (Opus): the same kept items as the Privacy Policy's
          // deletion paragraph and retention list, from shared strings.
          `Closed account: ${CLOSED_ACCOUNT_RECORD_TEXT}, so the payment records and logs that must be kept still point to one closed account. It is kept with no end date.`,
          `While removing your sign-in account at your sign-in provider is still being retried, that provider’s account ID is kept. Once it is removed, the account ID is replaced by ${ONE_WAY_CODE_TEXT}.`,
          'If you coach: your clients are not deleted. They keep their own data and the plans you assigned them, without your contact details, and are no longer linked to you.',
          'Backups: database backups and copies are never kept more than six months after a confirmed deletion request. Copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days.',
          'Security and audit logs: as long as needed to protect the service and meet legal duties.',
          `What Anthropic received: ${ANTHROPIC_RETENTION_TEXT}`,
          'Copies at service providers: error reports in Sentry are kept 90 days and email logs in Resend 30 days, and a deleted person is removed from PostHog product analytics within 30 days of the deletion.',
          `De-identified information: ${DEIDENTIFIED_TEXT}`,
        ],
      },
      {
        heading: 'How long it takes',
        paragraphs: [],
        bullets: [
          'In the app: a 14-day grace period starts when you confirm. When it ends, your data is deleted within one day, and the app shows the date.',
          'By email: we reply within 30 days of receiving your request. Requests about consumer health data under Washington law are answered within 45 days, as our Consumer Health Data Privacy Policy explains.',
          'Roman conversations: kept until you delete them or your account. When your account is deleted, they are deleted with it.',
        ],
        links: [
          { label: 'Privacy Policy', href: PRIVACY_POLICY_PATH },
          { label: 'Consumer Health Data Privacy Policy', href: CONSUMER_HEALTH_POLICY_PATH },
        ],
      },
    ],
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
                : page === 'contact'
                  ? contactContent()
                  : deleteAccountContent();
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
  const footnote = c.footnote ? `\n  <p class="footnote">${escapeHtml(c.footnote)}</p>` : '';

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
  section p.links a { color: #1F1B16; text-decoration: underline; }
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
    <span>${policyFooterLinks()}</span>
    <span><a href="${supportEmailHref}">${supportEmail}</a></span>
  </footer>
</main>
</body>
</html>`;
}

function renderSection(s: RenderedSection): string {
  const heading = escapeHtml(s.heading);
  const paragraphs = s.paragraphs.map((p) => `    <p>${escapeHtml(p)}</p>`).join('\n');
  const bullets =
    s.bullets && s.bullets.length > 0
      ? '\n    <ul>\n' +
        s.bullets.map((b) => `      <li>${escapeHtml(b)}</li>`).join('\n') +
        '\n    </ul>'
      : '';
  const closing = (s.closing ?? []).map((p) => `\n    <p>${escapeHtml(p)}</p>`).join('');
  const links =
    s.links && s.links.length > 0
      ? '\n    <p class="links">' +
        s.links
          .map((l) => `<a href="${escapeAttr(safeHref(l.href))}">${escapeHtml(l.label)}</a>`)
          .join(' · ') +
        '</p>'
      : '';
  return `  <section>
    <h2>${heading}</h2>
${paragraphs}${bullets}${closing}${links}
  </section>`;
}

function renderQASection(s: RenderedQASection): string {
  const heading = escapeHtml(s.heading);
  const items = s.items
    .map((qa) => `    <h3>${escapeHtml(qa.question)}</h3>\n    <p>${escapeHtml(qa.answer)}</p>`)
    .join('\n');
  return `  <section>
    <h2>${heading}</h2>
${items}
  </section>`;
}

function renderChecklist(c: { heading: string; bullets: string[] }): string {
  const heading = escapeHtml(c.heading);
  const bullets = c.bullets.map((b) => `      <li>${escapeHtml(b)}</li>`).join('\n');
  return `  <section>
    <h2>${heading}</h2>
    <ul>
${bullets}
    </ul>
  </section>`;
}

function renderIntakeTable(t: { heading: string; intro: string; fields: ContactField[] }): string {
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
