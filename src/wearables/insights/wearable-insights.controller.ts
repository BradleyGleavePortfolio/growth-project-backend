import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Prisma, WearableMetricBucket } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { PrismaService } from '../../prisma.service';
import { assertRomanHasCoach } from '../../roman/roman-requires-coach';
import { AiApprovalService } from '../../ai/gateway/ai-approval.service';
import { COACH_WEARABLE_MESSAGE_CAPABILITY } from '../../ai/gateway/materialisers/coach-wearable-message.materialiser';
import { ROMAN_MESSAGE_SOURCE } from '../../ai/gateway/roman-message-draft';
import { WearableInsightsService } from './wearable-insights.service';
import {
  CoachInsightResponse,
  ClientInsightResponse,
  CoachInsightResponseSchema,
  ClientInsightResponseSchema,
} from './insight-output.schema';

// PR-HK-4 — read-only insight endpoints (no UI; the panels land in 5a/5b).
//
//   GET /v1/wearables/insights/coach?clientId=&bucket=   (coach-auth)
//   GET /v1/wearables/insights/client?bucket=            (user-auth)
//
// Strict dual-role projection (audit criteria #5):
//   - The coach endpoint NEVER returns the client-side schema, and the
//     coach-only fields (hypothesis, suggested_message_draft) are produced
//     only by the coach path.
//   - The client endpoint NEVER returns the coach-side schema.
// The service already returns the correct typed payload per audience; the
// controller adds the authorization boundary (coach-owns-client) and the
// Zod-validated query params, and is split into two handlers so the two
// response shapes can never cross.

// Both buckets, validated from the query string. The mobile clients send
// the enum value verbatim.
const BucketSchema = z.enum(WearableMetricBucket);

const CoachQuerySchema = z.object({
  clientId: z.guid({ message: 'clientId must be a UUID' }),
  bucket: BucketSchema,
});

const ClientQuerySchema = z.object({
  bucket: BucketSchema,
});

// Request body for POST /v1/wearables/insights/approve. This is the exact
// shape the mobile coach panel (HK-5a) already sends — see
// `wearableInsightsApi.ts:approveDraft`. `.strict()` rejects unknown keys so
// a future drift can never smuggle extra fields into the draft payload.
const ApproveBodySchema = z
  .object({
    client_id: z.guid({ message: 'client_id must be a UUID' }),
    bucket: BucketSchema,
    draft_body: z
      .string()
      .min(1, { message: 'draft_body must not be empty' })
      .max(1000, { message: 'draft_body exceeds 1000 chars' })
      .refine((s) => s.trim().length > 0, {
        message: 'draft_body must not be whitespace-only',
      }),
    action: z.enum(['approve', 'edit', 'reject']),
  })
  .strict()
  .or(z.object({
    client_id: z.guid({ message: 'client_id must be a UUID' }),
    bucket: BucketSchema,
    draft_body: z.literal(''),
    action: z.literal('dismiss'),
  }).strict());

// Wire response for the approve endpoint. Discriminated by `status` on the
// mobile side; the backend only ever emits the `ok` branch (the
// `not_implemented` branch is the pre-HK-6 404 fallback, now dead).
const ApproveResponseShape = z.object({
  status: z.literal('ok'),
  draft_id: z.guid(),
  // Legacy reject returns null. The shipped dismiss caller requires a string
  // in this slot: its decision time, NOT a message materialisation time.
  // Stored materialised_at stays null for both non-sending actions.
  materialised_at: z.string().nullable(),
});
type ApproveResponseShape = z.infer<typeof ApproveResponseShape>;

@ApiTags('wearables-insights')
@Controller('v1/wearables/insights')
export class WearableInsightsController {
  constructor(
    private readonly svc: WearableInsightsService,
    // AiApprovalService is exported from the @Global AiGatewayModule; it owns
    // the row-lock, status flip, audit log, and materialiser dispatch. We do
    // NOT re-implement any of that here — the endpoint creates the draft then
    // delegates the decision to decide().
    private readonly approvals: AiApprovalService,
    // PrismaService is global; used only to create the human-validated draft
    // row and read it back for the materialised_at timestamp.
    private readonly prisma: PrismaService,
  ) {}

