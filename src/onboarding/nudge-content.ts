/**
 * Per-day nudge content for the first-client onboarding sequence.
 *
 * Pure data — no DB, no IO. Returns a `{ subject, in_app, email_html }`
 * triple for a given (day, milestone) pair. The scheduler resolves the
 * coach's current milestone live (querying packages / share-links /
 * leads / clients) and asks this module for the right copy.
 *
 * Tone: supportive-coach, founder-voice. Spec says
 * "cognitive deload, haptic feedback, and positive reinforcement of
 * the underlying actions" — translation:
 *   * one action per nudge (no laundry lists)
 *   * verb-first headline
 *   * acknowledge work already done before suggesting the next step
 *   * NEVER guilt-trip ("you haven't…"); always forward ("next:…")
 *   * Day 5 is the empathy nudge — first person, from the founder
 *
 * The email HTML is intentionally a single inline-styled <body>
 * fragment — the canonical `first-client-nudge-v1.hbs` template wraps
 * it in the standard <!doctype html><html><body> shell. Keeping the
 * fragment inline here lets us swap copy per (day, milestone) without
 * five .hbs files. The HTML is generated server-side from typed string
 * tokens (coach_first_name, share_url, console_url, support_url) so
 * Handlebars is not the only escape boundary — `escapeHtml()` below
 * is the authoritative escape.
 */

import type { OnboardingMilestone } from '@prisma/client';

/** The day-N triggers the scheduler fires on. */
export type NudgeDay = 1 | 2 | 3 | 5 | 7;

export interface NudgeContent {
  /** In-app body (<=160 chars per the Notification.body slice). */
  in_app: string;
  /** Email subject line. */
  subject: string;
  /** Pre-rendered HTML body fragment for the email. */
  email_html: string;
  /** Deep-link the in-app notification opens. */
  deep_link: string;
}

export interface NudgeTokens {
  coach_first_name: string;
  /** Canonical share URL when the coach has a share_token; null otherwise. */
  share_url: string | null;
  /** Deep-link into the coach console (mobile or web). */
  console_url: string;
  /**
   * Calendly URL (or any "book 15 min" link). Read from env at scheduler
   * boot. When unset (dev) the Day 7 nudge falls back to a mailto: URL
   * so the link never renders as empty.
   */
  support_url: string;
  /** Day-2 share-template snippets, rendered inline. */
  share_snippets?: ReadonlyArray<{ label: string; copy: string }>;
}

/**
 * Lightweight HTML escape for the email body fragment. Tokens flow
 * through this before being concatenated into the email_html string.
 *
 * Identical to the escapeHtml helper in guest-checkout.service.ts —
 * we keep a local copy rather than crossing module boundaries because
 * that file lives in the payments path and we do not want this module
 * pulling its imports in.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Same escape, but URLs run through new URL() first so that an
 * unexpected `javascript:` / `data:` scheme can never reach the
 * rendered <a href>. Falls back to '#' (renders as a non-functional
 * link, never executes a script).
 */
const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (SAFE_URL_PROTOCOLS.has(parsed.protocol)) {
      return escapeHtml(parsed.toString());
    }
  } catch {
    /* fall through to '#' */
  }
  return '#';
}

/**
 * Wrap a fragment in the supportive-coach button style. Centralised so
 * every nudge button is visually identical (button = the single CTA).
 */
function button(label: string, url: string): string {
  return (
    `<p style="margin:24px 0;">` +
    `<a href="${safeUrl(url)}" ` +
    `style="display:inline-block;background:#4f46e5;color:#fff;` +
    `padding:12px 22px;border-radius:8px;text-decoration:none;` +
    `font-weight:600;">${escapeHtml(label)}</a></p>`
  );
}

/**
 * Resolve the right nudge for (day, milestone, tokens).  The scheduler
 * passes the milestone as observed at tick time; if the coach has
 * already hit FIRST_CLIENT this function returns null and the scheduler
 * skips delivery (the row is also marked stopped at the call site).
 */
