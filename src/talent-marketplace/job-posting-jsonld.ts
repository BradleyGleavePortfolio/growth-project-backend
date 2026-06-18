// TM-3 schema.org JobPosting payload builder. A pure function that shapes a
// published listing's PUBLIC fields into a JobPosting-compatible plain object
// for the TM-W2 web SEO page (rendered as <script type="application/ld+json">).
// PII-free by construction — it consumes only the allow-listed public detail
// DTO, never the raw entity. This builder does NOT render any page.

import type { PublicListingDetailDto } from './public-listing.dto';

// A minimal, typed subset of schema.org/JobPosting. Optional fields are omitted
// (not null) when the source field is absent so the emitted JSON-LD stays clean.
export interface JobPostingJsonLd {
  '@context': 'https://schema.org';
  '@type': 'JobPosting';
  title: string;
  description: string;
  identifier: {
    '@type': 'PropertyValue';
    name: string;
    value: string;
  };
  datePosted?: string;
  occupationalCategory?: string;
  jobLocationType?: string;
  applicantLocationRequirements?: { '@type': 'Country'; name: string };
}

export function buildJobPostingJsonLd(
  listing: PublicListingDetailDto,
): JobPostingJsonLd {
  const jsonLd: JobPostingJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: listing.title,
    description: listing.description,
    identifier: {
      '@type': 'PropertyValue',
      name: 'TGP Talent Marketplace',
      value: listing.id,
    },
  };
  if (listing.published_at) jsonLd.datePosted = listing.published_at;
  if (listing.specialty) jsonLd.occupationalCategory = listing.specialty;
  if (listing.location) {
    jsonLd.applicantLocationRequirements = {
      '@type': 'Country',
      name: listing.location,
    };
  }
  if (listing.modality) jsonLd.jobLocationType = listing.modality;
  return jsonLd;
}
