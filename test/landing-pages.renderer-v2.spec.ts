/**
 * R52 landing-page renderer v2 tests.
 *
 * Asserts the SaaS-brand token replacement, the 7-section persuasion arc
 * support, entrance motion CSS, reduced-motion respect, post-submit
 * celebration markup, accent-picker preset matching, and the absence of
 * legacy course-brand tokens in the output.
 */

import {
  renderPublicPage,
  renderNotFound,
  type PageWithContext,
} from '../src/landing-pages/landing-pages.html';
import {
  ProblemSolutionPayloadSchema,
  MechanismPayloadSchema,
  TrustPayloadSchema,
  validateSectionPayload,
} from '../src/landing-pages/section-schemas';

// ─── Fixture builder ─────────────────────────────────────────────────────────

function buildPage(overrides: Partial<PageWithContext> = {}): PageWithContext {
  const base: any = {
    id: 'page-1',
    coach_id: 'coach-1',
    slug: 'transform',
    template: 'transformation',
    status: 'published',
    headline: 'A calmer body, a steadier life.',
    subheadline: 'Premium one-to-one coaching.',
    hero_image_url: 'https://cdn.example.com/hero.jpg',
    accent_color: '#d4a574',
    primary_cta_type: 'lead_form',
    primary_cta_label: 'Apply privately',
    package_ids: [],
    lead_capture_fields: ['name', 'email'],
    crm_integration_id: null,
    custom_domain: null,
    custom_domain_verified_at: null,
    published_at: new Date('2024-01-01'),
    unpublished_at: null,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    sections: [],
    coach: {
      id: 'coach-1',
      name: 'Jane Smith',
      coach_practice_type: 'fitness',
      coach_profile: {
        business_name: 'Jane Smith Coaching',
        bio: 'I help busy professionals build a steadier baseline.',
        branding_accent_color: '#d4a574',
        branding_logo_url: null,
        invite_code: 'jsmith',
      },
    },
  };
  return { ...base, ...overrides } as PageWithContext;
}

function sec(kind: string, payload: Record<string, unknown>): any {
  return {
    id: `sec-${kind}`,
    page_id: 'page-1',
    kind,
    order_index: 0,
    payload,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
  };
}

const BASE_URL = 'https://app.trygrowthproject.com';

// ─── Brand tokens ────────────────────────────────────────────────────────────

describe('R52 SaaS-brand tokens', () => {
  it('inlines the dark-mode background + warm gold accent in critical CSS', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    expect(html).toContain('--bg: #0b0b0c');
    expect(html).toContain('--surface: #131316');
    expect(html).toContain('--ink: #f3f3f3');
    expect(html).toContain('--accent: #d4a574');
    expect(html).toContain('--cream: #f5efe6');
  });

  it('uses Geist Sans for body and Fraunces for display', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    expect(html).toMatch(/--font-body:\s*'Geist Sans'/);
    expect(html).toMatch(/--font-display:\s*'Fraunces'/);
  });

  it('does NOT emit any of the legacy course-brand token strings', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    // The PR explicitly bans these — they belong to the founder brand, not SaaS.
    const banned = ['#0d4f3c', '#a8873a', 'oxblood', '--forest', '--bone'];
    for (const token of banned) {
      expect(html.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it('audit P0 backstop — extended banned-token list (teal/hydra/forest/GT Sectra)', () => {
    // Renders every section kind we know about (so any kind-specific
    // stylesheet leak surfaces here, not just hero) plus an explicit
    // accent value (proves accent resolution can't sneak a banned hex in).
    const html = renderPublicPage(
      buildPage({
        accent_color: '#d4a574',
        sections: [
          sec('hero', { headline: 'h', subheadline: 's' }),
          sec('problem_solution', { problem_title: 'p', problem_body: 'pb', solution_title: 's', solution_body: 'sb' }),
          sec('mechanism', { steps: [{ title: 'a', body: 'b' }, { title: 'c', body: 'd' }, { title: 'e', body: 'f' }] }),
          sec('trust', { credentials: ['x'], numbers: [{ value: '1', label: 'l' }] }),
          sec('testimonials', { items: [{ name: 'A', quote: 'q', result_metric: '-1 lb' }] }),
          sec('lead_form', { fields: ['name', 'email'] }),
          sec('faq', { items: [{ question: 'q', answer: 'a' }] }),
        ],
      }),
      [], 'jsmith', BASE_URL,
    );
    const banned = [
      '#0d4f3c',   // founder forest green
      'oxblood',   // founder accent
      'teal',      // never canonical for SaaS palette
      'hydra',     // legacy product code
      'forest',    // banned per task spec
      'GT Sectra', // founder display font
      '#a8873a',   // legacy gold variant
    ];
    const lower = html.toLowerCase();
    for (const token of banned) {
      expect(lower).not.toContain(token.toLowerCase());
    }
  });

  it('sets dark color-scheme + theme-color meta so mobile chrome matches', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    expect(html).toContain('<meta name="color-scheme" content="dark"');
    expect(html).toContain('<meta name="theme-color" content="#0b0b0c"');
  });
});

