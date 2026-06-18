import { buildJobPostingJsonLd } from '../job-posting-jsonld';
import type { PublicListingDetailDto } from '../public-listing.dto';

// TM-3 schema.org JobPosting builder — pure shaping function consumed by TM-W2.
// These specs lock the emitted shape: required @context/@type/identifier always
// present, optional fields OMITTED (not null) when the source is absent, and the
// builder stays PII-free by construction (it only reads the allow-list DTO).

function detail(over: Partial<PublicListingDetailDto> = {}): PublicListingDetailDto {
  return {
    id: 'listing-1',
    title: 'Head Coach Wanted',
    specialty: 'Strength',
    location: 'United Kingdom',
    modality: 'remote',
    compensation_summary: '20% commission',
    published_at: '2026-06-10T08:00:00.000Z',
    cta_listing_id: 'listing-1',
    description: 'Lead a regional squad of coaches.',
    compensation_type: 'commission',
    compensation_terms: { rate_pct: 20 },
    expectations: '10 sessions / week',
    created_at: '2026-06-10T08:00:00.000Z',
    ...over,
  };
}

describe('buildJobPostingJsonLd', () => {
  it('emits the required schema.org JobPosting envelope', () => {
    const ld = buildJobPostingJsonLd(detail());
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('Head Coach Wanted');
    expect(ld.description).toBe('Lead a regional squad of coaches.');
    expect(ld.identifier).toEqual({
      '@type': 'PropertyValue',
      name: 'TGP Talent Marketplace',
      value: 'listing-1',
    });
  });

  it('maps published/specialty/location/modality onto the optional fields', () => {
    const ld = buildJobPostingJsonLd(detail());
    expect(ld.datePosted).toBe('2026-06-10T08:00:00.000Z');
    expect(ld.occupationalCategory).toBe('Strength');
    expect(ld.jobLocationType).toBe('remote');
    expect(ld.applicantLocationRequirements).toEqual({
      '@type': 'Country',
      name: 'United Kingdom',
    });
  });

  it('OMITS optional keys (not null) when the source fields are absent', () => {
    const ld = buildJobPostingJsonLd(
      detail({
        published_at: null,
        specialty: null,
        location: null,
        modality: null,
      }),
    );
    expect('datePosted' in ld).toBe(false);
    expect('occupationalCategory' in ld).toBe(false);
    expect('jobLocationType' in ld).toBe(false);
    expect('applicantLocationRequirements' in ld).toBe(false);
  });

  it('is PII-free by construction (no hirer/applicant fields can appear)', () => {
    // The builder's input type is the allow-list DTO, so there is structurally
    // no PII to leak; assert the emitted JSON carries none of the public-blob's
    // own private-sounding keys either.
    const serialized = JSON.stringify(buildJobPostingJsonLd(detail()));
    expect(serialized).not.toContain('idempotency');
    expect(serialized).not.toContain('applicantEmail');
    expect(serialized).not.toContain('applicantName');
    expect(serialized).not.toContain('hirerEmail');
    expect(serialized).not.toContain('hirerName');
    expect(serialized).not.toContain('hirer_id');
    expect(serialized).not.toContain('owner_id');
  });

  it('DROPS rogue PII keys present on the input object (builder copies named fields only)', () => {
    // A-P2-2 / B-P2-3: the assertion above is true by construction because the
    // fixture has no PII. This case proves the BUILDER actively drops unknown
    // keys rather than relying solely on the type system: attach real PII fields
    // to the runtime object (via Object.assign — NOT a banned blanket
    // escape-hatch cast) and assert neither the keys NOR their values survive into the
    // emitted JSON-LD. This is what would catch a future builder that spread the
    // input instead of copying allow-listed fields.
    const polluted = Object.assign(detail(), {
      hirerEmail: 'hirer-secret@example.com',
      hirerName: 'Secret Hirer',
      applicantEmail: 'applicant-secret@example.com',
      applicantName: 'Secret Applicant',
      hirer_id: 'hirer-SECRET-001',
      owner_id: 'owner-SECRET-001',
      idempotency_key: 'idem-SECRET-key',
    }) as PublicListingDetailDto;

    const serialized = JSON.stringify(buildJobPostingJsonLd(polluted));

    // Keys must not appear…
    expect(serialized).not.toContain('hirerEmail');
    expect(serialized).not.toContain('hirerName');
    expect(serialized).not.toContain('applicantEmail');
    expect(serialized).not.toContain('applicantName');
    expect(serialized).not.toContain('hirer_id');
    expect(serialized).not.toContain('owner_id');
    expect(serialized).not.toContain('idempotency');
    // …and neither must their values.
    expect(serialized).not.toContain('hirer-secret@example.com');
    expect(serialized).not.toContain('Secret Hirer');
    expect(serialized).not.toContain('applicant-secret@example.com');
    expect(serialized).not.toContain('Secret Applicant');
    expect(serialized).not.toContain('hirer-SECRET-001');
    expect(serialized).not.toContain('owner-SECRET-001');
    expect(serialized).not.toContain('idem-SECRET-key');

    // The legitimate, allow-listed content still emits correctly.
    const ld = buildJobPostingJsonLd(polluted);
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.identifier.value).toBe('listing-1');
    expect(ld.title).toBe('Head Coach Wanted');
  });
});
