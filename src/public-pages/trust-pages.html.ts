// Durable, server-rendered "trust" pages: /privacy,
// /consumer-health-privacy, /terms, /security, /status. These exist as the public surface that app store reviewers and
// early customers expect to find at a real product domain. They share the
// quiet-luxury aesthetic of the invite landing and download pages so the
// public surface (https://app.trygrowthproject.com/...) reads as one
// product.
//
// Editorial guard rails:
//
//  - No fake legal language. We describe practical company practice and
//    note where formal legal review is recommended. The phrasing is meant
//    to satisfy app-review and early-trust needs, not to replace counsel.
//  - No fake certifications. We do NOT claim SOC 2, ISO 27001, HIPAA, or
//    any other audit we have not actually obtained. Where the absence
//    matters (e.g. certifications), we say so plainly.
//  - No AI fingerprints. Copy is human-written and concrete; no "as an
//    AI" disclaimers, no boilerplate hedging.
//  - Honest status reporting. /status describes the public surface area
//    that exists today and points at the operator email for incidents.
//    When a real monitoring integration is added, /status can be upgraded
//    to render live data without changing its URL contract.
//
// Mounted outside the /api prefix in main.ts so they resolve as bare
// paths under app.trygrowthproject.com.

// Source of truth for the official support contact (owner ruling
// 2026-10-01 14:19 PDT: one support email everywhere). Used in every trust,
// help and download page so a customer or reviewer always has a real human
// to email. test/support-email.guard.spec.ts fails if any other address is
// published as a support contact.
export const SUPPORT_EMAIL = 'Bradleyapple1031@gmail.com';

// Last-reviewed date for the policy text. Bump when copy changes.
// Format ISO-8601 (UTC) so it sorts and renders consistently.
export const POLICY_LAST_REVIEWED = '2026-10-07';

// Who sees community and leaderboard data (B-PRIVACY-1). Shared by /privacy
// "Who can see your data" and /consumer-health-privacy "Categories we share".
// Leaderboard rows are opt-in (show_on_leaderboard, default off) on both the
// legacy /community/leaderboard and /me/leaderboard reads.
export const COMMUNITY_VISIBILITY_TEXT =
  'Members of the community spaces you join can see your display name and the posts, comments, reactions, shared wins and group messages you choose to share in those spaces. Messages sent directly to your coach are not group messages.';
export const LEADERBOARD_VISIBILITY_TEXT =
  'If you opt in to a leaderboard, other clients assigned to the same coach can see your display name, rank and participation information, such as workout counts or a habit-consistency score and its change. The habit score uses check-in, workout, meal-log and coach-message activity, not the content of your private messages. You can opt out to hide your leaderboard entry.';

// Apple Guideline 1.2: word for word the sentence the in-app Community terms
// sheet shows before first Community use (mobile CommunityTermsGate).
export const COMMUNITY_ZERO_TOLERANCE_TEXT =
  'There is no tolerance for objectionable content or abusive users. Content that breaks these guidelines is removed, and the account that posted it can be removed.';

// Public paths of the two privacy documents. The mobile app links to the
// same paths (growth-project-mobile src/config/env.ts), so keep them stable.
export const PRIVACY_POLICY_PATH = '/privacy';
export const CONSUMER_HEALTH_POLICY_PATH = '/consumer-health-privacy';

// Public account-deletion page (Google Play: a web URL where anyone can ask
// for account and data deletion without installing the app). Linked from the
// Privacy Policy, the /help nav and the shared policy footer.
export const DELETE_ACCOUNT_HELP_PATH = '/help/delete-account';

// O-611-6 (owner 2026-10-03): de-identified data under RCW 19.373.010
// (reasonable measures, public commitment not to re-identify, recipients
// bound to the same). RCW 19.373.010 asks for a commitment to *process* the
// data only in de-identified form, so the text says "keep and use" (Opus
// C-611-15). Published on /privacy, /consumer-health-privacy and the
// "What we keep" list of /help/delete-account.
export const DEIDENTIFIED_TEXT =
  'After an account is deleted, de-identified, aggregated information that cannot identify the person may be kept. TGP takes reasonable measures so it cannot be linked to anyone, commits publicly to keep and use it only in de-identified form and never to try to re-identify it, and requires by contract anyone it shares it with to do the same.';

// O-611-2 (owner 2026-10-03): no zero-retention agreement with Anthropic.
// Published on /privacy (retention list), the consumer health "Deletion"
// section and the "What we keep" list of /help/delete-account.
export const ANTHROPIC_RETENTION_TEXT =
  'Anthropic deletes what it receives within 30 days, except where its usage policy or the law requires it to keep it longer.';

// What the deletion run keeps (backend #608): the tombstone User row and the
// sign-in receipt (src/account-deletion/deletion-receipt.ts,
// DELETION_RECEIPT_DAYS = 30). Shared by the owner-approved /privacy
// deletion paragraph and the /help/delete-account "What we keep" list so the
// two cannot drift (Opus B-611-10). Neither phrase uses first person.
export const CLOSED_ACCOUNT_RECORD_TEXT =
  'a closed-account record with no name, contact details or profile, holding only an internal account number, the account type and dates such as when the account was opened and closed';
export const ONE_WAY_CODE_TEXT =
  'a one-way code made from it, for 30 days, so the app can tell you the account was deleted if you sign in again; then the code is discarded';