// ─── Accent picker ───────────────────────────────────────────────────────────

describe('R52 accent picker (4 presets)', () => {
  it('maps gold preset by exact hex match', () => {
    const html = renderPublicPage(buildPage({ accent_color: '#d4a574' }), [], 'jsmith', BASE_URL);
    expect(html).toContain('--accent: #d4a574');
    expect(html).toContain('--accent-hover: #e0b585');
  });

  it('maps sage preset by exact hex match', () => {
    const html = renderPublicPage(buildPage({ accent_color: '#5d7d65' }), [], 'jsmith', BASE_URL);
    expect(html).toContain('--accent: #5d7d65');
    expect(html).toContain('--accent-hover: #6e9077');
  });

  it('maps terracotta preset by name token', () => {
    const html = renderPublicPage(buildPage({ accent_color: 'terracotta' }), [], 'jsmith', BASE_URL);
    expect(html).toContain('--accent: #c87a5d');
  });

  it('maps slate preset by name token', () => {
    const html = renderPublicPage(buildPage({ accent_color: 'slate' }), [], 'jsmith', BASE_URL);
    expect(html).toContain('--accent: #4a5870');
  });

  it('falls back to gold default when accent_color is null / unknown hex', () => {
    const html1 = renderPublicPage(buildPage({ accent_color: null }), [], 'jsmith', BASE_URL);
    const html2 = renderPublicPage(buildPage({ accent_color: '#abcdef' }), [], 'jsmith', BASE_URL);
    expect(html1).toContain('--accent: #d4a574');
    expect(html2).toContain('--accent: #d4a574');
  });
});

// ─── Persuasion arc — 7 section kinds ────────────────────────────────────────

