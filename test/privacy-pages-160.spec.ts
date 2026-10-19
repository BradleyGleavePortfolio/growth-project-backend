/**
 * PRIVACY-PAGES (agent 160): the App Store privacy pages say what the app
 * really does.
 *  - POSTHOG-GEOIP-DISCLOSURE: the mobile PostHog client (posthog-react-native,
 *    mobile src/lib/analytics.ts) does not set disableGeoip, and @posthog/core
 *    defaults it to false, so PostHog works out an approximate location from
 *    the IP address of the device that sends each app event. The backend
 *    client (posthog-node) defaults disableGeoip to true and sends
 *    $geoip_disable, so server events carry no location.
 *  - PRIVACY-COMMUNITY-NAMES (#C6-MEMBER-NAMES, #C6-NAMES-EVERYWHERE): in a
 *    space open to all of a coach's clients, the other clients see full names
 *    (src/community/member-display-name.ts FULL_NAME_VISIBILITY, fullNamesFor).
 *  - PRIVACY-DELETE-NAV: the coach button is "Delete my account".
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COMMUNITY_VISIBILITY_TEXT,
  POLICY_LAST_REVIEWED,
  renderTrustPage,
} from '../src/public-pages/trust-pages.html';
import { FULL_NAME_VISIBILITY } from '../src/community/member-display-name';

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const map: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m)
    .replace(/\s+/g, ' ');
}

const privacy = visibleText(renderTrustPage('privacy'));
const health = visibleText(renderTrustPage('consumer-health'));
const terms = visibleText(renderTrustPage('terms'));

const GEOIP =
  'product analytics events and screen views linked to your account ID, with an approximate location (country, region, city, postal area, time zone and the rough coordinates of that area) that PostHog, the analytics provider, works out from the IP address of the device that sends them';

const FULL_NAMES =
  'If you are in a space open to all of your coach’s clients, your coach’s other clients see your full name: on that space’s member list, next to your posts and comments there and in your coach’s main community feed, and next to your shared wins and leaderboard entry.';

const CLIENT_CAN =
  'You can delete your own posts and shared wins, and you can block another member, so that you no longer see each other’s posts, comments or messages.';

describe('PRIVACY-PAGES (agent 160)', () => {
  it('POSTHOG-GEOIP-DISCLOSURE: /privacy says PostHog derives an approximate location from the device IP', () => {
    expect(privacy).toContain(GEOIP);
    // Approximate only: the health policy's precise-location sentence stays true.
    expect(health).toContain('we do not collect precise location');
  });

  it('POSTHOG-GEOIP-DISCLOSURE: backend analytics keeps the posthog-node default (no location on server events)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'analytics', 'analytics.service.ts'), 'utf8');
    expect(src).toContain('new PostHog(');
    expect(src).not.toMatch(/disableGeoip\s*:\s*false/);
  });

  it('PRIVACY-COMMUNITY-NAMES: both privacy pages say who sees a full name and what a client can do', () => {
    expect(FULL_NAME_VISIBILITY).toBe('clients');
    expect(COMMUNITY_VISIBILITY_TEXT).toContain('In most spaces, other members see your first name.');
    expect(COMMUNITY_VISIBILITY_TEXT).toContain(FULL_NAMES);
    expect(COMMUNITY_VISIBILITY_TEXT).toContain(CLIENT_CAN);
    for (const text of [privacy, health]) {
      expect(text).toContain(FULL_NAMES);
      expect(text).toContain(CLIENT_CAN);
      expect(text).not.toContain('can see your display name');
    }
  });

  it('PRIVACY-DELETE-NAV: /privacy and /terms name the coach button', () => {
    expect(privacy).toContain(
      'You can delete your account in the app: Settings, then Delete account (coaches: Delete my account).',
    );
    expect(terms).toContain(
      'delete your account in the app (Settings, then Delete account; coaches: Delete my account) or by email.',
    );
  });

  it('OPERATOR RULING (#1105 LEARN-FROZEN-MEDIA): /privacy says what a coach deletion leaves with clients', () => {
    const deletion = privacy.slice(privacy.indexOf('Deleting your account'));
    expect(deletion).toContain(
      'If you coach, deleting your account does not delete your clients: they keep their own data, the plans you assigned them, and the lessons they completed or that are in a course they are enrolled in, including the video or file each of those lessons plays. Only a client who keeps a lesson can open its video or file.',
    );
  });

  it('bumps the last-reviewed date for the changed copy', () => {
    expect(POLICY_LAST_REVIEWED >= '2026-10-19').toBe(true);
  });
});