// Sign in with Apple (operator 116 ruling on Opus RG-1, 2026-10-03): #608
// revokes the Apple token only when APPLE_TEAM_ID, APPLE_SIGNIN_KEY_ID and
// APPLE_SIGNIN_PRIVATE_KEY are set, and production does not have them yet
// (apple-token-revocation.service.ts returns not_configured). The policy
// states only what is true today: the deletion run removes the Supabase
// sign-in identity, which is the app's link to the Apple Account, and the
// person can remove the app from their Apple Account themselves. A follow-up
// restores the revocation sentence once the owner sets the key.
// The steps are Apple's (B-611-17 / B-611-12): Apple Support 102571
// (published 2026-09-14) gives iPhone Settings > [your name] > Sign in with
// Apple > app > Delete > confirm; Sign-In & Security is the account.apple.com
// web path only. Used word for word by /privacy and /help/delete-account.
// C-611-18 (agent 117): that iPhone path is the iOS 18 and later one (iPhone
// User Guide 18.0 and 26). The app supports iOS 16.4 and later, and iOS 16
// and 17 use a different menu under Settings > [your name] > Password and
// Security (iPhone User Guide 16.0 and 17.0), so the iPhone sentence says
// iOS 18 or later and earlier versions get the web steps, which do not
// depend on the iOS version.
export const APPLE_SIGN_IN_SUPPORT_URL = 'https://support.apple.com/en-us/102571';
export const APPLE_SIGN_IN_SUPPORT_LINK: Readonly<{ label: string; href: string }> = {
  label: 'Apple Support: Manage your apps with Sign in with Apple',
  href: APPLE_SIGN_IN_SUPPORT_URL,
};
export const SIGN_IN_WITH_APPLE_DELETION_TEXT =
  'If you used Sign in with Apple, deleting your account ends the app’s link to your Apple Account. ' +
  'To remove the app from your Apple Account as well, on an iPhone with iOS 18 or later open Settings, tap your name, then Sign in with Apple, choose the app, tap Delete and follow the steps on screen to confirm. ' +
  'On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose the app and stop using Sign in with Apple for it.';

export type TrustPage = 'privacy' | 'consumer-health' | 'terms' | 'security' | 'status';

// Order and labels of the header nav. Every trust page links to every other
// one, and the consumer health policy is always one click away (RCW
// 19.373.020 requires a prominent link).
const TRUST_NAV: ReadonlyArray<{ page: TrustPage; href: string; label: string }> = [
  { page: 'privacy', href: PRIVACY_POLICY_PATH, label: 'Privacy' },
  {
    page: 'consumer-health',
    href: CONSUMER_HEALTH_POLICY_PATH,
    label: 'Consumer Health Privacy',
  },
  { page: 'terms', href: '/terms', label: 'Terms' },
  { page: 'security', href: '/security', label: 'Security' },
  { page: 'status', href: '/status', label: 'Status' },
];

interface RenderedLink {
  label: string;
  // Site-relative path ("/privacy") or mailto:/https: URL. Anything else is
  // rendered as "#" by safeHref().
  href: string;
}

interface RenderedSection {
  heading: string;
  // Each paragraph is plain text; headings/paragraphs are escaped at render.
  paragraphs: string[];
  // Optional bulleted list rendered after the paragraphs.
  bullets?: string[];
  // Optional paragraphs rendered after the bullets.
  closing?: string[];
  // Optional links rendered last.
  links?: RenderedLink[];
}

interface TrustPageContent {
  title: string;
  headline: string;
  intro: string;
  sections: RenderedSection[];
  // Footer line shown above the company line.
  footnote?: string;
}

