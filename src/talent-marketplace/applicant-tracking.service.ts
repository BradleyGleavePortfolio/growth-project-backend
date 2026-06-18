// TM-8 — Hirer applicant tracking (8a).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII BOUNDARY + HIRER SCOPE. Every read is scoped to the caller's own       ║
// ║ listings via Application.hirer_id = caller (defense-in-depth ON TOP of the  ║
// ║ TM-1 RLS hirer-read predicate). Responses are the CandidateCard projection ║
// ║ or the redacted detail DTO — a raw Applicant / Application row is NEVER     ║
// ║ returned. Errors use opaque codes (APPLICANT_NOT_FOUND) and NEVER echo     ║
// ║ applicant email / phone / name. Logs never carry raw PII.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import {
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import { buildTupleCursor, parseTupleCursor } from './application-cursor';
import {
  canTransition,
  isTerminalStage,
  stageToStatus,
  statusToStage,
  type PipelineStage,
} from './pipeline-stage';
import { toCandidateCard } from './candidate-card.dto';
import type {
  ApplicantDetailDto,
  ApplicantQueueQueryDto,
  ApplicantQueueResponse,
} from './applicant-tracking.dto';

const STAGE_ROUTE_KEY = 'tm:applicants:stage';
const QUEUE_DEFAULT_LIMIT = 20;
const QUEUE_MAX_LIMIT = 50;