export function pickNudge(args: {
  day: NudgeDay;
  milestone: OnboardingMilestone;
  tokens: NudgeTokens;
}): NudgeContent | null {
  const { day, milestone, tokens } = args;

  // Once the coach has a paying client the sequence is over.  Caller
  // also sets first_client_at on the row.
  if (milestone === 'first_client') return null;

  const firstName = escapeHtml(tokens.coach_first_name);
  const consoleUrl = safeUrl(tokens.console_url);
  const supportUrl = safeUrl(tokens.support_url);
  const shareUrlRaw = tokens.share_url;

  // Shared paragraph styling so every nudge has the same visual rhythm.
  const p = (text: string) =>
    `<p style="font-size:16px;line-height:1.55;margin:0 0 14px;">${text}</p>`;

  // ── Day 1 ────────────────────────────────────────────────────────────────
  // Branch on whether a package exists yet.  The "set up your first
  // package" branch is the single-action nudge spec calls out; the
  // alternate "share your link" branch fires when the coach moved fast
  // enough on Day 0 to already have a package.
  if (day === 1) {
    if (milestone === 'signed_up') {
      const html =
        p(`Hi ${firstName} — welcome to The Growth Project.`) +
        p(
          `The fastest way to your first paid client is one small step ` +
            `today: set up a coaching package. Pick a name, a price, ` +
            `and what's included. You can refine it later.`,
        ) +
        button('Create my first package', tokens.console_url);
      return {
        subject: 'Step one: your first coaching package',
        in_app:
          `Welcome aboard. Set up your first coaching package — it's ` +
          `the only thing standing between you and a paying client.`,
        email_html: html,
        deep_link: 'tgp://coach/packages/new',
      };
    }
    // Coach already has a package → push them to share the link.
    const html =
      p(`Nice work, ${firstName} — your first package is live.`) +
      p(
        `Next: get it in front of the right person. Drop the link in ` +
          `your Instagram bio today. We'll show you four more places ` +
          `to share it tomorrow.`,
      ) +
      button('Open my share link', tokens.console_url);
    return {
      subject: 'Drop the link in your bio today',
      in_app:
        `Your package is live. Drop the share link in your Instagram ` +
        `bio today — that's usually the first lead within a week.`,
      email_html: html,
      deep_link: 'tgp://coach/share',
    };
  }

  // ── Day 2 — "5 places to share" ──────────────────────────────────────────
  if (day === 2) {
    if (milestone === 'signed_up') {
      // Coach still hasn't made a package — keep nudging the same action.
      const html =
        p(`Hey ${firstName}, no pressure — but the clock is real.`) +
        p(
          `Most coaches who get their first paying client within two ` +
            `weeks have a package live by day 2. Five minutes today ` +
            `gets you there.`,
        ) +
        button('Create my package', tokens.console_url);
      return {
        subject: '5 minutes today gets you set up',
        in_app:
          `Five minutes to set up your first package today gets you ` +
          `unstuck. Tap to open the builder.`,
        email_html: html,
        deep_link: 'tgp://coach/packages/new',
      };
    }
    // Render the share-template snippets.
    const snippets =
      tokens.share_snippets?.length
        ? `<ul style="padding-left:18px;margin:14px 0;">` +
          tokens.share_snippets
            .map(
              (s) =>
                `<li style="margin-bottom:10px;">` +
                `<strong>${escapeHtml(s.label)}:</strong> ` +
                `<span style="color:#555;">${escapeHtml(s.copy)}</span>` +
                `</li>`,
            )
            .join('') +
          `</ul>`
        : '';
    const shareLinkLine = shareUrlRaw
      ? p(
          `Your share link: ` +
            `<a href="${safeUrl(shareUrlRaw)}" style="color:#4f46e5;">${escapeHtml(shareUrlRaw)}</a>`,
        )
      : '';
    const html =
      p(`${firstName}, here are five places to drop your link.`) +
      p(
        `Pick the one that fits your audience. Don't overthink it — ` +
          `one share today beats five shares "later this week".`,
      ) +
      snippets +
      shareLinkLine +
      button('Copy my share link', tokens.console_url);
    return {
      subject: '5 places to share your link today',
      in_app:
        `5 places to share your link today: IG bio, story, DMs, your ` +
        `email signature, a gym QR poster. Tap for the copy.`,
      email_html: html,
      deep_link: 'tgp://coach/share',
    };
  }

  // ── Day 3 — "first lead in 4-7 days" social proof ────────────────────────
  if (day === 3) {
    const html =
      p(`${firstName}, a stat we share with every coach on day 3:`) +
      p(
        `<strong>Most coaches see their first lead in 4–7 days.</strong> ` +
          `If you've shared your link once, you're already on that curve.`,
      ) +
      p(
        `What's working right now: Instagram stories with the link ` +
          `sticker, and one warm DM per day to people who already ` +
          `engage with your content. That's it.`,
      ) +
      button('See my dashboard', tokens.console_url);
    return {
      subject: 'Most coaches get their first lead in 4–7 days',
      in_app:
        `Most coaches see their first lead in 4–7 days. One IG story ` +
        `with a link sticker today is the highest-leverage move.`,
      email_html: html,
      deep_link: 'tgp://coach/dashboard',
    };
  }

  // ── Day 5 — founder empathy ──────────────────────────────────────────────
  if (day === 5) {
    const html =
      p(`${firstName} —`) +
      p(
        `Bradley here. I've been watching coaches go through the first ` +
          `week and I notice the ones who get unstuck just want a ` +
          `second pair of eyes on their link.`,
      ) +
      p(
        `If you want me to take a look at yours — drop it in a reply ` +
          `to this email and I'll send you back a one-liner. No agenda.`,
      ) +
      button('Reply with my link', `mailto:bradley@trygrowthproject.com`);
    return {
      subject: `Want me to look at your link, ${tokens.coach_first_name}?`,
      in_app:
        `Bradley here — want a second pair of eyes on your link? Reply ` +
        `to today's email and I'll send a quick note back.`,
      email_html: html,
      deep_link: 'tgp://coach/dashboard',
    };
  }

  // ── Day 7 — book a call ──────────────────────────────────────────────────
  // Day 7 is the last scheduled nudge before the sequence ages out.
  const html =
    p(`${firstName} — quick check-in.`) +
    p(
      `You're one week in. If the first-client part is feeling stuck, ` +
        `the fastest fix is usually a 15-minute call so we can spot ` +
        `the one thing that's blocking you.`,
    ) +
    p(
      `No pitch, no upsell — we just want to see you win. Pick a slot ` +
        `that works:`,
    ) +
    button('Book 15 minutes', tokens.support_url) +
    p(
      `If you'd rather keep going solo, ` +
        `<a href="${consoleUrl}" style="color:#4f46e5;">your dashboard is here</a> ` +
        `— we'll stop sending these emails after today.`,
    );
  return {
    subject: 'One week in — want 15 minutes?',
    in_app:
      `Week one wrap-up. If first-client feels stuck, a 15-min call ` +
      `with us is usually the fastest unblock. Tap to book.`,
    email_html: html,
    deep_link: 'tgp://coach/support',
  };
}

// Re-exported for tests so spec files do not pull @prisma/client just
// to assert against the milestone enum values.
export const ONBOARDING_MILESTONES = [
  'signed_up',
  'created_package',
  'shared_link',
  'first_lead',
  'first_client',
] as const;