// ---------------------------------------------------------------------------
// Privacy Policy (/privacy)
//
// Accuracy rules for this copy (see README "Trust pages"):
//  - Describe only behaviour that ships in the app and backend. Features that
//    stay behind a default-off flag are described with "if enabled".
//  - Name every vendor that receives personal data, and only vendors that the
//    code actually calls.
//  - Never name the clinic partner. Say "clinic partner".
// ---------------------------------------------------------------------------
function privacyContent(): TrustPageContent {
  return {
    title: 'Privacy Policy — The Growth Project',
    headline: 'Privacy Policy',
    intro:
      'The Growth Project (“TGP”, “we”, “us”) provides personal-training ' +
      'software used by independent coaches and the people they coach, ' +
      'including Roman, an AI assistant inside the app. This policy explains ' +
      'what personal data we collect, where it comes from, why we use it, who ' +
      'receives it, how long we keep it and the choices you have. It describes ' +
      'the app as it works today; features that are switched on only for some ' +
      'accounts are marked “if enabled”. It is a company-drafted statement of ' +
      'practice, and counsel review is recommended.',
    sections: [
      {
        heading: 'Personal training only',
        paragraphs: [
          'TGP is a personal-training service. It is not a medical service, it does not diagnose or treat any condition, and nothing in the app, from Roman or from your coach is medical advice. We collect health and fitness information only to deliver personal training that you ask for.',
        ],
      },
      {
        heading: 'Consumer health data',
        paragraphs: [
          'Much of what you share with TGP is health information, for example your consultation answers, body measurements, food logs, sleep and heart-rate data. Our Consumer Health Data Privacy Policy describes that data, who receives it and how to exercise your rights over it, including the rights of Washington residents under the My Health My Data Act (RCW 19.373).',
        ],
        links: [
          {
            label: 'Read the Consumer Health Data Privacy Policy',
            href: CONSUMER_HEALTH_POLICY_PATH,
          },
        ],
      },
      {
        heading: 'What we collect',
        paragraphs: ['Depending on how you use TGP, we collect:'],
        bullets: [
          'Account and contact details — your name, email address (an Apple private relay address if you choose Hide My Email with Sign in with Apple), optional phone number, account role (client or coach), the invite code you used and the coach you are connected to. Passwords are handled by our authentication provider and are never stored in plain text.',
          'Identifiers — your TGP account ID, sign-in identifiers from Supabase, Apple or Google, and your device’s push-notification token.',
          'Consultation answers — your goal and why it matters, the sex used for nutrition formulas, date of birth, height, weight and goal weight, activity level, sleep, training experience and preferences, injuries, session length, training days and time, where you train and your equipment, how you eat, foods you avoid, meals per day, tracking history and what gets in the way, and your answers to the readiness questions (heart condition, chest pain, dizziness, bone or joint problems, medication, pregnancy or another reason) with any notes you add. We also store what we work out from them: your calorie and macro targets and the training plan you are assigned. Earlier versions of your answers are kept while your account exists.',
          'Coaching logs — meals and foods you log, macros, water, fasting, workouts (exercises, sets, reps, load and duration), check-ins (mood, energy, sleep and notes), habits, weight and progress entries.',
          'Apple Health or Health Connect data, only if you connect it — steps, active energy, heart rate, resting heart rate, heart-rate variability, VO2 max, workouts and distance, weight, body fat, blood pressure, sleep, blood-oxygen saturation, respiratory rate and body temperature, with the source, time and time zone of each reading. Apple Health is on iPhone; Health Connect is on Android. The app reads this data with your permission and sends it to our servers so you and your coach can see it; it does not write data back to Apple Health or Health Connect.',
          'Messages and community content — messages with your coach; posts, comments and reactions in the community spaces your coach runs, your space memberships and when you joined them; direct messages and voice notes if enabled; and reports and blocks you make.',
          'Roman conversations — what you write to Roman and Roman’s replies.',
          'Roman’s notes and summaries — short notes Roman keeps about your training, preferences and circumstances, from your Roman chats and from everything you log or connect in the app, as part of the Roman permission (see “Roman and AI” below).',
          'Payments — card details are entered into Stripe’s checkout and are collected by Stripe. We receive and store payment status, amounts, currency, the package or subscription purchased, refunds, invoices, billing email, and your card brand, last four digits and expiry month. For coaches we also store Stripe payout status and amounts, the bank name and last four digits of the payout account, and AI-credit balances and spending. We never receive or store full card or bank account numbers.',
          'Support — conversations in in-app support chat (provided by Crisp) together with your name, email, role, plan and account workspace, and emails you send us.',
          'Device, usage and diagnostic data — IP address, browser or device type, app version, request times and security logs; product analytics events and screen views linked to your account ID; and crash and performance reports linked to your account ID, with no name or email address attached.',
          'Food searches — the words you search for when logging food.',
        ],
      },
      {
        heading: 'Where it comes from',
        bullets: [
          'You, when you sign up, complete the consultation, log, message, post or contact support.',
          'Your phone’s Apple Health or Health Connect store, only after you grant permission in the app.',
          'Your coach, who sets your plan and targets and writes to you.',
          'Our own systems and Roman, which calculate targets, generate plans and replies, and record how the app is used.',
          'Apple or Google, when you sign in with them, and Stripe, which tells us whether a payment succeeded.',
          'Other members, when they reply to you or mention you in a community space.',
        ],
        paragraphs: [],
      },
      {
        heading: 'How we use it',
        bullets: [
          'To run your personal training: build your plan and targets, show your progress, and let you and your coach work together.',
          'To power Roman and your coach’s AI drafts about you, after you agree (see “Roman and AI” below).',
          'If you coach on TGP and the feature is on: to let Roman learn your coaching methods, so he answers your clients the way you coach (see “Roman and AI” below).',
          'To send the messages you expect: account emails, reminders and push notifications.',
          'To provide support, keep the service safe and secure, prevent abuse, moderate the community and fix problems.',
          'To understand, in aggregate, which parts of the app work and which do not.',
          'To process payments and coach payouts, and to meet legal, tax and accounting duties.',
        ],
        paragraphs: [],
        closing: [
          'We do not sell personal data. We do not use health data for advertising or marketing, we do not show third-party ads, and we do not track you across other companies’ apps or websites. We do not use your data to train AI models.',
          'Health and fitness data is never used for advertising or for data mining other than to improve health management, and is used for health research only with your permission.',
        ],
      },
      {
        heading: 'Who can see your data',
        bullets: [
          'You.',
          'Your coach, and any coach on their team who is assigned to you: your profile, consultation answers including readiness answers, targets and plan, logs, check-ins, connected health data and your messages with them. If any readiness answer is yes, your coach is told so they can adjust your training.',
          // B-PRIVACY-1 (after the leaderboard opt-in fix, b#747): community
          // spaces and the opt-in leaderboard. Same text on the health policy.
          `${COMMUNITY_VISIBILITY_TEXT} Coaches can sort the members of their spaces by when they joined.`,
          LEADERBOARD_VISIBILITY_TEXT,
          'Roman conversations are not visible to your coach, assistant coaches or any coach-facing screen. They are stored securely; TGP staff can access them only for support, safety and debugging.',
          'TGP staff, only when needed to provide support, keep people safe, fix problems, secure the service or meet a legal duty.',
          'The service providers listed below, only to run the service for us.',
        ],
        paragraphs: [],
        closing: [
          'Some coaches run programmes alongside a clinic partner. No account, consultation, coaching, health, wearable or Roman data is exchanged with any clinic partner, and clinic partners have no access to the app or to your data.',
        ],
      },
      {
        heading: 'Roman and AI',
        paragraphs: [
          'Roman is an AI assistant powered by Anthropic. At the start of the consultation the app shows two separate boxes on one screen. The first, which you need to tick to continue, covers the personal-training waiver and lets TGP and your coach collect and use your information to coach you. The second is optional and starts unticked: it lets Roman and your coach’s AI drafts use your information, names Anthropic as the AI provider and lists the data it receives. If you leave it unticked, nothing about you is sent to Anthropic, and your plan, your coach, the community and Roman’s guided tour work as usual.',
          'When you use Roman, we send Anthropic your message, the earlier turns of that conversation, and context drawn from your own account: your profile, consultation and readiness answers, food, water and habit logs, workouts and workout history, check-ins, bookings, wearable, health and sleep data, messages with your coach and the community posts you write. When your coach asks for an AI draft about you, the same kinds of data are sent. Roman may also read, and send to Anthropic, your fasting logs, your earlier Roman conversations that you have not deleted and daily summaries of your connected health data, including sleep stages, bedtime and wake time, body weight and body fat, and blood pressure. Roman never reads the raw heart-rate readings your device records. With Roman’s memory off, only your own data is used — never another client’s, and never your coach’s private notes about you.',
          'Roman’s memory is part of the Roman permission you give in the consultation, and it is on unless you turn it off. Roman keeps notes and summaries about your training, preferences and circumstances, from your Roman chats and from everything you log or connect in the app, to personalise his replies. Roman may also learn your coach’s methods, including from your coach’s private session notes, and information about your training may help with that without identifying you. Roman never quotes those notes or shows you another client’s information. Your coach never sees your conversations with Roman or his notes about you. You can turn Roman’s memory off at any time in Settings > Privacy > Roman and AI; Roman then stops using his notes until you turn it back on. Turning memory off, withdrawing the AI agreement or deleting a chat does not delete the notes: they are kept with your account and deleted when you delete your account.',
          'Roman conversations are kept until you delete them or your account. You can delete a conversation at any time in the app, which removes its messages from our database straight away. Deleting a chat removes its messages but not Roman’s notes; deleting your account removes them. You can allow or withdraw the optional AI agreement at any time in Settings > Privacy > Roman and AI; when you withdraw it, Roman and AI drafts about you stop until you agree again.',
          'If you coach on TGP and the feature is on, Roman also learns your coaching methods, so that he answers your clients the way you coach. Anthropic processes your coaching team’s general guidelines and meal plans, program templates and library workouts, and the exercises you program most. For clients who keep Roman’s memory on, it also processes your messages to them, your private session notes about them, the guidelines and meal plans written for them, and figures worked out across at least three of those clients, such as sessions per week, macro targets and how you handle Roman’s suggested plan changes. Your clients’ and team members’ names, and any email addresses, phone numbers, links and dates, are removed first. From this, Anthropic writes a summary of your methods that Roman uses only when he replies to your clients who keep his memory on. The summary itself is not shown in the app, to you or to your clients, and Roman never quotes your session notes or messages. It is kept with the head coach’s account (yours, if you coach on your own), included in that coach’s data export and deleted with that account. When the feature is off, no new summary is built and Roman does not use it.',
          'If we turn it on, coaches can also use AI inbox sorting in the community. Anthropic sorts the community posts and messages a coach has not yet answered into five groups (urgent, a win to celebrate, a form check, general, no action needed) and writes a short summary of each for the coach. Sorting only includes posts and messages from members who ticked the optional AI box; everything else stays in the coach’s regular inbox, unsorted. For each item it receives up to 240 characters of the text, the name of the member who wrote it, the cohort name and how many hours ago it was posted. It only sorts and summarises: it never replies, posts or acts on anything, and only the coach sees the result. Perplexity, if enabled, is used to write short generic encouragement after your first logged milestones (it receives only the type of milestone, not your data).',
          'Roman gives general fitness and nutrition guidance, not medical advice. If something sounds like an emergency, Roman points you to 911; if you are in crisis, to 988.',
        ],
      },
      {
        heading: 'Service providers',
        paragraphs: [
          'We use these providers to run the service. Each receives only what it needs for its job and processes it on our behalf. We do not sell data to them, and we do not let them use your data for their own advertising.',
        ],
        bullets: [
          'Supabase — sign-in, database and file storage (for example voice notes, if enabled).',
          'Fly.io — hosting for our servers.',
          'Stripe — card payments, invoices and coach payouts.',
          'Anthropic — Roman and coach AI drafts, after you agree; sorting and summarising a coach’s unanswered community posts and messages for that coach, if turned on, only for members who agreed; learning a coach’s methods from that coach’s content, if turned on (see “Roman and AI”).',
          'Perplexity — generic milestone messages, if enabled.',
          'PostHog — product analytics. Session recording is off.',
          'Sentry — crash and performance monitoring.',
          'Crisp — in-app support chat.',
          'Resend — account and notification emails.',
          'Mux — hosting and playback of the videos coaches upload. It receives the video files, with no name, email or account details attached. When a video is uploaded or played, the device connects to Mux directly, so Mux also receives its IP address and device type.',
          'Expo, with Apple and Google push services — delivery of push notifications.',
          'Apple and Google — Sign in with Apple and Google sign-in, if you choose them.',
          'Apple Health (iPhone) and Health Connect (Android) — the on-device health stores you can choose to connect. We read from them; we do not send your TGP data to them.',
          'USDA FoodData Central and Open Food Facts — food search. Our servers send them only the words you search for, never your name, account or health data. Search results are cached for 24 hours.',
        ],
      },
      {
        heading: 'Legal reasons',
        paragraphs: [
          'We may disclose information when the law requires it, to protect someone’s safety, or to protect TGP and its users from fraud or abuse. If TGP is reorganised or sold, personal data would move only under this policy, and we would tell you first.',
        ],
      },
      {
        heading: 'How long we keep it',
        bullets: [
          'Account, consultation, coaching, health and community data — while your account is open, until you delete it or ask us to delete it.',
          'Roman conversations — kept until you delete them or your account.',
          'Roman’s notes and summaries — kept with your account until you delete it, including while Roman’s memory is off; deleting a chat does not remove them.',
          'Roman’s summary of a coach’s methods — kept with the head coach’s account until that account is deleted.',
          'Food search results — 24 hours in our cache.',
          'Payment, invoice and tax records — as long as the law requires.',
          'Security and audit logs — as long as needed to protect the service and meet legal duties.',
          'Backups — database backups and copies are never kept more than six months after a confirmed deletion request. Copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days.',
          'Error reports in Sentry — 90 days.',
          'Email logs in Resend — 30 days.',
          'Product analytics in PostHog — a deleted person is removed from PostHog within 30 days of the deletion.',
          `What Anthropic receives — ${ANTHROPIC_RETENTION_TEXT}`,
        ],
        paragraphs: [],
      },
      {
        heading: 'Deleting your account',
        paragraphs: [
          'Unless a shorter period is listed above, your information is kept while your account is open. Deletion can be started in the app or by email.',
          // Owner-approved paragraph (O-611-1). Only the Sign in with Apple
          // sentence changed in FIX ROUND 8 (operator ruling on RG-1); the
          // shared constants render the approved words byte for byte.
          'You can delete your account in the app: Settings, then Delete account. You confirm with your password or Sign in with Apple, and deletion is scheduled straight away with a 14-day grace period during which you can cancel. After that, your profile, consultation answers, logs, connected health data, Roman conversations, notifications and community memberships are permanently deleted, and the content of your community posts and messages is removed. ' +
            `${SIGN_IN_WITH_APPLE_DELETION_TEXT} ` +
            'We keep only what we must: the payment records the law requires; security and audit logs; one deletion record with a random reference, the date and the result; and ' +
            `${CLOSED_ACCOUNT_RECORD_TEXT}, so the records we must keep still point to one closed account. ` +
            'While removing your sign-in account at your sign-in provider is still being retried, we also keep that provider’s account ID. ' +
            `Once it is removed, we keep only ${ONE_WAY_CODE_TEXT}.`,
          `You can also ask us to delete your account, or only some of your health data, by emailing ${SUPPORT_EMAIL}. We tell our service providers about deletion requests so they delete their copies too. At Stripe, deletion requests are handled with Stripe’s redaction tools; Stripe keeps the payment records the law requires.`,
        ],
        links: [
          {
            label: 'How to delete your account, with or without the app',
            href: DELETE_ACCOUNT_HELP_PATH,
          },
          APPLE_SIGN_IN_SUPPORT_LINK,
        ],
      },
      {
        heading: 'De-identified information',
        paragraphs: [
          DEIDENTIFIED_TEXT,
        ],
      },
      {
        heading: 'Your rights and choices',
        bullets: [
          'See and download your data — in the app (Trust & Privacy, then Request data export) or by email.',
          'Correct your data — in the app, or by email.',
          'Delete your account or specific data — as described above.',
          'Withdraw your AI agreement — Roman and AI drafts about you stop.',
          'Disconnect Apple Health or Health Connect — at any time in the app or in your phone’s settings; we stop receiving new readings.',
          'Turn off push notifications — in your phone’s settings.',
        ],
        paragraphs: [],
        closing: [
          `To exercise any right, email ${SUPPORT_EMAIL} from the address on your account. We may ask you to confirm your identity, we never require you to create a new account, and we respond within 30 days. Where privacy laws give you more rights (for example in Washington, California, the UK or the EEA), we honour them. If we decline a request you can appeal, as described in the Consumer Health Data Privacy Policy.`,
        ],
      },
      {
        heading: 'Children',
        paragraphs: [
          'You must be 16 or older to use TGP. The service is not directed to children under 16 and we do not knowingly collect their data. If you believe a child under 16 has an account, email us and we will delete it.',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'We protect data with encryption in transit and at rest, access controls and monitoring. No system is perfectly secure; our Security page describes what we do today.',
        ],
        links: [{ label: 'Security', href: '/security' }],
      },
      {
        heading: 'Changes',
        paragraphs: [
          'When we change this policy we update the date at the top and, for material changes, tell you in the app or by email first. We will not collect new categories of health data, or use it for new purposes, without telling you and asking for your agreement first.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          `For privacy questions or requests, email ${SUPPORT_EMAIL}. We aim to reply within five business days.`,
        ],
      },
    ],
    footnote:
      'This policy is a company-drafted statement of practice; counsel review is recommended before relying on it for compliance with any specific regulation.',
  };
}

