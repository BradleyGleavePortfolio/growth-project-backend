// Durable, server-rendered "trust" pages: /privacy, /terms, /security,
// /status. These exist as the public surface that app store reviewers and
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

// Source of truth for the official support contact. Confirmed by the
// operator. Used in every trust page so a customer or reviewer always has
// a real human to email.
export const SUPPORT_EMAIL = 'Bradley@Bradleytgpcoaching.com';

// Last-reviewed date for the policy text. Bump when copy changes.
// Format ISO-8601 (UTC) so it sorts and renders consistently.
export const POLICY_LAST_REVIEWED = '2026-04-27';

export type TrustPage = 'privacy' | 'terms' | 'security' | 'status';

interface RenderedSection {
  heading: string;
  // Each paragraph is plain text; headings/paragraphs are escaped at render.
  paragraphs: string[];
  // Optional bulleted list rendered after the paragraphs.
  bullets?: string[];
}

interface TrustPageContent {
  title: string;
  headline: string;
  intro: string;
  sections: RenderedSection[];
  // Footer line shown above the company line.
  footnote?: string;
}

function privacyContent(): TrustPageContent {
  return {
    title: 'Privacy Policy — The Growth Project',
    headline: 'Privacy Policy',
    intro:
      'The Growth Project (“we”, “us”) provides coaching software used by ' +
      'independent coaches and the people they coach. This page describes, ' +
      'in plain terms, what personal data we collect, why we collect it, ' +
      'and the choices you have. It is written as company policy and is ' +
      'intended to be reviewed by counsel before any public launch outside ' +
      'an invite-only beta.',
    sections: [
      {
        heading: 'What we collect',
        paragraphs: [
          'We collect the minimum data required to operate the product:',
        ],
        bullets: [
          'Account data — your email address, display name, and the coach who invited you.',
          'Coaching data — check-ins, habits, weight, food and water logs, workouts, and messages you send to your coach.',
          'Device and usage data — basic logs (IP address, user-agent, request timestamps) and product analytics events used to improve the app.',
          'Billing data — handled by Stripe on our behalf; we store only the subscription identifiers needed to provision access. We do not store full card numbers.',
        ],
      },
      {
        heading: 'How we use it',
        paragraphs: [
          'We use your data to operate the coaching experience: to render your dashboards, to deliver messages between you and your coach, to compute reminders and nudges, and to keep the service secure and reliable. We do not sell personal data, and we do not use coaching content to train third-party AI models.',
        ],
      },
      {
        heading: 'AI features',
        paragraphs: [
          'The app includes AI-assisted features (for example, suggested check-in summaries). When AI is involved, we send only the minimum context required to generate the response, and we do not retain that context for model training. AI-generated suggestions are guidance, not medical, legal, or financial advice.',
        ],
      },
      {
        heading: 'Sharing',
        paragraphs: [
          'Your coaching data is visible to your coach (that is the point of the product). We use a small number of vetted vendors to operate the service — for example, our hosting provider, our database provider, our email provider, our error-monitoring provider, and Stripe for billing. Each vendor receives only the data needed for that function.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'You can request a copy of your data, request correction of inaccurate data, or request deletion of your account at any time by emailing the address below. We respond within 30 days. If you are in a jurisdiction with formal privacy rights (for example the EEA, the UK, or California), those rights apply to you regardless of where you live.',
        ],
      },
      {
        heading: 'Retention',
        paragraphs: [
          'We retain account and coaching data while your account is active. When you delete your account, we delete or de-identify your personal data within 30 days, except where we are required by law to retain billing or audit records.',
        ],
      },
      {
        heading: 'Children',
        paragraphs: [
          'The Growth Project is not directed to children under 16. We do not knowingly collect data from children under 16. If you believe a child has registered, email us and we will delete the account.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          `For privacy questions, data requests, or to exercise any right described above, email ${SUPPORT_EMAIL}. We aim to respond within five business days.`,
        ],
      },
    ],
    footnote:
      'This policy is a company-drafted statement of practice; formal legal review is recommended before relying on it for compliance with any specific regulation.',
  };
}

function termsContent(): TrustPageContent {
  return {
    title: 'Terms of Service — The Growth Project',
    headline: 'Terms of Service',
    intro:
      'These terms describe the agreement between you and The Growth Project ' +
      'when you use our software. They are written as a company policy draft ' +
      'and are intended to be reviewed by counsel before any public launch ' +
      'outside an invite-only beta.',
    sections: [
      {
        heading: 'Eligibility and account',
        paragraphs: [
          'You must be 16 or older to use the service. You are responsible for the accuracy of the information you provide and for keeping your account credentials safe. You may not share your account with anyone else.',
        ],
      },
      {
        heading: 'Acceptable use',
        paragraphs: [
          'You agree not to misuse the service. In particular, you may not attempt to disrupt or break security controls, scrape or abuse the API, upload unlawful or harmful content, or impersonate another person. We may suspend or terminate accounts that violate these rules.',
        ],
      },
      {
        heading: 'Coaching content',
        paragraphs: [
          'The Growth Project is a coaching tool, not a medical or licensed health-care service. Information provided by the app, by AI features, or by your coach within the app is for educational and motivational purposes and is not a substitute for professional medical, mental-health, legal, or financial advice. Always consult a qualified professional before making decisions that affect your health.',
        ],
      },
      {
        heading: 'Subscriptions and billing',
        paragraphs: [
          'Paid subscriptions are billed through Stripe on the schedule shown at checkout. You can cancel at any time; cancellation takes effect at the end of the current billing period. Refunds are handled on a case-by-case basis — email the address below.',
        ],
      },
      {
        heading: 'Intellectual property',
        paragraphs: [
          'The software, brand, and product design are owned by The Growth Project. Coaching content you create remains yours; you grant us a limited licence to host and display it as required to operate the service.',
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
          'You can stop using the service at any time and request account deletion. We can suspend or terminate accounts for violations of these terms or to protect the service and its users.',
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
        paragraphs: [
          `Questions about these terms can be sent to ${SUPPORT_EMAIL}.`,
        ],
      },
    ],
    footnote:
      'This document is a company-drafted statement of terms; formal legal review is recommended before relying on it as a binding agreement.',
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
        paragraphs: [
          'The user-facing surface area today is small and intentionally so:',
        ],
        bullets: [
          'https://app.trygrowthproject.com/signup — invite-only signup landing.',
          'https://app.trygrowthproject.com/download/ios — iOS download status.',
          'https://app.trygrowthproject.com/download/android — Android download status.',
          'https://app.trygrowthproject.com/join/:code — invite landing for a specific code.',
          'https://app.trygrowthproject.com/privacy, /terms, /security, /status — these pages.',
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
  const footnote = c.footnote
    ? `\n  <p class="footnote">${escapeHtml(c.footnote)}</p>`
    : '';

  // The header nav surfaces all four trust pages from any of them so
  // reviewers and customers can move between them in one click.
  const nav = (['privacy', 'terms', 'security', 'status'] as const)
    .map((slug) => {
      const label =
        slug === 'privacy'
          ? 'Privacy'
          : slug === 'terms'
            ? 'Terms'
            : slug === 'security'
              ? 'Security'
              : 'Status';
      const cls = slug === active ? 'nav-link active' : 'nav-link';
      return `<a class="${cls}" href="/${slug}">${label}</a>`;
    })
    .join('');

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
