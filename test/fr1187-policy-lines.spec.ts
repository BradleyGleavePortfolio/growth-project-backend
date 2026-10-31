/**
 * FR-1187 (LS-1187 B2, LO-1187 own-PR B): the three new policy lines, each once
 * in its section. None may merge before the owner approves the exact words
 * (A1.5, owner rule 137-2; the PR body's "Wording needed" table).
 *   FR1187-W1  /consumer-health-privacy "Categories we share": OpenAI, in the
 *              words of the approved Privacy Policy line (#184-W8).
 *   FR1187-W2  /privacy "What we collect": Community photos.
 *   FR1187-W3  both pages, where they describe the photo check: a self-harm
 *              refusal alerts the coach (alertCoachOfPhotoSafety).
 */
import { PHOTO_CHECK_ALERT_TEXT, renderTrustPage } from '../src/public-pages/trust-pages.html';
import type { TrustPage } from '../src/public-pages/trust-pages.html';

const ALL_TRUST_PAGES: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];

const OPENAI_LINE =
  'OpenAI — an automatic safety check of photos posted in Community, before they appear. It receives the photo and its caption, with no name or account details.';
const PHOTOS_LINE = 'Community photos — the photos you post in a community space, and their captions.';
const ALERT_LINE =
  'If the photo check refuses a photo or caption for self-harm, your coach gets a safety alert, and so do the coach and team who run a public space; the alert does not show the photo or caption.';

const ENTITIES: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s: string): string => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => ENTITIES[m] ?? m);

/** One section's list items and paragraphs, as the reader sees them. */
function section(page: 'privacy' | 'consumer-health', heading: string): { items: string[]; paragraphs: string[] } {
  const html = renderTrustPage(page);
  const start = html.indexOf(`<h2>${heading}</h2>`);
  expect(start).toBeGreaterThan(0);
  const body = html.slice(start, html.indexOf('</section>', start));
  const all = (tag: string) => [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => decode(m[1]));
  return { items: all('li'), paragraphs: all('p') };
}
const times = (list: string[], line: string) => list.filter((x) => x === line).length;
const onPage = (page: 'privacy' | 'consumer-health', line: string) => decode(renderTrustPage(page)).split(line).length - 1;

describe('FR-1187: the policy lines for the photo check', () => {
  it('the shared alert sentence is the drafted wording', () => {
    expect(PHOTO_CHECK_ALERT_TEXT).toBe(ALERT_LINE);
  });

  it('W1: /consumer-health-privacy "Categories we share" names OpenAI once, in the approved words', () => {
    const { items } = section('consumer-health', 'Categories we share');
    expect(times(items, OPENAI_LINE)).toBe(1);
    expect(onPage('consumer-health', OPENAI_LINE)).toBe(1);
  });

  it('W1: the Privacy Policy keeps the approved line, once, in "Service providers"', () => {
    expect(times(section('privacy', 'Service providers').items, OPENAI_LINE)).toBe(1);
    expect(onPage('privacy', OPENAI_LINE)).toBe(1);
  });

  it('W2: /privacy "What we collect" names Community photos once, right after community content', () => {
    const { items } = section('privacy', 'What we collect');
    expect(times(items, PHOTOS_LINE)).toBe(1);
    expect(items[items.indexOf(PHOTOS_LINE) - 1]).toMatch(/^Messages and community content — /);
    expect(onPage('privacy', PHOTOS_LINE)).toBe(1);
  });

  it('W3: /privacy "Service providers" closes with the alert line, once', () => {
    const { paragraphs } = section('privacy', 'Service providers');
    expect(times(paragraphs, ALERT_LINE)).toBe(1);
    expect(onPage('privacy', ALERT_LINE)).toBe(1);
  });

  it('W3: /consumer-health-privacy "Categories we share" has the alert line once, right after OpenAI', () => {
    const { items } = section('consumer-health', 'Categories we share');
    expect(times(items, ALERT_LINE)).toBe(1);
    expect(items[items.indexOf(ALERT_LINE) - 1]).toBe(OPENAI_LINE);
    expect(onPage('consumer-health', ALERT_LINE)).toBe(1);
  });

  it('the OpenAI and alert lines are on those two pages only', () => {
    for (const page of ALL_TRUST_PAGES) {
      if (page === 'privacy' || page === 'consumer-health') continue;
      const text = decode(renderTrustPage(page));
      expect(text).not.toContain(ALERT_LINE);
      expect(text).not.toContain(OPENAI_LINE);
    }
  });
});