// ---------------------------------------------------------------------------
// Consumer Health Data Privacy Policy (/consumer-health-privacy)
//
// Written to the disclosure list in RCW 19.373.020 and the consumer rights in
// RCW 19.373.040 (Washington My Health My Data Act). Same accuracy rules as
// the privacy policy above.
// ---------------------------------------------------------------------------
function consumerHealthContent(): TrustPageContent {
  return {
    title: 'Consumer Health Data Privacy Policy — The Growth Project',
    headline: 'Consumer Health Data Privacy Policy',
    intro:
      'This policy explains how The Growth Project (“TGP”, “we”, “us”) ' +
      'collects, uses and shares consumer health data, and how you can ' +
      'exercise your rights over it. It is written for the Washington My ' +
      'Health My Data Act (RCW 19.373) and applies to everyone who uses TGP. ' +
      'It adds to our Privacy Policy, which covers all personal data. TGP is ' +
      'a personal-training service: it does not diagnose or treat any ' +
      'condition. This is a company-drafted statement of practice, and ' +
      'counsel review is recommended.',
    sections: [
      {
        heading: 'What counts as consumer health data',
        paragraphs: [
          'Consumer health data is personal information that is linked or reasonably linkable to you and identifies your past, present or future physical or mental health. In TGP that includes body measurements, readiness and injury answers, food and fitness logs, sleep and heart-rate readings, and anything about your health that you choose to write in a message, post or Roman conversation. It also includes conclusions drawn from that data, such as your calorie and macro targets.',
        ],
      },
      {
        heading: 'Categories we collect and why',
        bullets: [
          'Body and profile measurements — sex used for nutrition formulas, date of birth, height, weight, goal weight, body fat. Used to calculate your targets, choose a suitable plan and show progress.',
          'Readiness and safety answers — heart condition, chest pain, dizziness, bone or joint problems, medication, pregnancy or another reason to take care, injuries, and any notes you add. Used to adapt your training safely and, if any answer is yes, to tell your coach.',
          'Lifestyle and nutrition — activity level, sleep, way of eating, foods you avoid, meals per day, food, macro, water and fasting logs. Used to coach your nutrition and habits.',
          'Fitness and training — training experience, workouts, sets, reps, load, duration, distance and workout history. Used to build and adjust your plan.',
          'Check-ins — mood, energy, sleep and notes. Used to follow how you are doing between sessions.',
          'Connected health data, only if you connect Apple Health or Health Connect — steps, active energy, heart rate, resting heart rate, heart-rate variability, VO2 max, workouts, distance, weight, body fat, blood pressure, sleep, blood-oxygen saturation, respiratory rate and body temperature. Used to show your activity, recovery and sleep to you and your coach and to personalise coaching.',
          'Health information in your words — anything health-related you write to your coach, in a community space or to Roman. Used to deliver the conversation you started.',
          'Roman’s notes and summaries — short notes Roman keeps about your training, preferences and circumstances, from your Roman chats and from everything you log or connect, as part of the Roman permission you give in the consultation. Used to personalise Roman’s replies. Roman’s memory is on unless you turn it off in Settings > Privacy > Roman and AI; while it is off, Roman does not use the notes. Turning memory off or deleting a chat does not remove them; they are kept with your account and deleted when you delete your account.',
          'Derived information — calorie and macro targets, the plan assigned to you, trends in your readings, Roman’s replies, and Roman’s notes and summaries. Used to coach you.',
        ],
        paragraphs: [],
        closing: [
          'We use consumer health data only to provide the personal training you ask for, to provide Roman and your coach’s AI drafts after you agree, to help Roman learn your coach’s methods without identifying you if you keep Roman’s memory on and the feature is on, to keep the service safe and secure, and to meet legal duties. We do not use it for advertising or marketing, we do not sell it, and we do not use it to train AI models.',
          'Health and fitness data is never used for advertising or for data mining other than to improve health management, and is used for health research only with your permission.',
        ],
      },
      {
        heading: 'Where it comes from',
        bullets: [
          'You — your consultation answers, logs, check-ins, messages, posts and Roman conversations.',
          'Your phone’s Apple Health or Health Connect store, after you grant permission in the app.',
          'Your coach — the plan, targets and messages they create for you.',
          'Our systems and Roman — the targets, plans, trends and replies we calculate or generate from your data.',
        ],
        paragraphs: [],
      },
      {
        heading: 'Categories we share',
        paragraphs: ['We share the health data described above only as follows:'],
        bullets: [
          'Your coach, and any coach on their team assigned to you — your consultation and readiness answers, targets and plan, logs, check-ins, connected health data and your messages with them. Your Roman conversations are never shared with your coach.',
          COMMUNITY_VISIBILITY_TEXT,
          LEADERBOARD_VISIBILITY_TEXT,
          'Service providers that process data on our behalf: Supabase (database, sign-in and file storage) and Fly.io (hosting) receive all categories; Anthropic receives the categories listed in your AI agreement to generate Roman’s replies and your coach’s AI drafts; if you keep Roman’s memory on and the feature is on, your coach’s messages to you, their private session notes about you, the guidelines and meal plans written for you and figures from your plan combined with those of at least two other clients, with names and contact details removed, so Roman can learn your coach’s methods; and, if turned on, up to 240 characters of each community post or message your coach has not yet answered, with your name, the cohort name and its age, so it can sort and summarise them for your coach (only if you ticked the optional AI box); Sentry (error monitoring) and PostHog (product analytics) may receive health details that appear in an error report or app event; Crisp (support chat) receives what you choose to tell support; Resend (email) and Expo (push notifications) receive the content of the emails and notifications we send you; Mux (video hosting and playback) receives the videos coaches upload.',
          'Authorities, when the law requires it or to protect someone’s safety.',
        ],
        closing: [
          'After you tick the optional AI box, Roman may read, and send to Anthropic, your fasting logs, your earlier Roman conversations that you have not deleted, the community posts you wrote and daily summaries of your connected health data, including sleep stages, bedtime and wake time, body weight and body fat, and blood pressure. Roman never reads the raw heart-rate readings your device records.',
        ],
      },
      {
        heading: 'Who we do not share with',
        bullets: [
          'No clinic partner. Some coaches run programmes alongside a clinic partner; no account, consultation, coaching, health, wearable or Roman data is exchanged with any clinic partner, and clinic partners have no access to the app.',
          'No data brokers or advertisers. We do not sell consumer health data and we do not share it for advertising.',
          'No affiliates. TGP has no affiliates that receive consumer health data.',
          'Food search providers (USDA FoodData Central and Open Food Facts) receive only the words you search for, never your identity or health data.',
        ],
        paragraphs: [],
      },
      {
        heading: 'Consent',
        paragraphs: [
          // D2 two-box consent (owner-approved 2026-10-01 09:07 PDT). Byte-exact
          // approved copy; pinned by test/trust-pages.spec.ts.
          "Before we collect your consultation answers, the app shows two separate boxes on one screen. The first, which you need to tick to continue, covers the personal-training waiver and lets TGP and your coach collect and use your information to coach you. The second is optional: it lets Roman and your coach's AI drafts use your information, names Anthropic as the AI provider and lists the data it receives. If you leave it unticked, nothing about you is sent to Anthropic. Connecting Apple Health or Health Connect asks for separate permission on your phone. We will not collect new categories of health data, or use or share it for new purposes, without telling you first and asking for your agreement.",
          'You can withdraw the optional AI agreement at any time in Settings > Privacy; Roman and AI drafts about you then stop. To stop all collection, delete your account in Settings > Account. You can also disconnect Apple Health or Health Connect, and delete your data, as described below.',
        ],
      },
      {
        heading: 'Your rights',
        bullets: [
          'Confirm and access — ask whether we collect, share or sell your consumer health data, and get a copy of it.',
          'Recipient list — get a list of every third party and affiliate we have shared your consumer health data with, and an email address or online contact for each.',
          'Withdraw consent — stop our collection and sharing that relies on your agreement.',
          'Delete — have your consumer health data deleted, from our systems and from those of the providers we shared it with.',
          'Appeal — ask us to reconsider if we decline a request.',
        ],
        paragraphs: [],
        closing: ['We will not treat you differently for exercising these rights.'],
      },
      {
        heading: 'How to make a request',
        paragraphs: [
          `Email ${SUPPORT_EMAIL} with “Health data request” in the subject and say which right you want to use. You can also delete your account and data in the app (Settings, then Delete account) and download a copy in the app (Trust & Privacy, then Request data export).`,
          'To protect you, we verify requests: we will ask you to write from, or confirm access to, the email address on your account, or to sign in. You never need to create a new account to make a request. If we cannot verify a request with reasonable effort, we will ask for the minimum extra information we need.',
          'Requests are free up to twice a year. If requests are clearly unfounded, excessive or repetitive, we may charge a reasonable fee or decline, and we will explain why.',
          'We respond without undue delay and within 45 days of receiving your request. If we need more time because a request is complex, we may extend that once by up to 45 more days; if so, we will tell you why within the first 45 days.',
        ],
      },
      {
        heading: 'Deletion',
        paragraphs: [
          'When we delete your consumer health data we remove it from our live systems and tell every service provider we shared it with, so they delete their copies too. Database backups and copies are never kept more than six months after a confirmed deletion request; copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days. ' +
            `${ANTHROPIC_RETENTION_TEXT} ` +
            'Deleting your account in the app starts a 14-day grace period you can cancel; after that, deletion is permanent.',
          DEIDENTIFIED_TEXT,
        ],
      },
      {
        heading: 'Appeals',
        paragraphs: [
          `If we decline your request, you can appeal by replying to our decision or by emailing ${SUPPORT_EMAIL} with “Health data appeal” in the subject. We will tell you in writing what we did or did not do, and why, within 45 days of receiving your appeal. If we deny your appeal, you can contact the Washington State Attorney General at https://www.atg.wa.gov/file-complaint.`,
        ],
      },
      {
        heading: 'How we protect it',
        paragraphs: [
          'Only people and providers who need consumer health data to provide the service, keep people safe or fix problems can access it. We encrypt data in transit and at rest and limit staff access. We do not use location to identify or track people near health-care services, and we do not collect precise location.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [`Questions about this policy or your consumer health data: ${SUPPORT_EMAIL}.`],
        links: [{ label: 'Read the full Privacy Policy', href: PRIVACY_POLICY_PATH }],
      },
    ],
    footnote:
      'This policy is a company-drafted statement of practice; counsel review is recommended before relying on it for compliance with any specific regulation.',
  };
}

function termsContent(): TrustPageContent {
  return {
    title: 'Terms of Service — The Growth Project',
    headline: 'Terms of Service',
    intro:
      'These terms describe the agreement between you and The Growth Project ' +
      '(“TGP”) when you use our software.',
    sections: [
      {
        heading: 'Eligibility and account',
        paragraphs: [
          'You must be 16 or older to use the service. You can sign up as a client or as a coach; signing up with a coach’s invite code makes you that coach’s client. You are responsible for the accuracy of the information you provide and for keeping your account credentials safe. You may not share your account with anyone else.',
        ],
      },
      {
        heading: 'Acceptable use',
        paragraphs: [
          'You agree not to misuse the service. In particular, you may not attempt to disrupt or break security controls, scrape or abuse the API, upload unlawful, harassing or harmful content, or impersonate another person. Community content can be reported and members can be blocked. We may remove content and suspend or terminate accounts that violate these rules.',
          COMMUNITY_ZERO_TOLERANCE_TEXT,
        ],
      },
      {
        heading: 'Personal training, not medical care',
        paragraphs: [
          'TGP is a personal-training service, not a medical or licensed health-care service. It does not diagnose or treat any condition. Information provided by the app, by Roman or other AI features, or by your coach within the app is general fitness and nutrition guidance and is not a substitute for professional medical, mental-health, legal or financial advice. Speak to a qualified professional before making decisions that affect your health. In an emergency call 911; in a mental-health crisis call or text 988.',
          'Before your consultation you are asked to accept the personal-training waiver, which you need to do to continue. A separate, optional box lets Roman and your coach’s AI drafts use your information, processed by Anthropic. Roman is an AI assistant powered by Anthropic; its replies can be wrong, so use your judgement and check with your coach.',
        ],
      },
      {
        heading: 'Privacy',
        paragraphs: [
          'Our Privacy Policy and Consumer Health Data Privacy Policy explain how we handle your data. They form part of these terms.',
        ],
        links: [
          { label: 'Privacy Policy', href: PRIVACY_POLICY_PATH },
          {
            label: 'Consumer Health Data Privacy Policy',
            href: CONSUMER_HEALTH_POLICY_PATH,
          },
        ],
      },
      {
        heading: 'Subscriptions and billing',
        paragraphs: [
          'Paid coaching packages and subscriptions are billed through Stripe on the schedule shown at checkout. You can cancel at any time; cancellation takes effect at the end of the current billing period. Refunds are handled on a case-by-case basis — email the address below.',
        ],
      },
      {
        heading: 'Intellectual property',
        paragraphs: [
          'The software, brand, and product design are owned by The Growth Project. Coaching content you create remains yours; you grant The Growth Project a limited licence to host, display and process it as required to operate the service, including, when the feature is on, processing by its AI provider, Anthropic, so that Roman can learn your coaching methods and answer your clients the way you coach (see the Privacy Policy).',
        ],
      },
      {
        heading: 'Disclaimers and liability',
        paragraphs: [
          'The service is provided on an “as is” basis. To the maximum extent permitted by law, we disclaim implied warranties and our aggregate liability for any claim arising from the service is limited to the amount you paid us in the 12 months preceding the claim.',
        ],
      },
      {
        heading: 'Termination',
        paragraphs: [
          'You can stop using the service at any time and delete your account in the app (Settings, then Delete account) or by email. We can suspend or terminate accounts for violations of these terms or to protect the service and its users.',
        ],
      },
      {
        heading: 'Changes',
        paragraphs: [
          'We may update these terms as the product evolves. Material changes will be announced in the app or by email at least 14 days before they take effect.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [`Questions about these terms can be sent to ${SUPPORT_EMAIL}.`],
      },
    ],
    footnote:
      'This document is a company-drafted statement of terms; counsel review is recommended before relying on it as a binding agreement.',
  };
}

function securityContent(): TrustPageContent {
  return {
    title: 'Security — The Growth Project',
    headline: 'Security',
    intro:
      'We take security seriously because our customers trust us with ' +
      'sensitive coaching data. This page describes the practical controls ' +
      'we have in place today and the channel for reporting issues.',
    sections: [
      {
        heading: 'Transport and storage',
        paragraphs: [
          'All traffic to the service is encrypted in transit using TLS 1.2 or higher (TLS 1.3 where the client supports it). Data at rest is encrypted by our managed database provider using AES-256.',
        ],
      },
      {
        heading: 'Authentication',
        paragraphs: [
          'User accounts are protected by Supabase-managed authentication. Passwords are never stored in plaintext. JWTs are issued with conservative expiry and refresh policies, and sensitive endpoints enforce per-route rate limits.',
        ],
      },
      {
        heading: 'Access control',
        paragraphs: [
          'Production access is limited to the operator. Application code uses least-privilege database roles where the platform allows it. Admin and platform-owner endpoints are gated behind explicit role checks and are tested.',
        ],
      },
      {
        heading: 'Logging and monitoring',
        paragraphs: [
          'We use Sentry for error monitoring and structured request logs for audit trail. Logs do not contain passwords or full card numbers. Server errors (5xx) are escalated for triage; 4xx responses are deliberately not sent to error monitoring to avoid noise from validation failures.',
        ],
      },
      {
        heading: 'Vendor posture',
        paragraphs: [
          'We rely on a small number of well-known vendors (hosting, database, email, error monitoring, Stripe for billing). We choose providers that publish their own security posture; we do not, however, currently hold an independent audit certification (for example SOC 2 or ISO 27001). When that changes we will say so on this page.',
        ],
      },
      {
        heading: 'Incident response',
        paragraphs: [
          `If we discover an incident that meaningfully affects customer data, we will notify affected customers within 72 hours of confirmation, in line with common privacy regimes. To report a suspected vulnerability or active incident, email ${SUPPORT_EMAIL} with “SECURITY” in the subject line. We will acknowledge within one business day.`,
        ],
      },
      {
        heading: 'Responsible disclosure',
        paragraphs: [
          'We welcome reports from independent security researchers. Please give us a reasonable window to fix issues before public disclosure. We do not currently run a paid bug-bounty programme, but we are happy to credit reporters who help us stay safe.',
        ],
      },
    ],
    footnote:
      'We list certifications only when we hold them. The absence of a certification on this page means we have not obtained it.',
  };
}

function statusContent(): TrustPageContent {
  return {
    title: 'Status — The Growth Project',
    headline: 'Status',
    intro:
      'This page describes the public surface of The Growth Project and ' +
      'how to reach a human if something is wrong. We do not currently ' +
      'publish live uptime metrics; when a third-party status feed is ' +
      'added it will be linked here without changing this URL.',
    sections: [
      {
        heading: 'Public endpoints',
        paragraphs: ['The user-facing surface area today is small and intentionally so:'],
        bullets: [
          'https://app.trygrowthproject.com/signup — signup information and coaching invitations.',
          'https://app.trygrowthproject.com/download/ios — iOS download status.',
          'https://app.trygrowthproject.com/download/android — Android download status.',
          'https://app.trygrowthproject.com/join/:code — invite landing for a specific code.',
          'https://app.trygrowthproject.com/privacy, /consumer-health-privacy, /terms, /security, /status — these pages.',
          'https://app.trygrowthproject.com/health — operator-facing liveness check.',
        ],
      },
      {
        heading: 'Current status',
        paragraphs: [
          'As of the date below, the service is operating normally. We update this page when an incident affects more than a single customer or persists for more than a few minutes. Single-user issues are handled directly through the support channel below — they do not appear here.',
        ],
      },
      {
        heading: 'Reporting an outage',
        paragraphs: [
          `If the app is not behaving as expected, email ${SUPPORT_EMAIL} with a brief description of what you tried and what you saw. Include screenshots if you can. We respond within one business day; urgent issues are escalated to the operator on call.`,
        ],
      },
      {
        heading: 'Planned maintenance',
        paragraphs: [
          'We aim to perform any planned maintenance during low-traffic windows and to keep customer-visible downtime under five minutes. When a window is expected to exceed that, we notify coaches by email at least 48 hours in advance.',
        ],
      },
    ],
    footnote:
      'A live status feed will replace the static narrative on this page when third-party monitoring is wired in. The URL stays the same.',
  };
}

export function renderTrustPage(page: TrustPage): string {
  const content =
    page === 'privacy'
      ? privacyContent()
      : page === 'consumer-health'
        ? consumerHealthContent()
        : page === 'terms'
          ? termsContent()
          : page === 'security'
            ? securityContent()
            : statusContent();
  return baseDocument(page, content);
}

function baseDocument(active: TrustPage, c: TrustPageContent): string {
  const title = escapeHtml(c.title);
  const headline = escapeHtml(c.headline);
  const intro = escapeHtml(c.intro);
  const reviewed = escapeHtml(POLICY_LAST_REVIEWED);
  const supportEmail = escapeHtml(SUPPORT_EMAIL);
  const supportEmailHref = escapeAttr(`mailto:${SUPPORT_EMAIL}`);

  const sections = c.sections.map(renderSection).join('\n');
  const footnote = c.footnote ? `\n  <p class="footnote">${escapeHtml(c.footnote)}</p>` : '';

  // The header nav surfaces every trust page from any of them so reviewers
  // and customers can move between them in one click.
  const nav = TRUST_NAV.map((item) => {
    const cls = item.page === active ? 'nav-link active' : 'nav-link';
    return `<a class="${cls}" href="${escapeAttr(safeHref(item.href))}">${escapeHtml(item.label)}</a>`;
  }).join('');

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
  main { max-width: 720px; width: 100%; margin: 0 auto; text-align: left; }
  header.brand { display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; gap: 16px; flex-wrap: wrap; }
  header.brand .wordmark { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 18px; letter-spacing: 0.02em; color: #1F1B16; text-decoration: none; }
  nav.trust-nav { display: flex; gap: 18px; flex-wrap: wrap; }
  nav.trust-nav .nav-link { color: #8A7F6E; text-decoration: none; font-size: 14px; }
  nav.trust-nav .nav-link.active { color: #1F1B16; }
  nav.trust-nav .nav-link:hover { color: #1F1B16; }
  h1 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 40px; line-height: 1.1; letter-spacing: -0.01em; margin: 0 0 8px 0; }
  p.reviewed { margin: 0 0 28px 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #8A7F6E; }
  p.intro { font-size: 18px; line-height: 1.6; margin: 0 0 36px 0; color: #3A332B; }
  section { margin: 0 0 32px 0; }
  section h2 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 22px; line-height: 1.3; margin: 0 0 12px 0; color: #1F1B16; }
  section p { font-size: 16px; line-height: 1.6; margin: 0 0 12px 0; color: #3A332B; }
  section ul { margin: 0 0 12px 0; padding: 0 0 0 20px; }
  section li { font-size: 16px; line-height: 1.6; margin: 0 0 6px 0; color: #3A332B; }
  section p.links a { color: #2C4A36; text-decoration: underline; }
  p.footnote { margin: 40px 0 0 0; font-size: 13px; line-height: 1.55; color: #8A7F6E; font-style: italic; }
  footer.brand-footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #E8E1D4; font-size: 13px; color: #8A7F6E; display: flex; gap: 16px; flex-wrap: wrap; justify-content: space-between; }
  footer.brand-footer a { color: #8A7F6E; text-decoration: underline; }
</style>
</head>
<body>
<main>
  <header class="brand">
    <a class="wordmark" href="/">The Growth Project</a>
    <nav class="trust-nav">${nav}</nav>
  </header>
  <h1>${headline}</h1>
  <p class="reviewed">Last reviewed ${reviewed}</p>
  <p class="intro">${intro}</p>
${sections}${footnote}
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

/**
 * Footer links to the Privacy Policy and the Consumer Health Data Privacy
 * Policy. Shared with the help and status pages so every public page carries
 * the consumer health policy link (RCW 19.373.020: "prominently publish a
 * link ... on its homepage").
 */
export function policyFooterLinks(): string {
  return (
    `<a href="${escapeAttr(PRIVACY_POLICY_PATH)}">Privacy Policy</a>` +
    ' · ' +
    `<a href="${escapeAttr(CONSUMER_HEALTH_POLICY_PATH)}">Consumer Health Data Privacy Policy</a>` +
    ' · ' +
    `<a href="${escapeAttr(DELETE_ACCOUNT_HELP_PATH)}">Delete your account</a>`
  );
}

/**
 * Only site-relative paths, mailto: and https: URLs are rendered as links.
 * Anything else (javascript:, data:, protocol-relative //host) becomes "#".
 */
export function safeHref(href: string): string {
  if (/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(href)) return href;
  if (/^mailto:[^\s"'<>]+$/i.test(href)) return href;
  if (/^https:\/\/[^\s"'<>]+$/i.test(href)) return href;
  return '#';
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
