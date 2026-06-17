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

// JobListingService — verified-hirer CRUD + publish/close. RLS (TM-1) scopes
// writes to the owner; this layer adds lifecycle rules + owning-hirer asserts.
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
    // Editing type or terms re-checks the pair so the JSONB shape stays coherent.
    if (dto.compensation_type !== undefined || dto.compensation_terms !== undefined) {
      const nextType = dto.compensation_type ?? listing.compensation_type;
      const rawTerms =
        dto.compensation_terms ??
        (listing.compensation_terms as Record<string, unknown>);
      data.compensation_type = nextType;
      data.compensation_terms = this.validateCompensationTerms(nextType, rawTerms);
    }
    return this.prisma.jobListing.update({ where: { id: listingId }, data });
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

  // Asserts the caller owns the listing — precise 404/403 over an RLS miss.
  private async requireOwnedListing(hirerId: string, listingId: string) {
    const listing = await this.prisma.jobListing.findUnique({
      where: { id: listingId },
    });
    if (!listing) throw new NotFoundException({ kind: 'job_listing_not_found' });
    if (listing.hirer_id !== hirerId) {
      throw new ForbiddenException({ kind: 'job_listing_not_owned' });
    }
    return listing;
  }

  // Validates+normalizes compensation_terms per type: commission{rate_pct},
  // rev_share{rate_pct,cap_usd?}, flat{amount_usd,period}, hybrid{base_usd,rate_pct}.
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
        const rate_pct = this.pct(terms, 'rate_pct');
        const hasCap = terms.cap_usd !== undefined && terms.cap_usd !== null;
        return hasCap ? { rate_pct, cap_usd: this.money(terms, 'cap_usd') } : { rate_pct };
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
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)
      throw this.badTerms(`${key} must be a number between 0 and 100`);
    return v;
  }

  private money(terms: Record<string, unknown>, key: string): number {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw this.badTerms(`${key} must be a non-negative number`);
    return v;
  }

  private period(terms: Record<string, unknown>): string {
    const v = terms.period;
    if (v !== 'monthly' && v !== 'yearly' && v !== 'one_time')
      throw this.badTerms('period must be monthly, yearly, or one_time');
    return v;
  }

  private badTerms(message: string): BadRequestException {
    return new BadRequestException({ kind: 'invalid_compensation_terms', message });
  }
}
