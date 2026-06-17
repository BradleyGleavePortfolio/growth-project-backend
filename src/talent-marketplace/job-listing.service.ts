import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  CompensationTypeValue,
  CreateJobListingDto,
  UpdateJobListingDto,
} from './job-listing.dto';

// JobListingService — verified-hirer CRUD + publish/close for the public job
// board. Write-scope (a hirer mutating only their OWN listing) and
// published-listings-are-public-read are enforced by the JobListing RLS
// policy from TM-1; this layer adds the application-level lifecycle rules
// (status transitions, compensation-term shape, owning-hirer assertion for a
// clear 404/403 instead of an RLS zero-row surprise).
@Injectable()
export class JobListingService {
  constructor(private readonly prisma: PrismaService) {}

  async create(hirerId: string, dto: CreateJobListingDto) {
    const compensationTerms = this.validateCompensationTerms(
      dto.compensation_type,
      dto.compensation_terms,
    );

    return this.prisma.jobListing.create({
      data: {
        hirer_id: hirerId,
        title: dto.title.trim(),
        description: dto.description,
        specialty: dto.specialty ?? null,
        location: dto.location ?? null,
        modality: dto.modality ?? null,
        compensation_type: dto.compensation_type,
        compensation_terms: compensationTerms,
        expectations: dto.expectations ?? null,
      },
    });
  }

  async edit(hirerId: string, listingId: string, dto: UpdateJobListingDto) {
    const listing = await this.requireOwnedListing(hirerId, listingId);
    if (listing.status === 'closed') {
      throw new BadRequestException({
        kind: 'job_listing_closed',
        message: 'A closed listing cannot be edited.',
      });
    }

    const data: Prisma.JobListingUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.specialty !== undefined) data.specialty = dto.specialty;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.modality !== undefined) data.modality = dto.modality;
    if (dto.expectations !== undefined) data.expectations = dto.expectations;

    // compensation_type and terms are co-validated: editing either re-checks
    // the pair against the resulting type so the JSONB shape stays coherent.
    const nextType = dto.compensation_type ?? listing.compensation_type;
    if (
      dto.compensation_type !== undefined ||
      dto.compensation_terms !== undefined
    ) {
      const rawTerms =
        dto.compensation_terms ??
        (listing.compensation_terms as Record<string, unknown>);
      data.compensation_type = nextType;
      data.compensation_terms = this.validateCompensationTerms(
        nextType,
        rawTerms,
      );
    }

    return this.prisma.jobListing.update({
      where: { id: listingId },
      data,
    });
  }

  async publish(hirerId: string, listingId: string) {
    const listing = await this.requireOwnedListing(hirerId, listingId);
    if (listing.status === 'published') return listing;
    if (listing.status === 'closed') {
      throw new BadRequestException({
        kind: 'job_listing_closed',
        message: 'A closed listing cannot be re-published.',
      });
    }

    return this.prisma.jobListing.update({
      where: { id: listingId },
      data: { status: 'published', published_at: new Date() },
    });
  }

  async close(hirerId: string, listingId: string) {
    const listing = await this.requireOwnedListing(hirerId, listingId);
    if (listing.status === 'closed') return listing;

    return this.prisma.jobListing.update({
      where: { id: listingId },
      data: { status: 'closed', closed_at: new Date() },
    });
  }

  // Resolves a listing and asserts the caller owns it. RLS already scopes
  // writes to the owner, but the hirer-write policy lets a hirer SELECT their
  // own draft rows, so a precise 404 (no such listing visible to you) /
  // 403 (visible but not yours) beats relying on an opaque update miss.
  private async requireOwnedListing(hirerId: string, listingId: string) {
    const listing = await this.prisma.jobListing.findUnique({
      where: { id: listingId },
    });
    if (!listing) {
      throw new NotFoundException({ kind: 'job_listing_not_found' });
    }
    if (listing.hirer_id !== hirerId) {
      throw new ForbiddenException({ kind: 'job_listing_not_owned' });
    }
    return listing;
  }

  // Validates compensation_terms against compensation_type and returns the
  // normalized object to persist. Ported shape (schema.prisma JobListing
  // comment):
  //   commission { rate_pct }
  //   rev_share  { rate_pct, cap_usd? }
  //   flat       { amount_usd, period }
  //   hybrid     { base_usd, rate_pct }
  private validateCompensationTerms(
    type: CompensationTypeValue,
    terms: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    if (terms === null || typeof terms !== 'object' || Array.isArray(terms)) {
      throw this.badTerms('compensation_terms must be an object');
    }

    switch (type) {
      case 'commission':
        return { rate_pct: this.pct(terms, 'rate_pct') };
      case 'rev_share': {
        const out: Prisma.InputJsonObject = {
          rate_pct: this.pct(terms, 'rate_pct'),
        };
        if (terms.cap_usd !== undefined && terms.cap_usd !== null) {
          out.cap_usd = this.money(terms, 'cap_usd');
        }
        return out;
      }
      case 'flat':
        return {
          amount_usd: this.money(terms, 'amount_usd'),
          period: this.period(terms),
        };
      case 'hybrid':
        return {
          base_usd: this.money(terms, 'base_usd'),
          rate_pct: this.pct(terms, 'rate_pct'),
        };
    }
  }

  private pct(terms: Record<string, unknown>, key: string): number {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw this.badTerms(`${key} must be a number between 0 and 100`);
    }
    return v;
  }

  private money(terms: Record<string, unknown>, key: string): number {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw this.badTerms(`${key} must be a non-negative number`);
    }
    return v;
  }

  private period(terms: Record<string, unknown>): string {
    const v = terms.period;
    if (v !== 'monthly' && v !== 'yearly' && v !== 'one_time') {
      throw this.badTerms('period must be monthly, yearly, or one_time');
    }
    return v;
  }

  private badTerms(message: string): BadRequestException {
    return new BadRequestException({ kind: 'invalid_compensation_terms', message });
  }
}