@Injectable()
export class ApplicantTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // GET /listings/:id/applicants — keyset page of CandidateCards for a listing
  // the caller owns. The hirer-scope (hirer_id = caller) is the authorization
  // boundary: a non-owning hirer simply matches zero rows.
  async listApplicants(
    hirerId: string,
    listingId: string,
    query: ApplicantQueueQueryDto,
  ): Promise<ApplicantQueueResponse> {
    const limit = Math.min(query.limit ?? QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT);
    const cursor = query.cursor ? parseTupleCursor(query.cursor) : null;

    const keyset: Prisma.ApplicationWhereInput | undefined = cursor
      ? {
          OR: [
            { created_at: { lt: cursor.created_at } },
            { created_at: cursor.created_at, id: { lt: cursor.id } },
          ],
        }
      : undefined;

    const rows = await this.prisma.application.findMany({
      where: { listing_id: listingId, hirer_id: hirerId, ...keyset },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        applicant_id: true,
        fit_score: true,
        status: true,
        created_at: true,
      },
    });

    const page = rows.slice(0, limit);
    const applicants = await this.loadApplicantCardFields(
      page.map((r) => r.applicant_id),
    );

    const items = page.map((row) => {
      const a = applicants.get(row.applicant_id);
      return toCandidateCard(row, {
        first_name: a?.first_name ?? '',
        last_name: a?.last_name ?? '',
        specialties: a?.specialties ?? [],
      });
    });

    const next =
      rows.length > limit ? buildTupleCursor(page[page.length - 1]) : null;
    return { items, next_cursor: next };
  }

  // GET /applicants/:applicantId — redacted full detail for an application the
  // caller owns. Identity is minimised even here: email → domain only. The
  // applicantId path param is an Application id (the hirer-facing handle).
  async getApplicantDetail(
    hirerId: string,
    applicationId: string,
  ): Promise<ApplicantDetailDto> {
    const app = await this.prisma.application.findFirst({
      where: { id: applicationId, hirer_id: hirerId },
      select: {
        id: true,
        applicant_id: true,
        fit_score: true,
        status: true,
        created_at: true,
      },
    });
    if (!app) throw this.notFound();

    const applicant = await this.prisma.applicant.findUnique({
      where: { id: app.applicant_id },
      select: {
        email: true,
        first_name: true,
        last_name: true,
        headline: true,
        specialties: true,
        years_experience: true,
      },
    });
    if (!applicant) throw this.notFound();

    const card = toCandidateCard(app, applicant);
    return {
      ...card,
      headline: applicant.headline ?? null,
      years_experience: applicant.years_experience ?? null,
      email_domain: emailDomain(applicant.email),
      phone_last4: null,
    };
  }

  // PATCH /applicants/:applicantId/stage — advance the pipeline. Persisted via
  // Application.status (the only writable lifecycle column — no new storage).
  // Idempotent through the TM-4 ledger so a double-tap replays the first result.
  async moveStage(
    hirerId: string,
    applicationId: string,
    target: PipelineStage,
    idempotencyKey?: string,
  ): Promise<{ application_id: string; stage: PipelineStage }> {
    const app = await this.prisma.application.findFirst({
      where: { id: applicationId, hirer_id: hirerId },
      select: { id: true, status: true },
    });
    if (!app) throw this.notFound();

    const current = statusToStage(app.status);
    if (isTerminalStage(current)) {
      throw new ConflictException({
        error: 'Conflict',
        message: 'This applicant is in a terminal stage and cannot be moved.',
        code: 'PIPELINE_STAGE_TERMINAL',
      });
    }
    if (current !== target && !canTransition(current, target)) {
      throw new ConflictException({
        error: 'Conflict',
        message: 'That pipeline transition is not allowed.',
        code: 'PIPELINE_TRANSITION_INVALID',
      });
    }

    const claimKey = {
      userId: hirerId,
      routeKey: STAGE_ROUTE_KEY,
      idempotencyKey: idempotencyKey?.trim() || `stage:${applicationId}:${target}`,
    };
    const claim = await this.idempotency.claimOrReplay(claimKey);
    if (claim.outcome === 'replay') {
      return { application_id: applicationId, stage: target };
    }
    if (claim.outcome === 'in_flight') {
      throw new ConflictException({
        error: 'Conflict',
        message: 'A stage change for this applicant is already in progress.',
        code: 'STAGE_CHANGE_IN_FLIGHT',
      });
    }

    try {
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: stageToStatus(target) },
      });
      const result = { application_id: applicationId, stage: target };
      const done = await this.idempotency.markCompleted(claimKey, claim.claimNonce, result);
      if (done.outcome === 'conflict') {
        return result;
      }
      return result;
    } catch (err) {
      await this.idempotency.releaseClaim(claimKey, claim.claimNonce);
      throw err;
    }
  }

  // POST /applicants/:applicantId/notes — hirer-private note. 8b: requires a
  // dedicated HirerApplicantNote table (write hirer-only / read hirer-only RLS).
  // TM-8 ships no schema change, so this is deferred to TM-8b rather than faked
  // against an existing column. Tracked: follow-up issue TM-8b.
  appendNote(): never {
    throw this.notImplemented('NOTES_NOT_AVAILABLE');
  }

  // POST /applicants/:applicantId/shortlist — toggle shortlist. 8b: needs a
  // per-(hirer, application) shortlist flag with its own RLS. Deferred to TM-8b
  // (no schema change in TM-8). Tracked: follow-up issue TM-8b.
  toggleShortlist(): never {
    throw this.notImplemented('SHORTLIST_NOT_AVAILABLE');
  }

  // Batch-load the narrow CandidateCard column subset for a page of applicants.
  private async loadApplicantCardFields(applicantIds: string[]) {
    if (applicantIds.length === 0) {
      return new Map<string, { first_name: string; last_name: string; specialties: string[] }>();
    }
    const rows = await this.prisma.applicant.findMany({
      where: { id: { in: applicantIds } },
      select: { id: true, first_name: true, last_name: true, specialties: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  // Opaque not-found — never echoes the applicant id or any PII. A non-owning
  // hirer and a non-existent application are indistinguishable to the caller.
  private notFound(): NotFoundException {
    return new NotFoundException({
      error: 'Not Found',
      message: 'Applicant not found.',
      code: 'APPLICANT_NOT_FOUND',
    });
  }

  private notImplemented(code: string): NotImplementedException {
    return new NotImplementedException({
      error: 'Not Implemented',
      message: 'This capability ships in TM-8b.',
      code,
    });
  }
}

// Reduce an email to its domain for the redacted detail view. Returns null when
// no domain is parseable so the field degrades rather than leaking the local
// part.
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}