describe('R52 7-section persuasion arc', () => {
  it('renders the hero block with single CTA + headline measure cap', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('hero', { headline: 'A quieter calendar.', subheadline: 'Apply.' })],
      }),
      [],
      'jsmith',
      BASE_URL,
    );
    // Hero CTA + the v2 button system.
    expect(html).toContain('class="btn btn--primary"');
    // Hero h1 uses the display font scale.
    expect(html).toContain('A quieter calendar.');
  });

  it('renders problem_solution as a 2-card split with accent on the solution', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('problem_solution', {
          problem_title: 'Noise',
          problem_body: 'Too much.',
          solution_title: 'Quiet',
          solution_body: 'Bounded.',
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('Noise');
    expect(html).toContain('Quiet');
    expect(html).toContain('ps-card--solution');
  });

  it('renders mechanism as exactly 3 steps with numbered indices', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('mechanism', {
          steps: [
            { title: 'Step A', body: 'a' },
            { title: 'Step B', body: 'b' },
            { title: 'Step C', body: 'c' },
          ],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('step__num">1<');
    expect(html).toContain('step__num">2<');
    expect(html).toContain('step__num">3<');
    expect(html).toContain('Step A');
    expect(html).toContain('Step C');
  });

  it('renders trust with credentials + numeric proof', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('trust', {
          numbers: [{ value: '7yrs', label: 'Coaching' }, { value: '120+', label: 'Clients' }],
          credentials: ['NSCA-CSCS', 'PN-L1'],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('7yrs');
    expect(html).toContain('Coaching');
    expect(html).toContain('NSCA-CSCS');
    expect(html).toContain('trust-num__value');
  });

  it('renders the lead form on a cream-inverted section', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('lead_form', { fields: ['name', 'email'], cta_label: 'Apply privately' })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('lp-section--cream');
    expect(html).toContain('id="lead-form"');
    expect(html).toContain('Apply privately');
  });

  it('renders FAQ as zero-JS details/summary accordion', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('faq', {
          items: [{ question: 'How long?', answer: '12 weeks.' }, { question: 'Refund?', answer: 'Yes.' }],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('<details class="faq-item');
    expect(html).toContain('<summary>How long?</summary>');
  });
});

// ─── Entrance motion ─────────────────────────────────────────────────────────

describe('R52 entrance motion', () => {
  it('emits the IntersectionObserver script + .reveal CSS', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    expect(html).toContain('IntersectionObserver');
    expect(html).toContain('.reveal');
    expect(html).toContain('.reveal.in-view');
  });

  it('respects prefers-reduced-motion via @media query', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    expect(html).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  });

  it('staggers reveal animations with custom-property --d', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('testimonials', {
          items: [
            { name: 'A', quote: 'q1', result_metric: '-10 lbs' },
            { name: 'B', quote: 'q2', result_metric: '-15 lbs' },
          ],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toMatch(/--d:\s*160ms/);
  });
});

// ─── Celebration ─────────────────────────────────────────────────────────────

describe('R52 post-submit celebration', () => {
  it('emits the celebration card + CSS confetti motes', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('lead_form', { fields: ['name', 'email'], cta_label: 'Send' })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('id="lead-celebration"');
    expect(html).toContain('class="celebrate"');
    expect(html).toContain('<span class="mote">');
    expect(html).toMatch(/@keyframes mote/);
  });

  it('the JS submit handler is hooked to the celebration element', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('lead_form', { fields: ['name', 'email'], cta_label: 'Send' })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain("getElementById('lead-form-el')");
    expect(html).toContain("getElementById('lead-celebration')");
    // The celebration line uses the coach's name from data-coach-name.
    expect(html).toContain('data-coach-name="Jane Smith"');
  });
});

// ─── Backwards compat (Phase 1/2 sections) ───────────────────────────────────