  // Coach-side insight for a specific client + bucket. Gated by
  // JwtAuthGuard + CoachGuard (coach/owner only). The service additionally
  // re-checks coach-owns-client so a coach cannot read another coach's
  // client (IDOR defence). Throttled to keep LLM cost bounded.
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 30 } })
  @Get('coach')
  async getCoachInsight(
    @Request() req: AuthedRequest,
    @Query() rawQuery: unknown,
  ): Promise<CoachInsightResponse> {
    const { clientId, bucket } = parseOrThrow(CoachQuerySchema, rawQuery);
    await this.svc.assertCoachOwnsClient(req.user.id, clientId, req.user.role);
    const payload = await this.svc.generateForCoach(req.user.id, clientId, bucket, req.user.role);
    // Validate the wire response against the locked union contract (full
    // coach insight OR the strict empty state). Both branches are exact-
    // field; an empty fallback can never leak a contract-violating shape.
    return CoachInsightResponseSchema.parse(payload);
  }

  // Coach approval of an AI-suggested wearable message. Mobile (HK-5a) is
  // already wired to this exact contract:
  //   POST /v1/wearables/insights/approve
  //   body { client_id, bucket, draft_body, action }
  //   -> { status: 'ok', draft_id, materialised_at }
  //
  // The body is HUMAN-validated input that already carries its text (the
  // coach saw — and possibly edited — the suggested_message_draft), so we
  // skip the LLM gateway-invoke path and create the AiActionDraft directly.
  // The action is then dispatched through AiApprovalService.decide():
  //   - approve / edit -> decision 'approved' -> the wearable-message
  //     materialiser sends via MessagingService.sendAsCoach.
  //   - reject         -> decision 'rejected' -> no message; the draft is
  //     flipped to rejected and audited. materialised_at on the wire is null
  //     (nothing was materialised); the decision still succeeded.
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 60 } })
  @Post('approve')
  async approveInsight(
    @Request() req: AuthedRequest,
    @Body() rawBody: unknown,
  ): Promise<ApproveResponseShape> {
    const body = parseOrThrow(ApproveBodySchema, rawBody);

    // IDOR boundary (#5): a coach can only approve a message to a client they
    // own. This runs BEFORE any draft row is created so an unauthorised
    // request never persists state.
    await this.svc.assertCoachOwnsClient(
      req.user.id,
      body.client_id,
      // Dismiss is only for this client's current coach, not an admin bypass.
      body.action === 'dismiss' ? 'coach' : req.user.role,
    );

    // Create the human-validated draft. tenant_coach_id is pinned to the
    // requester so the materialiser sends from the correct coach namespace
    // and decide()'s tenant boundary matches. requester_id is intentionally
    // left null: this draft has no separate AI requester, and decide()
    // forbids a decider from deciding their OWN draft
    // (requester_id === decider.id) — the human-in-the-loop guard that
    // protects LLM-generated drafts. Here the human IS the author, so a null
    // requester keeps that guard inert without weakening any other check
    // (the tenant boundary + coach-owns-client above are the real authz).
    // ROMANMARK-BE: `approve` sends Roman's stored suggestion for this coach,
    // client and bucket as stored, marked as Roman's text (the Roman mark).
    // Its body must equal that suggestion after the same trim the app makes
    // before it sends `approve`; a real difference, or no stored suggestion,
    // is refused (400 WEARABLE_SUGGESTION_MISMATCH) before anything is written
    // or sent. `edit` sends the coach's text, marked when a suggestion is
    // stored (S-08, romanmark-insight op 1).
    const suggestion = body.action === 'dismiss'
      ? null
      : await this.svc.romanSuggestion(req.user.id, body.client_id, body.bucket);
    const text = body.action === 'approve' ? suggestion : body.draft_body;
    if (text === null || text.trim() !== body.draft_body.trim()) {
      throw new BadRequestException({ error: 'WEARABLE_SUGGESTION_MISMATCH' });
    }
    const roman = suggestion !== null && body.action !== 'reject';
    const draft = await this.prisma.aiActionDraft.create({
      data: {
        capability: COACH_WEARABLE_MESSAGE_CAPABILITY,
        status: 'pending',
        requester_id: null,
        subject_user_id: body.client_id,
        tenant_coach_id: req.user.id,
        payload: {
          clientId: body.client_id,
          bucket: body.bucket,
          body: text,
        } as Prisma.InputJsonValue,
        rationale: `Approved from wearable insight (bucket=${body.bucket}, action=${body.action})`,
        redacted_inputs: {} as Prisma.InputJsonValue,
        provenance: [
          {
            source: 'wearable_insight_approve',
            bucket: body.bucket,
            action: body.action,
          },
          ...(roman ? [{ source: ROMAN_MESSAGE_SOURCE, count: 1 }] : []),
        ] satisfies Prisma.InputJsonValue,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Dispatch on action. reject/dismiss -> rejected (no send); approve/edit ->
    // approved (materialiser sends). decide() owns the lock, audit, and
    // materialiser dispatch; we let its NotFound/Conflict/Forbidden
    // exceptions propagate untouched (no catch-and-rewrap).
    const decision = body.action === 'approve' || body.action === 'edit' ? 'approved' : 'rejected';
    const fresh = await this.approvals.decide({
      draftId: draft.id,
      decider: { id: req.user.id, role: req.user.role },
      decision,
      note:
        body.action === 'edit'
          ? 'Coach edited body before approve'
          : undefined,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    // Wire-only compatibility for builds 9/10: dismiss parses a string here.
    // Do not write a materialisation timestamp or send a message for dismissal.
    const materialisedAt = (body.action === 'dismiss'
      ? fresh.decided_at
      : fresh.materialised_at)?.toISOString() ?? null;

    // Validate the wire response against the locked contract before returning
    // (defence in depth, same pattern as getCoachInsight).
    return ApproveResponseShape.parse({
      status: 'ok',
      draft_id: draft.id,
      materialised_at: materialisedAt,
    });
  }

  // Client-side self-coaching insight for the authenticated user + bucket.
  // Gated by JwtAuthGuard only (any authenticated user reads their OWN
  // insight — subjectUserId is always req.user.id, so there is no IDOR
  // surface). Throttled per user.
  @Roles('student')
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 3_600_000, limit: 60 } })
  @Get('client')
  async getClientInsight(
    @Request() req: AuthedRequest,
    @Query() rawQuery: unknown,
  ): Promise<ClientInsightResponse> {
    const { bucket } = parseOrThrow(ClientQuerySchema, rawQuery);
    // GAPS3-F1 option 1: the insight is Roman's, so a client with no coach
    // gets 403 ROMAN_REQUIRES_COACH before any cache read or AI call, even
    // with a stored AI grant (W-CONSENT keeps it for the day a coach is linked).
    assertRomanHasCoach(req.user);
    const payload = await this.svc.generateForClient(req.user.id, bucket);
    // Same locked-union validation as the coach path.
    return ClientInsightResponseSchema.parse(payload);
  }
}

// Zod-parse a query object, converting a ZodError into a 400 with the
// field-level issues (mirrors the gateway's AI_DRAFT_PAYLOAD_INVALID shape).
function parseOrThrow<T>(schema: z.ZodSchema<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'WEARABLE_INSIGHT_QUERY_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}

// Audit-context extractors, mirroring ai-gateway.controller. We read the
// first x-forwarded-for hop (proxy chain) and fall back to the socket IP, and
// normalise a possibly-array user-agent header. Returning null (not throwing)
// keeps the audit best-effort — a missing header must never block an approve.
function extractIp(req: AuthedRequest): string | null {
  const xff = (req.headers?.['x-forwarded-for'] as string) ?? '';
  if (xff) return xff.split(',')[0].trim();
  return req.ip ?? null;
}

function extractUserAgent(req: AuthedRequest): string | null {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  return Array.isArray(ua) ? ua[0] ?? null : ua;
}
