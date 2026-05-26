/**
 * R51 unit tests — nudge selector (pickNudge) + share templates.
 *
 * Pure-function coverage: no Prisma, no DI.  Exercises every (day,
 * milestone) pair the scheduler can hit and asserts:
 *   - the right copy goes out on each day
 *   - first_client short-circuits to null
 *   - safeUrl() blocks javascript: schemes in <a href>
 *   - escapeHtml prevents token-injection through coach_first_name
 *   - share-template URLs all match the coach's share URL
 */

import { pickNudge, type NudgeTokens } from '../src/onboarding/nudge-content';
import { buildShareTemplates } from '../src/onboarding/share-templates';
import { firstNameOf } from '../src/onboarding/onboarding-nudge.service';
import { daysBetweenIsoBuckets } from '../src/onboarding/onboarding-nudge.scheduler';

const baseTokens: NudgeTokens = {
  coach_first_name: 'Alex',
  share_url: 'https://joingrowthproject.com/v1/packages/public/join/tok_abc',
  console_url: 'https://app.trygrowthproject.com/coach',
  support_url: 'https://cal.com/tgp/15min',
};

// ─── pickNudge: per-day happy paths ──────────────────────────────────────────

describe('pickNudge — per-day content', () => {
  it('returns null when milestone is first_client (sequence done)', () => {
    expect(
      pickNudge({ day: 1, milestone: 'first_client', tokens: baseTokens }),
    ).toBeNull();
    expect(
      pickNudge({ day: 7, milestone: 'first_client', tokens: baseTokens }),
    ).toBeNull();
  });

  it('Day 1 + signed_up → push "create your first package"', () => {
    const n = pickNudge({
      day: 1,
      milestone: 'signed_up',
      tokens: baseTokens,
    })!;
    expect(n.subject.toLowerCase()).toContain('first coaching package');
    expect(n.in_app.toLowerCase()).toContain('package');
    expect(n.email_html).toContain('Create my first package');
    expect(n.deep_link).toBe('tgp://coach/packages/new');
  });

  it('Day 1 + created_package → push "share your link"', () => {
    const n = pickNudge({
      day: 1,
      milestone: 'created_package',
      tokens: baseTokens,
    })!;
    expect(n.subject.toLowerCase()).toContain('link');
    expect(n.email_html.toLowerCase()).toContain('instagram bio');
    expect(n.deep_link).toBe('tgp://coach/share');
  });

  it('Day 2 + shared_link includes share snippets when provided', () => {
    const tokens: NudgeTokens = {
      ...baseTokens,
      share_snippets: [
        { label: 'Instagram bio', copy: 'Apply below ↓' },
        { label: 'DM template', copy: 'hey — new spots open' },
      ],
    };
    const n = pickNudge({ day: 2, milestone: 'shared_link', tokens })!;
    expect(n.email_html).toContain('Instagram bio');
    expect(n.email_html).toContain('Apply below');
    expect(n.email_html).toContain('DM template');
  });

  it('Day 2 + signed_up still pushes the package builder', () => {
    const n = pickNudge({
      day: 2,
      milestone: 'signed_up',
      tokens: baseTokens,
    })!;
    expect(n.email_html.toLowerCase()).toContain('package');
    expect(n.deep_link).toBe('tgp://coach/packages/new');
  });

  it('Day 3 carries the "4-7 days" social proof line', () => {
    const n = pickNudge({
      day: 3,
      milestone: 'shared_link',
      tokens: baseTokens,
    })!;
    expect(n.subject.toLowerCase()).toContain('4');
    expect(n.email_html).toContain('4–7 days');
  });

  it('Day 5 is the founder empathy nudge with reply CTA', () => {
    const n = pickNudge({
      day: 5,
      milestone: 'shared_link',
      tokens: baseTokens,
    })!;
    expect(n.email_html.toLowerCase()).toContain('bradley');
    expect(n.email_html).toContain('mailto:bradley@trygrowthproject.com');
  });

  it('Day 7 surfaces the 15-minute book link', () => {
    const n = pickNudge({
      day: 7,
      milestone: 'created_package',
      tokens: baseTokens,
    })!;
    expect(n.subject.toLowerCase()).toContain('15');
    expect(n.email_html).toContain('Book 15 minutes');
    expect(n.email_html).toContain('https://cal.com/tgp/15min');
  });
});

// ─── Security: HTML escape + safeUrl ─────────────────────────────────────────

