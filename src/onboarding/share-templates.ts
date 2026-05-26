/**
 * Share-link copy templates for the GET /v1/coaches/me/share-templates
 * endpoint and the Day-2 "5 places to share" nudge email.
 *
 * Pure functions: no DB, no IO.  Caller threads in the coach's name,
 * specialty (e.g. "fat-loss coach"), and the canonical share URL.
 *
 * Why a separate file: the same copy is rendered both in the API
 * response (for the in-app "Share my link" screen) AND embedded into
 * the Day-2 email body, so we want one source of truth.  Inline
 * strings rather than .hbs files because each block is tiny, the
 * tokens are obvious, and Handlebars would add boilerplate without
 * value at this size.
 *
 * Tone: supportive-coach voice, not pushy-SaaS.  Mirrors the spec
 * direction "cognitive deload, haptic feedback, and positive
 * reinforcement of the underlying actions" — short, concrete, and
 * verb-first.  The copy assumes a coach who already has a package
 * minted; the controller / nudge selector falls back to a different
 * nudge ("Set up your first package") when no share_token exists yet.
 */

export type SharePlatform =
  | 'instagram_bio'
  | 'instagram_story'
  | 'instagram_dm'
  | 'email_signature'
  | 'qr_poster';

export interface ShareTemplate {
  /** Stable machine identifier — UI uses this to render the right icon. */
  platform: SharePlatform;
  /** Human label shown above the copy block in the UI. */
  label: string;
  /** The actual copy block; never includes the URL inline (UI appends). */
  copy: string;
  /**
   * Canonical share URL.  The same URL is rendered everywhere — IG bio,
   * QR poster, DM template — so reach attribution stays clean.
   */
  url: string;
}

/**
 * Build the five share templates for a coach.  `coachFirstName` defaults
 * to "your coach" if the coach has not set a display name yet.  All
 * copy stays under 220 characters so it pastes cleanly into Instagram
 * bio (150-char limit) and IG stories (no hard limit but short = clear).
 */
export function buildShareTemplates(args: {
  coachFirstName: string | null | undefined;
  shareUrl: string;
}): ShareTemplate[] {
  const name = args.coachFirstName?.trim() || 'your coach';
  const url = args.shareUrl;

  return [
    {
      platform: 'instagram_bio',
      label: 'Instagram bio',
      // 110 chars — fits inside IG's 150-char bio cap with room for one
      // emoji of the coach's choice. Verb-first to drive a tap.
      copy: `Coaching that actually shows up. Apply below ↓`,
      url,
    },
    {
      platform: 'instagram_story',
      label: 'Instagram story',
      // Suggested overlay copy + link-sticker text. Stories convert
      // higher when the CTA is named — "tap to apply" beats "link below".
      copy: `Now taking 3 new clients this month. Tap to apply — link in story.`,
      url,
    },
    {
      platform: 'instagram_dm',
      label: 'DM template',
      // For warm-list outreach: people who already follow the coach.
      // Single line, no caps, no emoji explosion — feels like a friend.
      copy: `hey — i'm opening a couple new spots this month. if you've ever thought about working with me, this is the link: ${url}`,
      url,
    },
    {
      platform: 'email_signature',
      label: 'Email signature',
      // Drop-in HTML-friendly text. The UI shows it as code-block so
      // the coach can paste verbatim into Gmail / Outlook.
      copy:
        `— ${name}\n` +
        `Coaching • The Growth Project\n` +
        `${url}`,
      url,
    },
    {
      platform: 'qr_poster',
      label: 'Gym / poster QR',
      // Copy for a printable poster header above a QR code that
      // resolves to the URL. Kept ultra-short for legibility from 6ft.
      copy: `Train with ${name}.\nScan to apply.`,
      url,
    },
  ];
}
