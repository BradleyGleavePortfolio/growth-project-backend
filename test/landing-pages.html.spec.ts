/**
 * Security unit tests for the SSR HTML renderer.
 *
 * These tests specifically cover the two injection fixes shipped in the
 * P0/P1 security patch (PR #271):
 *
 *   P0 — Stored XSS via JSON-LD </script> breakout (coach name / bio)
 *   P1 — CSS injection via hero background-image url('...') apostrophe decode
 *
 * We exercise `renderPublicPage` directly with crafted payloads and assert
 * that the rendered HTML does NOT contain the raw attack strings.
 */

import { renderPublicPage, type PageWithContext } from '../src/landing-pages/landing-pages.html';

// ─── Minimal valid fixture ────────────────────────────────────────────────────

/** A minimal hero section so `renderHero` is exercised on every render. */
const heroSection: any = {
  id: 'section-1',
  page_id: 'page-1',
  kind: 'hero',
  order_index: 0,
  payload: {},
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
};

/** A minimal CoachLandingPage row that satisfies TypeScript without Prisma. */
const validPage: PageWithContext = {
  id: 'page-1',
  coach_id: 'coach-1',
  slug: 'test-page',
  template: 'transformation' as any,
  status: 'published' as any,

  headline: 'Transform your fitness',
  subheadline: 'Work with a world-class coach',
  hero_image_url: 'https://cdn.example.com/hero.jpg',
  accent_color: '#c8a96e',

  primary_cta_type: 'checkout' as any,
  primary_cta_label: 'Get Started',

  package_ids: [],
  lead_capture_fields: ['name', 'email'],
  crm_integration_id: null,

  // Dates / timestamps
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
  published_at: new Date('2024-01-01'),
  unpublished_at: null,

  // Nullables
  custom_domain: null,
  custom_domain_verified_at: null,
  crm_integration: null,

  // Include a hero section so renderHero is always exercised
  sections: [heroSection],

  coach: {
    id: 'coach-1',
    name: 'Jane Smith',
    coach_practice_type: 'fitness',
    coach_profile: {
      business_name: 'Jane Smith Coaching',
      bio: 'I help people reach their goals.',
      branding_accent_color: '#c8a96e',
      branding_logo_url: null,
      invite_code: 'jsmith',
    },
  },
} as unknown as PageWithContext;

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Render a page by merging overrides into the baseline fixture. */
function renderPage(overrides: Partial<PageWithContext> & { coach_name?: string }): string {
  const { coach_name, coach: coachOverride, ...rest } = overrides as any;
  const page: PageWithContext = {
    ...validPage,
    ...rest,
    coach: {
      ...validPage.coach,
      ...coachOverride,
      ...(coach_name ? { name: coach_name } : {}),
    },
  } as unknown as PageWithContext;
  return renderPublicPage(page, [], 'jane-smith', 'https://app.trygrowthproject.com');
}