describe('pickNudge — security', () => {
  it('escapes < > & " in coach_first_name before rendering', () => {
    const tokens = { ...baseTokens, coach_first_name: '<script>x</script>' };
    const n = pickNudge({ day: 1, milestone: 'signed_up', tokens })!;
    // The literal tag must not survive into the HTML.
    expect(n.email_html).not.toContain('<script>');
    // The escaped form should appear instead.
    expect(n.email_html).toContain('&lt;script&gt;');
  });

  it('blocks javascript: URLs in button hrefs (safeUrl returns #)', () => {
    const tokens = { ...baseTokens, console_url: 'javascript:alert(1)' };
    const n = pickNudge({ day: 1, milestone: 'signed_up', tokens })!;
    expect(n.email_html).toContain('href="#"');
    expect(n.email_html).not.toContain('javascript:');
  });

  it('keeps https URLs intact through safeUrl', () => {
    const n = pickNudge({
      day: 7,
      milestone: 'created_package',
      tokens: baseTokens,
    })!;
    expect(n.email_html).toContain('https://cal.com/tgp/15min');
  });

  it('mailto: URLs in the Day-5 button are allowed by safeUrl', () => {
    const n = pickNudge({
      day: 5,
      milestone: 'signed_up',
      tokens: baseTokens,
    })!;
    expect(n.email_html).toContain('mailto:bradley@trygrowthproject.com');
  });
});

// ─── Share templates ─────────────────────────────────────────────────────────

describe('buildShareTemplates', () => {
  const url = 'https://joingrowthproject.com/v1/packages/public/join/tok_xyz';

  it('returns 5 platforms in stable order', () => {
    const list = buildShareTemplates({ coachFirstName: 'Sam', shareUrl: url });
    expect(list.map((t) => t.platform)).toEqual([
      'instagram_bio',
      'instagram_story',
      'instagram_dm',
      'email_signature',
      'qr_poster',
    ]);
  });

  it('every template carries the same canonical url', () => {
    const list = buildShareTemplates({ coachFirstName: 'Sam', shareUrl: url });
    for (const t of list) {
      expect(t.url).toBe(url);
    }
  });

  it('DM template embeds the URL inline (visitor copy-paste path)', () => {
    const list = buildShareTemplates({ coachFirstName: 'Sam', shareUrl: url });
    const dm = list.find((t) => t.platform === 'instagram_dm')!;
    expect(dm.copy).toContain(url);
  });

  it('email signature uses coach first name; QR copy uses it too', () => {
    const list = buildShareTemplates({ coachFirstName: 'Sam', shareUrl: url });
    const sig = list.find((t) => t.platform === 'email_signature')!;
    const qr = list.find((t) => t.platform === 'qr_poster')!;
    expect(sig.copy).toContain('Sam');
    expect(qr.copy).toContain('Sam');
  });

  it('falls back to "your coach" when no first name', () => {
    const list = buildShareTemplates({ coachFirstName: null, shareUrl: url });
    const qr = list.find((t) => t.platform === 'qr_poster')!;
    expect(qr.copy.toLowerCase()).toContain('your coach');
  });

  it('IG bio copy stays under the 150-char Instagram cap', () => {
    const list = buildShareTemplates({ coachFirstName: 'Sam', shareUrl: url });
    const bio = list.find((t) => t.platform === 'instagram_bio')!;
    expect(bio.copy.length).toBeLessThanOrEqual(150);
  });
});

// ─── firstNameOf helper ─────────────────────────────────────────────────────

describe('firstNameOf', () => {
  it('returns the first whitespace-separated token', () => {
    expect(firstNameOf('Alex Rivera')).toBe('Alex');
    expect(firstNameOf('  Jane   Smith ')).toBe('Jane');
  });
  it('returns "there" for null/empty', () => {
    expect(firstNameOf(null)).toBe('there');
    expect(firstNameOf('')).toBe('there');
    expect(firstNameOf('   ')).toBe('there');
  });
});

// ─── daysBetweenIsoBuckets ──────────────────────────────────────────────────

describe('daysBetweenIsoBuckets', () => {
  it('returns 1 for adjacent days', () => {
    expect(daysBetweenIsoBuckets('2026-05-25', '2026-05-26')).toBe(1);
  });
  it('handles month rollover', () => {
    expect(daysBetweenIsoBuckets('2026-05-31', '2026-06-01')).toBe(1);
  });
  it('returns 7 for a full week', () => {
    expect(daysBetweenIsoBuckets('2026-05-19', '2026-05-26')).toBe(7);
  });
  it('returns 0 for same day', () => {
    expect(daysBetweenIsoBuckets('2026-05-26', '2026-05-26')).toBe(0);
  });
  it('handles February 28 → March 1 in non-leap years', () => {
    expect(daysBetweenIsoBuckets('2025-02-28', '2025-03-01')).toBe(1);
  });
  it('handles February 29 in leap year', () => {
    expect(daysBetweenIsoBuckets('2024-02-28', '2024-03-01')).toBe(2);
  });
});