describe('R52 backwards compat — legacy section kinds', () => {
  it('still renders before_after pairs', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('before_after', {
          pairs: [{
            before_url: 'https://cdn.example.com/b.jpg',
            after_url: 'https://cdn.example.com/a.jpg',
            date_label: '12 weeks',
            caption: 'Lost 24 lbs.',
          }],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('Lost 24 lbs.');
    expect(html).toContain('legacy-ba');
  });

  it('still renders pricing cards with checkout URLs', () => {
    const pkg: any = {
      id: 'pkg-1', name: '12-week Sprint', amount_cents: 99900,
      currency: 'USD', billing_type: 'one_time', interval: null,
      description: 'Full program.', is_active: true,
      share_token: 'tok',
    };
    const html = renderPublicPage(
      buildPage({
        sections: [sec('pricing', { package_ids: ['pkg-1'], highlighted_id: 'pkg-1' })],
      }),
      [pkg], 'jsmith', BASE_URL,
    );
    expect(html).toContain('12-week Sprint');
    expect(html).toContain('$999');
    expect(html).toContain('/p/jsmith/transform/checkout?tier=pkg-1');
  });

  it('still renders guarantee block', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('guarantee', { title: '14-day promise', body: 'No questions.', days: 14 })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('14-day promise');
    expect(html).toContain('legacy-guarantee');
  });

  it('still renders offer_stack rows', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('offer_stack', {
          items: [{ title: 'Weekly check-ins', value_line: '52 sessions / year', value_dollars: 2400 }],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('Weekly check-ins');
    expect(html).toContain('$2400');
  });
});

// ─── Security carryovers (must still hold) ───────────────────────────────────

describe('R52 security carryovers', () => {
  it('escapes </script> breakout in JSON-LD via coach name', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const page = buildPage();
    (page.coach as any).name = evil;
    const html = renderPublicPage(page, [], 'jsmith', BASE_URL);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('rejects javascript: URLs in hero image (substitutes #)', () => {
    const page = buildPage({ hero_image_url: 'javascript:alert(1)' as any });
    page.sections = [sec('hero', { hero_image_url: 'javascript:alert(1)' })];
    const html = renderPublicPage(page, [], 'jsmith', BASE_URL);
    expect(html).not.toContain('javascript:');
  });
});

// ─── Section schemas (the three new kinds) ───────────────────────────────────

describe('R52 section schemas', () => {
  it('problem_solution accepts a valid payload', () => {
    const v = validateSectionPayload('problem_solution', {
      problem_title: 'X',
      problem_body: 'Y',
      solution_title: 'A',
      solution_body: 'B',
    });
    expect(v.ok).toBe(true);
  });

  it('mechanism enforces exactly 3 steps', () => {
    const two = validateSectionPayload('mechanism', {
      steps: [{ title: 'a', body: 'b' }, { title: 'c', body: 'd' }],
    });
    expect(two.ok).toBe(false);

    const four = validateSectionPayload('mechanism', {
      steps: Array(4).fill({ title: 't', body: 'b' }),
    });
    expect(four.ok).toBe(false);

    const three = validateSectionPayload('mechanism', {
      steps: [
        { title: 'a', body: 'aa' },
        { title: 'b', body: 'bb' },
        { title: 'c', body: 'cc' },
      ],
    });
    expect(three.ok).toBe(true);
  });

  it('trust requires at least one number or credential', () => {
    const empty = validateSectionPayload('trust', { numbers: [], credentials: [] });
    expect(empty.ok).toBe(false);

    const okNums = validateSectionPayload('trust', {
      numbers: [{ value: '7yrs', label: 'coaching' }],
      credentials: [],
    });
    expect(okNums.ok).toBe(true);
  });
});

// ─── Performance budget proxy ────────────────────────────────────────────────

describe('R52 performance budget', () => {
  it('emits hero img with loading=eager + fetchpriority=high', () => {
    const html = renderPublicPage(
      buildPage({ sections: [sec('hero', {})] }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
  });

  it('emits all non-hero images with loading=lazy', () => {
    const html = renderPublicPage(
      buildPage({
        sections: [sec('testimonials', {
          items: [{
            name: 'A',
            quote: 'q',
            result_metric: '-10 lbs',
            photo_url: 'https://cdn.example.com/a.jpg',
          }],
        })],
      }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toMatch(/<img class="t-card__avatar"[^>]*loading="lazy"/);
  });

  it('keeps the inline JS bundle small (no framework, no canvas-confetti)', () => {
    const html = renderPublicPage(buildPage(), [], 'jsmith', BASE_URL);
    // Sanity: a heavy framework shouldn't sneak in.
    expect(html).not.toContain('react');
    expect(html).not.toContain('canvas-confetti');
  });
});

// ─── Not-found page parity ───────────────────────────────────────────────────

describe('R52 renderNotFound', () => {
  it('uses the same SaaS tokens', () => {
    const html = renderNotFound();
    expect(html).toContain('#0b0b0c');
    expect(html).toContain('#d4a574');
    expect(html).toContain('Fraunces');
  });

  it('emits noindex,nofollow + color-scheme dark', () => {
    const html = renderNotFound();
    expect(html).toContain('noindex,nofollow');
    expect(html).toContain('color-scheme');
    expect(html).toContain('content="dark"');
  });
});

// ─── audit P1-2: proofLine wiring ────────────────────────────────────────────

describe('R52 audit P1-2 — proofLine under hero CTA', () => {
  function pageWithBio(bio: string | null): PageWithContext {
    const base = buildPage({
      // Hero only renders via the dispatch when a `hero` section is on the
      // page — without it the proof line has nowhere to land.  The
      // payload is empty so the renderer falls back to page.headline.
      sections: [sec('hero', {})],
    });
    return {
      ...base,
      coach: {
        ...(base as any).coach,
        coach_profile: {
          ...((base as any).coach.coach_profile),
          bio,
        },
      },
    } as PageWithContext;
  }

  it('renders the proof line when coach.coach_profile.bio is set', () => {
    const html = renderPublicPage(
      pageWithBio('Five years of one-to-one coaching for busy professionals.'),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toMatch(/<p class="hero__proof">[^<]*Five years of one-to-one coaching[^<]*<\/p>/);
  });

  it('caps the proof line at 140 chars', () => {
    const longBio = 'a'.repeat(500);
    const html = renderPublicPage(pageWithBio(longBio), [], 'jsmith', BASE_URL);
    const match = html.match(/<p class="hero__proof">([^<]*)<\/p>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(140);
  });

  it('collapses internal whitespace so multi-line bios fit on one line', () => {
    const html = renderPublicPage(
      pageWithBio('Line one.\nLine two.\n\nLine three.'),
      [], 'jsmith', BASE_URL,
    );
    // After collapse-and-cap, the proof line contains single spaces and
    // no embedded \n.  Match is anchored to the rendered <p>.
    expect(html).toContain('<p class="hero__proof">Line one. Line two. Line three.</p>');
  });

  it('omits the proof line element entirely when bio is null', () => {
    // The .hero__proof CSS rule is always emitted in the critical CSS
    // block; what we're asserting is that no <p> instance gets rendered.
    const html = renderPublicPage(pageWithBio(null), [], 'jsmith', BASE_URL);
    expect(html).not.toMatch(/<p class="hero__proof">/);
  });

  it('omits the proof line element when bio is the empty string', () => {
    const html = renderPublicPage(pageWithBio(''), [], 'jsmith', BASE_URL);
    expect(html).not.toMatch(/<p class="hero__proof">/);
  });
});

// ─── audit P1-3: lead-form failure UX ────────────────────────────────────────

describe('R52 audit P1-3 — lead-form failure UX', () => {
  it('emits the hidden error container with the alert role', () => {
    const html = renderPublicPage(
      buildPage({ sections: [sec('lead_form', { fields: ['name', 'email'] })] }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('id="lead-form-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    // Hidden by default — only flipped on by the submit handler.
    expect(html).toMatch(/id="lead-form-error"[^>]*hidden/);
  });

  it('gives the submit button an id + a disabled-state stylesheet rule', () => {
    const html = renderPublicPage(
      buildPage({ sections: [sec('lead_form', { fields: ['name', 'email'] })] }),
      [], 'jsmith', BASE_URL,
    );
    // Button id is used by the failure handler to re-enable the submit.
    expect(html).toContain('id="lead-form-submit"');
    // Disabled-state styling so a long-running fetch shows "in progress".
    expect(html).toContain('.lead-form__submit:disabled');
  });

  it('uses the SaaS error token color (#d97757) for the failure box', () => {
    const html = renderPublicPage(
      buildPage({ sections: [sec('lead_form', { fields: ['name', 'email'] })] }),
      [], 'jsmith', BASE_URL,
    );
    expect(html).toContain('#d97757');
  });

  it('wires the submit handler to surface non-2xx + network errors', () => {
    const html = renderPublicPage(
      buildPage({ sections: [sec('lead_form', { fields: ['name', 'email'] })] }),
      [], 'jsmith', BASE_URL,
    );
    // 429 path gets dedicated copy.
    expect(html).toContain("too many submissions");
    // Generic non-2xx fallback.
    expect(html).toContain('Something went wrong. Please try again.');
    // Network drop branch (offline / connection refused).
    expect(html).toContain("Couldn't reach the server");
    // Re-enables submit on failure (audit P1-3 requirement).
    expect(html).toContain('submitBtn.disabled = false');
  });
});
