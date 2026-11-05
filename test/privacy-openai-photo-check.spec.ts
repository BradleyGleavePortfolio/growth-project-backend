/**
 * PERM-W5 (agent 185, owner "#184-W8 - approved", 19:07 PDT 10-29): the
 * Privacy Policy's "Service providers" list names OpenAI for the automatic
 * photo check (src/community/images/community-photo-check.ts), word for word,
 * in the AI group right after Anthropic. What the check sends is pinned by
 * test/community/images/community-photo-check.e2e.spec.ts (the request is only
 * the model and one photo or caption input; no member, space or storage key)
 * and test/ai-egress/openai-moderation-egress.spec.ts (no organization or
 * project header), so the line stays true.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { POLICY_LAST_REVIEWED, renderTrustPage } from '../src/public-pages/trust-pages.html';

const LINE =
  'OpenAI — an automatic safety check of photos posted in Community, before they appear. It receives the photo and its caption, with no name or account details.';

const ENTITIES: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s: string): string => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => ENTITIES[m] ?? m);

/** The bullets of one section of a rendered trust page, as the reader sees them. */
function sectionBullets(html: string, heading: string): string[] {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  if (start < 0) return [];
  const end = html.indexOf('</section>', start);
  return [...html.slice(start, end).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decode(m[1]));
}

describe('PERM-W5: the Privacy Policy names OpenAI for the photo check', () => {
  const html = renderTrustPage('privacy');

  it('shows the approved line word for word in "Service providers", once on the page', () => {
    const bullets = sectionBullets(html, 'Service providers');
    expect(bullets).toContain(LINE);
    expect(bullets.filter((b) => b.startsWith('OpenAI'))).toEqual([LINE]);
    expect(decode(html).split(LINE)).toHaveLength(2);
  });

  it('sits in the AI group: right after Anthropic, before Perplexity; no other bullet moved', () => {
    const names = sectionBullets(html, 'Service providers').map((b) => b.split(' — ')[0].split(',')[0]);
    expect(names).toEqual([
      'Supabase',
      'Fly.io',
      'Stripe',
      'Anthropic',
      'OpenAI',
      'Perplexity',
      'PostHog',
      'Sentry',
      'Crisp',
      'Resend',
      'Mux',
      'Expo',
      'Apple and Google',
      'Apple Health (iPhone) and Health Connect (Android)',
      'USDA FoodData Central and Open Food Facts',
    ]);
  });

  it('bumps the Last reviewed date shown at the top, as the policy says it does', () => {
    expect(POLICY_LAST_REVIEWED >= '2026-10-30').toBe(true);
    expect(html).toContain(`Last reviewed ${POLICY_LAST_REVIEWED}`);
  });

  it('the vendor record no longer says the policy does not name OpenAI', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'privacy', 'vendor-deletion-and-backups.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| OpenAI (automatic photo check'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/does not name OpenAI/);
    expect(row).toContain('Named in the Privacy Policy "Service providers" list');
  });
});