/** Extract the raw content between the first JSON-LD script tags. */
function extractJsonLd(html: string): string {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No JSON-LD block found in rendered HTML');
  return match[1];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SSR renderer security', () => {
  // ── P0: JSON-LD </script> breakout ────────────────────────────────────────

  it('escapes </script> in JSON-LD via U+003C / U+003E escape (P0 XSS — coach name)', () => {
    const html = renderPage({
      coach_name: '</script><img src=x onerror=alert(1)>',
    });

    // The literal attack string must NOT appear as raw HTML
    expect(html).not.toContain('</script><img');

    // The angle bracket must be unicode-escaped in the JSON-LD payload
    const jsonLdBlock = extractJsonLd(html);
    expect(jsonLdBlock).toContain('\\u003c');
    expect(jsonLdBlock).toContain('\\u003e');
  });

  it('escapes </script> in JSON-LD (P0 XSS — bio / business name with < > characters)', () => {
    const html = renderPage({
      coach: {
        ...validPage.coach,
        coach_profile: {
          ...validPage.coach.coach_profile!,
          bio: '</script><script>alert(2)</script>',
          business_name: 'Acme</script>evil',
        },
      },
    } as any);

    // The raw attack string must not be present as parseable HTML
    expect(html).not.toContain('</script><script>');

    // The JSON-LD block must contain unicode escapes for the angle brackets
    const jsonLdBlock = extractJsonLd(html);
    expect(jsonLdBlock).toContain('\\u003c');
  });

  it('escapes U+2028 line separator in JSON-LD (P0 XSS — line terminator)', () => {
    const html = renderPage({ coach_name: 'a\u2028b' });

    // The raw line separator must not appear inside the JSON-LD block
    const jsonLdBlock = extractJsonLd(html);
    expect(jsonLdBlock).not.toContain('\u2028');
    expect(jsonLdBlock).toContain('\\u2028');
  });

  it('escapes U+2029 paragraph separator in JSON-LD (P0 XSS — paragraph terminator)', () => {
    const html = renderPage({ coach_name: 'a\u2029b' });

    const jsonLdBlock = extractJsonLd(html);
    expect(jsonLdBlock).not.toContain('\u2029');
    expect(jsonLdBlock).toContain('\\u2029');
  });

  it('escapes & in JSON-LD to prevent entity injection (P0 — ampersand)', () => {
    const html = renderPage({ coach_name: 'AT&T Coaching' });

    // The & inside the JSON-LD block must be escaped
    const jsonLdBlock = extractJsonLd(html);
    expect(jsonLdBlock).toContain('\\u0026');
    // Must not appear raw (which could be mis-decoded)
    expect(jsonLdBlock).not.toContain('"AT&T"');
  });

  it('produces valid JSON in the JSON-LD block after escaping (P0 — round-trip)', () => {
    const maliciousName = '</script><img src=x onerror=alert(1)>';
    const html = renderPage({ coach_name: maliciousName });

    // The escaped JSON must be parseable
    const jsonLdBlock = extractJsonLd(html);
    const parsed = JSON.parse(jsonLdBlock);

    // After round-tripping, the original string is recovered intact
    const personNode = parsed['@graph']?.find((n: any) => n['@type'] === 'Person');
    expect(personNode?.name).toBe(maliciousName);
  });

  // ── P1: CSS injection via background-image url('...') ────────────────────

  it('does NOT inline hero image url in style attribute — uses <img> instead (P1 CSS injection)', () => {
    const html = renderPage({
      hero_image_url: "https://example.com/x.jpg'); evil('",
    } as any);

    // No background-image CSS produced by renderHero (CSS classes only)
    expect(html).not.toMatch(/background-image\s*:\s*url\(/i);

    // The hero image must appear as an <img> element with class hero__bg
    expect(html).toMatch(/<img[^>]+class="hero__bg"/);
  });

  it('sanitizes hero_image_url with javascript: scheme (P1 — javascript: URL)', () => {
    const html = renderPage({
      hero_image_url: 'javascript:alert(1)',
    } as any);

    // escAttr rejects non-http(s)/non-relative URLs, substituting '#'
    expect(html).not.toContain('javascript:');
  });

  it('sanitizes hero_image_url with data: scheme (P1 — data: URL)', () => {
    const html = renderPage({
      hero_image_url: 'data:text/html,<script>alert(1)</script>',
    } as any);

    expect(html).not.toContain('data:text/html');
  });

  it('allows valid https hero_image_url and renders it in <img src> (P1 — happy path)', () => {
    const url = 'https://cdn.trygrowthproject.com/hero.jpg';
    const html = renderPage({ hero_image_url: url } as any);

    // Should appear as an img src attribute
    expect(html).toContain(`src="${url}"`);
    // Must NOT appear in a background-image context
    expect(html).not.toMatch(/background-image\s*:\s*url\(/i);
  });

  it('renders hero section without <img class="hero__bg"> when hero_image_url is empty (P1 — no URL)', () => {
    const html = renderPage({ hero_image_url: '' } as any);

    // When there is no image URL, no hero__bg img should appear
    expect(html).not.toMatch(/<img[^>]+class="hero__bg"/);
    // And no background-image either
    expect(html).not.toMatch(/background-image\s*:\s*url\(/i);
  });
});
