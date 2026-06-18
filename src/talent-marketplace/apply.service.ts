// PII guardrails (TM-5): never log raw email/phone/IP; applicants may read only
// their own applications (scoped to the JWT subject); fit-screen is in-house with
// no third-party PII fan-out; idempotency keys are namespaced per applicant.
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Applicant, Application } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  MARKETPLACE_CLAIM_STATUS_COMPLETED,
  MarketplaceIdempotencyService,
} from './marketplace-idempotency.service';
import { computeFitSignal } from './apply-fit';
import {
  buildTupleCursor,
  parseTupleCursor,
} from './application-cursor';
import type {
  ApplicantProfileDto,
  ApplyConfirmationDto,
  ApplyDto,
  FitSignalDto,
  MyApplicationCardDto,
  MyApplicationsQueryDto,
  MyApplicationsResponse,
  UpdateApplicantDto,
} from './apply.dto';

const APPLY_ROUTE_KEY = 'tm:listings:apply';
const MY_APPLICATIONS_DEFAULT_LIMIT = 20;
const MY_APPLICATIONS_MAX_LIMIT = 50;

// TM-5 — Apply funnel + pre-coach account + applicant profile.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII BOUNDARY. Every method returns an explicit allow-list DTO (toProfile / ║
// ║ toCard / toConfirmation below) — a raw Applicant / Application / User      ║
// ║ entity is NEVER returned or spread. Reads are owner-scoped at the service  ║
// ║ layer (applicant_user_id / user_id = caller) as defense-in-depth ON TOP of ║
// ║ the TM-1 RLS policies (anon → zero rows; cross-applicant SELECT denied).   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
@Injectable()
export class ApplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // POST /listings/:id/apply — the single anonymous-friendly funnel. Creates (or
  // reuses) a lightweight pre-coach account, ensures the Applicant profile, and
  // submits the Application — all idempotently. Returns a definitive
  // confirmation payload (luxury doctrine peak-end closure), never an empty 200.
  async apply(listingId: string, dto: ApplyDto): Promise<ApplyConfirmationDto> {
    const listing = await this.prisma.jobListing.findUnique({
      where: { id: listingId },
      select: { id: true, hirer_id: true, status: true, specialty: true, compensation_type: true },
    });
    if (!listing || listing.status !== 'published') {
      // Drafts/closed are invisible to the public applicant (mirrors RLS).
      throw new NotFoundException({ kind: 'job_listing_not_found' });
    }

    const email = dto.email.trim().toLowerCase();
    // Resolve or create the pre-coach account up front so the idempotency ledger
    // can key on a real user_id. Account-create is idempotent on email.
    const account = await this.resolveAccount(email, dto);

    // Per-(user, route) idempotency key: client-supplied or a deterministic
    // (account, listing) key so a double-tap without a header still replays.
    const idempotencyKey =
      dto.idempotency_key?.trim() ||
      `apply:${account.id}:${listing.id}`;
    const claimKey = {
      userId: account.id,
      routeKey: APPLY_ROUTE_KEY,
      idempotencyKey,
    };

    const claim = await this.idempotency.claimOrReplay(claimKey);
    if (claim.outcome === 'replay') {
      return this.fromLedger(claim.response);
    }
    if (claim.outcome === 'in_flight') {
      // A sibling submit owns this key right now — retryable, not a dupe.
      throw new ConflictException({ kind: 'apply_in_flight' });
    }

    try {
      const confirmation = await this.runApply(account, listing, dto, idempotencyKey);
      const completed = await this.idempotency.markCompleted(
        claimKey,
        claim.claimNonce,
        toLedgerJson(confirmation),
      );
      if (completed.outcome === 'conflict') {
        // Our claim was reclaimed mid-flight; the Application still exists. Read
        // it back idempotently rather than surfacing a 500.
        return this.recoverConfirmation(account, listing.id);
      }
      return confirmation;
    } catch (err) {
      // P2002 on Application.idempotency_key → a concurrent submit already
      // created the Application for this exact key. Recover it idempotently.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        await this.idempotency.releaseClaim(claimKey, claim.claimNonce);
        return this.recoverConfirmation(account, listing.id);
      }
      // Genuine failure — release the claim so a corrected retry can proceed.
      await this.idempotency.releaseClaim(claimKey, claim.claimNonce);
      throw err;
    }
  }

  // GET /applicants/me — the applicant's own pre-coach profile (reads-own).
  async getOwnProfile(userId: string): Promise<ApplicantProfileDto> {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
    });
    if (!applicant) throw new NotFoundException({ kind: 'applicant_not_found' });
    return this.toProfile(applicant);
  }

  // PATCH /applicants/me — update own profile only. The where-clause is pinned
  // to the caller's user_id so a forged id cannot touch another's row.
  async updateOwnProfile(
    userId: string,
    dto: UpdateApplicantDto,
  ): Promise<ApplicantProfileDto> {
    const existing = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ kind: 'applicant_not_found' });

    const data: Prisma.ApplicantUpdateInput = {};
    if (dto.first_name !== undefined) data.first_name = dto.first_name.trim();
    if (dto.last_name !== undefined) data.last_name = dto.last_name.trim();
    if (dto.headline !== undefined) data.headline = dto.headline;
    if (dto.bio !== undefined) data.bio = dto.bio;
    if (dto.specialties !== undefined) data.specialties = dto.specialties;
    if (dto.certifications !== undefined) data.certifications = dto.certifications;
    if (dto.years_experience !== undefined) data.years_experience = dto.years_experience;
    if (dto.sample_program_url !== undefined) data.sample_program_url = dto.sample_program_url;

    const updated = await this.prisma.applicant.update({
      where: { user_id: userId },
      data,
    });
    return this.toProfile(updated);
  }

  // GET /applicants/me/applications — keyset (created_at, id) tuple pagination,
  // scoped to the caller (applicant_user_id = self). Never offset.
  async myApplications(
    userId: string,
    query: MyApplicationsQueryDto,
  ): Promise<MyApplicationsResponse> {
    const limit = clampLimit(query.limit);
    const where: Prisma.ApplicationWhereInput = { applicant_user_id: userId };

    const cursor = query.cursor ? parseTupleCursor(query.cursor) : null;
    if (cursor) {
      where.AND = [
        {
          OR: [
            { created_at: { lt: cursor.created_at } },
            { created_at: cursor.created_at, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const rows = await this.prisma.application.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    // Hydrate the fit chip per row from the row's stored fit_score (cheap; no
    // per-row listing fetch). The stored score is the authoritative two-way
    // signal computed at submit; map it back to the one-chip shape.
    return {
      items: page.map((row) => this.toCard(row)),
      next_cursor: hasMore && last ? buildTupleCursor(last) : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  // The transactional apply body: ensure the Applicant profile then create the
  // Application carrying the computed fit forward. Runs as one interactive
  // transaction so a partial write never leaves an orphan profile/application.
  private async runApply(
    account: { id: string; email: string },
    listing: {
      id: string;
      hirer_id: string;
      specialty: string | null;
      compensation_type: 'commission' | 'rev_share' | 'flat' | 'hybrid';
    },
    dto: ApplyDto,
    idempotencyKey: string,
  ): Promise<ApplyConfirmationDto> {
    const fit = computeFitSignal({
      applicantSpecialties: dto.specialties ?? [],
      listingSpecialty: listing.specialty,
      listingCompensationType: listing.compensation_type,
    });

    const { applicant, application } = await this.prisma.$transaction(
      async (tx) => {
        const applicantRow = await tx.applicant.upsert({
          where: { user_id: account.id },
          create: {
            user_id: account.id,
            email: account.email,
            first_name: dto.first_name.trim(),
            last_name: dto.last_name.trim(),
            headline: dto.headline ?? null,
            bio: dto.bio ?? null,
            specialties: dto.specialties ?? [],
            certifications: dto.certifications ?? [],
            years_experience: dto.years_experience ?? null,
            sample_program_url: dto.sample_program_url ?? null,
          },
          update: {},
        });

        const applicationRow = await tx.application.create({
          data: {
            listing_id: listing.id,
            applicant_id: applicantRow.id,
            applicant_user_id: account.id,
            hirer_id: listing.hirer_id,
            cover_note: dto.cover_note ?? null,
            fit_score: fit.score,
            idempotency_key: `${idempotencyKey}:application`,
          },
        });
        return { applicant: applicantRow, application: applicationRow };
      },
    );

    return this.toConfirmation(account.id, applicant.id, application, fit);
  }

  // Resolve an existing account by email, or create a lightweight pre-coach one.
  // The pre-coach account carries a `precoach:` supabase_id placeholder — it is
  // NOT yet a real Supabase identity; TM-12 auto-flip links a real one at
  // conversion. Minimum fields only (Hick's law).
  private async resolveAccount(
    email: string,
    dto: ApplyDto,
  ): Promise<{ id: string; email: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });
    if (existing) return existing;

    try {
      const created = await this.prisma.user.create({
        data: {
          supabase_id: `precoach:${createHash('sha256').update(email).digest('hex')}`,
          email,
          name: `${dto.first_name.trim()} ${dto.last_name.trim()}`.trim(),
          role: 'student',
        },
        select: { id: true, email: true },
      });
      return created;
    } catch (err) {
      // Lost the email-uniqueness race with a concurrent first-apply — read the
      // winner's row back rather than failing.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // Re-derive the confirmation for an already-submitted application (idempotent
  // recovery after a P2002 race or a reclaimed claim) — owner-scoped read.
  private async recoverConfirmation(
    account: { id: string },
    listingId: string,
  ): Promise<ApplyConfirmationDto> {
    const application = await this.prisma.application.findFirst({
      where: { applicant_user_id: account.id, listing_id: listingId },
      orderBy: { created_at: 'desc' },
    });
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: account.id },
      select: { id: true },
    });
    if (!application || !applicant) {
      // Neither side committed — surface a true conflict, not a fake success.
      throw new ConflictException({ kind: 'apply_conflict' });
    }
    const fit = fitFromScore(application.fit_score);
    return this.toConfirmation(account.id, applicant.id, application, fit);
  }

  // Replay path: the ledger stored the verbatim confirmation JSON. Validate the
  // shape field-by-field before returning so a malformed ledger row degrades
  // loudly rather than smuggling an off-shape object past the type system.
  private fromLedger(response: Prisma.JsonValue): ApplyConfirmationDto {
    const dto = parseLedgerConfirmation(response);
    if (!dto) throw new ConflictException({ kind: 'apply_replay_corrupt' });
    return dto;
  }

  // ── allow-list mappers (the PII gate) ───────────────────────────────────────

  private toProfile(row: Applicant): ApplicantProfileDto {
    return {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      headline: row.headline,
      bio: row.bio,
      specialties: row.specialties,
      certifications: row.certifications,
      years_experience: row.years_experience,
      sample_program_url: row.sample_program_url,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private toCard(row: Application): MyApplicationCardDto {
    return {
      id: row.id,
      listing_id: row.listing_id,
      status: row.status,
      fit: fitFromScore(row.fit_score),
      cover_note: row.cover_note,
      created_at: row.created_at.toISOString(),
    };
  }

  private toConfirmation(
    accountId: string,
    applicantId: string,
    application: Application,
    fit: FitSignalDto,
  ): ApplyConfirmationDto {
    return {
      application_id: application.id,
      applicant_id: applicantId,
      account_id: accountId,
      status: application.status,
      fit,
      confirmation: {
        headline: "You're in.",
        message:
          'Your application is submitted. Hiring coaches can now see your profile.',
        next_step:
          'Finish your profile to stand out — add your specialties and a sample program.',
      },
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MY_APPLICATIONS_DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MY_APPLICATIONS_MAX_LIMIT);
}

// Map a stored 0–100 fit_score back to the one-chip signal. Mirrors the
// thresholds in computeFitSignal so a replayed/listed card reads identically to
// the live submit. A null score (legacy/unscored row) reads as exploratory.
function fitFromScore(score: number | null): FitSignalDto {
  const s = typeof score === 'number' ? Math.min(100, Math.max(0, score)) : 0;
  if (s >= 67) return { level: 'strong', label: 'Strong match', score: s };
  if (s >= 34) return { level: 'moderate', label: 'Good potential', score: s };
  return { level: 'exploratory', label: 'Worth exploring', score: s };
}

// Widen the confirmation DTO to the Prisma JSON input type for ledger storage.
// The DTO is a closed set of strings/numbers/nested string objects, so it is a
// structurally valid JSON value; this spells that out without a double-cast.
function toLedgerJson(dto: ApplyConfirmationDto): Prisma.InputJsonValue {
  return {
    application_id: dto.application_id,
    applicant_id: dto.applicant_id,
    account_id: dto.account_id,
    status: dto.status,
    fit: { level: dto.fit.level, label: dto.fit.label, score: dto.fit.score },
    confirmation: {
      headline: dto.confirmation.headline,
      message: dto.confirmation.message,
      next_step: dto.confirmation.next_step,
    },
  };
}

// Rebuild a confirmation DTO from a stored ledger JSON value, validating each
// field. Returns null for any shape mismatch so the caller can fail loudly
// rather than returning an off-shape object via a cast.
function parseLedgerConfirmation(
  value: Prisma.JsonValue,
): ApplyConfirmationDto | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const fit = parseLedgerFit(row.fit);
  const confirmation = parseLedgerCopy(row.confirmation);
  if (
    typeof row.application_id !== 'string' ||
    typeof row.applicant_id !== 'string' ||
    typeof row.account_id !== 'string' ||
    typeof row.status !== 'string' ||
    !fit ||
    !confirmation
  ) {
    return null;
  }
  return {
    application_id: row.application_id,
    applicant_id: row.applicant_id,
    account_id: row.account_id,
    status: row.status,
    fit,
    confirmation,
  };
}

function parseLedgerFit(value: unknown): FitSignalDto | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    (row.level !== 'strong' &&
      row.level !== 'moderate' &&
      row.level !== 'exploratory') ||
    typeof row.label !== 'string' ||
    typeof row.score !== 'number'
  ) {
    return null;
  }
  return { level: row.level, label: row.label, score: row.score };
}

function parseLedgerCopy(
  value: unknown,
): ApplyConfirmationDto['confirmation'] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.headline !== 'string' ||
    typeof row.message !== 'string' ||
    typeof row.next_step !== 'string'
  ) {
    return null;
  }
  return {
    headline: row.headline,
    message: row.message,
    next_step: row.next_step,
  };
}
