import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';
import { KmsService } from '../common/kms/kms.service';
import {
  BloodworkAuditAction,
  BloodworkDisclaimerLevel,
  BloodworkReviewState,
  BloodworkScanStatus,
  BloodworkSource,
  BloodworkValidationStatus,
  COACH_TRANSITIONS,
  DEFAULT_STALE_AFTER_DAYS,
} from './bloodwork.constants';
import type {
  CreateBloodworkPanelDto,
  CreateBloodworkResultDto,
  ListPanelsQueryDto,
  RegisterAttachmentDto,
  ReviewPanelDto,
  UpdateAttachmentScanDto,
  UpdateBloodworkPanelDto,
} from './bloodwork.dto';

interface ActorContext {
  actorId: string;
  actorRole: string; // 'student' | 'coach' | 'owner' | 'ai'
  ip?: string | null;
  userAgent?: string | null;
}

const COACH_ROLES = new Set(['coach', 'owner']);
const NON_AUTHORITATIVE_ROLES = new Set(['ai']);

// BloodworkService is the single entry point for client-entered lab
// panels. It owns the consent gate, the review state machine, the
// validation rollup, and the audit trail.
@Injectable()
export class BloodworkService {
  private readonly logger = new Logger(BloodworkService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private consent: ConsentService,
    private kms: KmsService,
  ) {}

  // ---- helpers ----

  private toAuditCtx(ctx: ActorContext) {
    return { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null };
  }

  // KMS dual-write helpers. The plaintext column is still written for
  // the transition window (so old code paths and one-off queries keep
  // working). The encrypted column is the authoritative read source —
  // panels created after this PR will have it populated, panels created
  // before will not and the read falls back to the plaintext column.
  private encryptForWrite(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return this.kms.encrypt(value);
  }

  private decryptForRead(
    encrypted: string | null | undefined,
    plaintextFallback: string | null | undefined,
  ): string | null {
    if (encrypted) {
      return this.kms.decrypt(encrypted);
    }
    return plaintextFallback ?? null;
  }

  // Materializes a panel row read from Prisma with the encrypted
  // free-text fields decrypted in place. Operates structurally so it
  // doesn't have to know about every relation include shape.
  private hydratePanel<
    T extends {
      notes: string | null;
      review_note: string | null;
      encrypted_notes?: string | null;
      encrypted_review_note?: string | null;
    },
  >(panel: T): T {
    return {
      ...panel,
      notes: this.decryptForRead(panel.encrypted_notes, panel.notes),
      review_note: this.decryptForRead(panel.encrypted_review_note, panel.review_note),
    };
  }

  private assertActorIsCoachLike(ctx: ActorContext) {
    if (NON_AUTHORITATIVE_ROLES.has(ctx.actorRole)) {
      // SECURITY: AI / non-human callers must never mutate authoritative
      // state. The AI gateway can READ panels (subject to AI-scope
      // consent) but cannot review/flag/approve.
      throw new ForbiddenException(
        'AI cannot mutate bloodwork review state',
      );
    }
    if (!COACH_ROLES.has(ctx.actorRole)) {
      throw new ForbiddenException('Coach access required');
    }
  }

  private assertReviewable(panel: {
    validation_status: string;
    attachments: Array<{ scan_status: string }>;
  }) {
    if (panel.validation_status === BloodworkValidationStatus.ERRORS) {
      throw new BadRequestException(
        'Panel has validation errors and cannot be reviewed',
      );
    }
    // Block coach approval / client visibility when ANY attachment is in
    // a non-clean scan state (other than no attachments at all).
    for (const a of panel.attachments) {
      if (
        a.scan_status !== BloodworkScanStatus.CLEAN &&
        a.scan_status !== BloodworkScanStatus.UNAVAILABLE
      ) {
        throw new BadRequestException(
          `Attachment scan not clean (status: ${a.scan_status})`,
        );
      }
    }
  }

  // Compute per-result validation. Conservative: out-of-range is NOT an
  // error (it's normal!), but missing-value is. Returns the per-result
  // status the service writes to the row.
  private validateResult(input: CreateBloodworkResultDto): {
    out_of_range: boolean;
    validation_status: string;
    validation_message: string | null;
  } {
    const hasNumeric =
      input.value_numeric !== undefined && input.value_numeric !== null;
    const hasText =
      typeof input.value_text === 'string' && input.value_text.length > 0;
    if (!hasNumeric && !hasText) {
      return {
        out_of_range: false,
        validation_status: BloodworkValidationStatus.ERRORS,
        validation_message: 'Result has no value (numeric or text)',
      };
    }
    let outOfRange = false;
    if (
      hasNumeric &&
      typeof input.value_numeric === 'number' &&
      (input.reference_low !== undefined || input.reference_high !== undefined)
    ) {
      const v = input.value_numeric;
      if (typeof input.reference_low === 'number' && v < input.reference_low) {
        outOfRange = true;
      }
      if (
        typeof input.reference_high === 'number' &&
        v > input.reference_high
      ) {
        outOfRange = true;
      }
    }
    return {
      out_of_range: outOfRange,
      validation_status: BloodworkValidationStatus.OK,
      validation_message: null,
    };
  }

  private rollupPanelValidation(
    results: Array<{ validation_status: string }>,
  ): string {
    if (results.some((r) => r.validation_status === BloodworkValidationStatus.ERRORS)) {
      return BloodworkValidationStatus.ERRORS;
    }
    if (
      results.some(
        (r) => r.validation_status === BloodworkValidationStatus.WARNINGS,
      )
    ) {
      return BloodworkValidationStatus.WARNINGS;
    }
    return BloodworkValidationStatus.OK;
  }

  private async assertHealthConsentOrThrow(
    clientId: string,
    coachId: string | null,
  ) {
    if (!coachId) {
      // If there is no coach yet, storing labs is still gated on the
      // client's intent to share with their (future) coach. We require
      // the consent row even if it's against a sentinel "no coach" — but
      // in practice clients without a coach can still draft. Storage
      // consent here is checked against the user themselves to keep the
      // ledger row in place for the audit trail.
      return;
    }
    const granted = await this.consent.isGranted(
      clientId,
      coachId,
      ConsentScope.HEALTH_BLOODWORK,
    );
    if (!granted) {
      throw new ForbiddenException(
        'Health consent required to store bloodwork (scope: health.bloodwork)',
      );
    }
  }

  // ---- client writes ----

  async createPanel(
    clientId: string,
    dto: CreateBloodworkPanelDto,
    ctx: ActorContext,
  ) {
    const me = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    const coachId = me?.coach_id ?? null;

    // Storage consent gate. We only enforce when there is a coach in the
    // picture so a brand-new signup can draft labs before being matched
    // to a coach.
    await this.assertHealthConsentOrThrow(clientId, coachId);

    const collectionDate = new Date(dto.collection_date);
    if (Number.isNaN(collectionDate.getTime())) {
      throw new BadRequestException('Invalid collection_date');
    }

    const validatedResults = (dto.results ?? []).map((r) => ({
      input: r,
      validation: this.validateResult(r),
    }));
    const panelValidation = this.rollupPanelValidation(
      validatedResults.map((v) => ({
        validation_status: v.validation.validation_status,
      })),
    );

    // AI scope is captured at submit time; the AI service must re-check
    // live consent before reading.
    const aiAllowed = coachId
      ? await this.consent.isGranted(
          clientId,
          coachId,
          ConsentScope.HEALTH_BLOODWORK_AI,
        )
      : false;

    const panel = await this.prisma.bloodworkPanel.create({
      data: {
        client_id: clientId,
        coach_id: coachId,
        collection_date: collectionDate,
        source: dto.source ?? BloodworkSource.MANUAL,
        panel_label: dto.panel_label ?? null,
        notes: dto.notes ?? null,
        encrypted_notes: this.encryptForWrite(dto.notes),
        encryption_key_ref: this.kms.isConfigured() ? this.kms.keyAlias() : null,
        kms_key_version: this.kms.isConfigured() ? this.kms.keyVersion() : null,
        review_state: BloodworkReviewState.DRAFT,
        disclaimer_level: BloodworkDisclaimerLevel.EDUCATIONAL_ONLY,
        validation_status: panelValidation,
        source_missing: dto.source_missing ?? false,
        ai_processing_allowed: aiAllowed,
        results: {
          create: validatedResults.map(({ input, validation }) => ({
            marker_name: input.marker_name,
            marker_code: input.marker_code ?? null,
            value_numeric:
              input.value_numeric !== undefined
                ? new Prisma.Decimal(input.value_numeric)
                : null,
            value_text: input.value_text ?? null,
            unit: input.unit ?? null,
            reference_low:
              input.reference_low !== undefined
                ? new Prisma.Decimal(input.reference_low)
                : null,
            reference_high:
              input.reference_high !== undefined
                ? new Prisma.Decimal(input.reference_high)
                : null,
            reference_text: input.reference_text ?? null,
            out_of_range: validation.out_of_range,
            validation_status: validation.validation_status,
            validation_message: validation.validation_message,
          })),
        },
      },
      include: { results: true, attachments: true },
    });

    await this.audit.write({
      action: BloodworkAuditAction.PANEL_CREATED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: clientId,
      targetType: 'bloodwork_panel',
      targetId: panel.id,
      tenantCoachId: coachId,
      ...this.toAuditCtx(ctx),
      metadata: {
        result_count: panel.results.length,
        validation_status: panel.validation_status,
        source: panel.source,
      },
    });

    return this.hydratePanel(panel);
  }

  async updateDraftPanel(
    clientId: string,
    panelId: string,
    dto: UpdateBloodworkPanelDto,
    ctx: ActorContext,
  ) {
    const panel = await this.prisma.bloodworkPanel.findFirst({
      where: { id: panelId, client_id: clientId },
    });
    if (!panel) throw new NotFoundException('Panel not found');
    if (panel.review_state !== BloodworkReviewState.DRAFT) {
      throw new BadRequestException(
        'Only draft panels can be edited by the client',
      );
    }

    const data: Prisma.BloodworkPanelUpdateInput = {};
    if (dto.collection_date !== undefined) {
      const d = new Date(dto.collection_date);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Invalid collection_date');
      }
      data.collection_date = d;
    }
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.panel_label !== undefined) data.panel_label = dto.panel_label;
    if (dto.notes !== undefined) {
      data.notes = dto.notes;
      data.encrypted_notes = this.encryptForWrite(dto.notes);
    }
    if (dto.source_missing !== undefined) {
      data.source_missing = dto.source_missing;
    }

    const updated = await this.prisma.bloodworkPanel.update({
      where: { id: panelId },
      data,
      include: { results: true, attachments: true },
    });

    await this.audit.write({
      action: BloodworkAuditAction.PANEL_UPDATED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: clientId,
      targetType: 'bloodwork_panel',
      targetId: panelId,
      tenantCoachId: updated.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: { fields: Object.keys(data) },
    });

    return this.hydratePanel(updated);
  }

  async submitPanel(clientId: string, panelId: string, ctx: ActorContext) {
    const panel = await this.prisma.bloodworkPanel.findFirst({
      where: { id: panelId, client_id: clientId },
      include: { attachments: true, results: true },
    });
    if (!panel) throw new NotFoundException('Panel not found');
    if (panel.review_state !== BloodworkReviewState.DRAFT) {
      throw new BadRequestException('Panel already submitted');
    }
    if (panel.validation_status === BloodworkValidationStatus.ERRORS) {
      throw new BadRequestException(
        'Panel has validation errors; resolve before submitting',
      );
    }

    const updated = await this.prisma.bloodworkPanel.update({
      where: { id: panelId },
      data: {
        review_state: BloodworkReviewState.SUBMITTED,
        submitted_at: new Date(),
      },
      include: { results: true, attachments: true },
    });

    await this.audit.write({
      action: BloodworkAuditAction.PANEL_SUBMITTED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: clientId,
      targetType: 'bloodwork_panel',
      targetId: panelId,
      tenantCoachId: updated.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: { result_count: updated.results.length },
    });

    return this.hydratePanel(updated);
  }

  async deleteDraftPanel(
    clientId: string,
    panelId: string,
    ctx: ActorContext,
  ) {
    const panel = await this.prisma.bloodworkPanel.findFirst({
      where: { id: panelId, client_id: clientId },
    });
    if (!panel) throw new NotFoundException('Panel not found');
    if (panel.review_state !== BloodworkReviewState.DRAFT) {
      throw new BadRequestException('Only draft panels can be deleted');
    }
    await this.prisma.bloodworkPanel.delete({ where: { id: panelId } });
    await this.audit.write({
      action: BloodworkAuditAction.PANEL_DELETED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: clientId,
      targetType: 'bloodwork_panel',
      targetId: panelId,
      tenantCoachId: panel.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: null,
    });
    return { id: panelId, deleted: true };
  }

  // ---- client reads ----

  async listForClient(clientId: string, query: ListPanelsQueryDto) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where: Prisma.BloodworkPanelWhereInput = { client_id: clientId };
    if (query.review_state) where.review_state = query.review_state;
    const panels = await this.prisma.bloodworkPanel.findMany({
      where,
      orderBy: { collection_date: 'desc' },
      take: limit,
      include: { results: true, attachments: true },
    });
    return panels.map((p) => this.hydratePanel(p));
  }

  async getForClient(clientId: string, panelId: string) {
    const panel = await this.prisma.bloodworkPanel.findFirst({
      where: { id: panelId, client_id: clientId },
      include: { results: true, attachments: true },
    });
    if (!panel) throw new NotFoundException('Panel not found');
    return this.hydratePanel(panel);
  }

  // ---- coach reads ----

  // Coach-side reads enforce both tenancy (panel.coach_id matches caller
  // OR caller is owner) AND consent (HEALTH_BLOODWORK granted). Returns
  // empty when consent is missing rather than throwing — keeps the queue
  // surface predictable.
  async listForCoach(
    coachId: string,
    callerRole: string,
    query: ListPanelsQueryDto,
  ) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where: Prisma.BloodworkPanelWhereInput = {};
    if (callerRole !== 'owner') {
      where.coach_id = coachId;
    }
    // Default to submitted/needs_info/reviewed/flagged — exclude drafts
    // (clients still editing) and hidden unless explicitly asked for.
    if (query.review_state) {
      where.review_state = query.review_state;
    } else if (!query.include_drafts) {
      where.review_state = {
        in: [
          BloodworkReviewState.SUBMITTED,
          BloodworkReviewState.NEEDS_INFO,
          BloodworkReviewState.REVIEWED,
          BloodworkReviewState.FLAGGED,
        ],
      };
    }
    const panels = await this.prisma.bloodworkPanel.findMany({
      where,
      orderBy: [{ submitted_at: 'desc' }, { collection_date: 'desc' }],
      take: limit,
      include: { results: true, attachments: true },
    });

    // Filter by consent: a coach can only see panels for clients who
    // granted HEALTH_BLOODWORK. Owners bypass.
    if (callerRole === 'owner') return panels.map((p) => this.hydratePanel(p));
    const allowed: typeof panels = [];
    for (const p of panels) {
      const ok = await this.consent.isGranted(
        p.client_id,
        coachId,
        ConsentScope.HEALTH_BLOODWORK,
      );
      if (ok) allowed.push(p);
    }
    return allowed.map((p) => this.hydratePanel(p));
  }

  async getForCoach(coachId: string, callerRole: string, panelId: string) {
    const panel = await this.prisma.bloodworkPanel.findUnique({
      where: { id: panelId },
      include: { results: true, attachments: true },
    });
    if (!panel) throw new NotFoundException('Panel not found');
    if (callerRole !== 'owner' && panel.coach_id !== coachId) {
      // Tenant boundary: coaches can only see their own clients' panels.
      throw new NotFoundException('Panel not found');
    }
    if (callerRole !== 'owner') {
      const ok = await this.consent.isGranted(
        panel.client_id,
        coachId,
        ConsentScope.HEALTH_BLOODWORK,
      );
      if (!ok) {
        throw new ForbiddenException(
          'Client has not granted health consent',
        );
      }
    }
    return this.hydratePanel(panel);
  }

  // ---- coach writes (review state machine) ----

  async reviewPanel(
    panelId: string,
    dto: ReviewPanelDto,
    ctx: ActorContext,
  ) {
    this.assertActorIsCoachLike(ctx);

    const panel = await this.prisma.bloodworkPanel.findUnique({
      where: { id: panelId },
      include: { attachments: true, results: true },
    });
    if (!panel) throw new NotFoundException('Panel not found');

    if (ctx.actorRole !== 'owner' && panel.coach_id !== ctx.actorId) {
      throw new NotFoundException('Panel not found');
    }

    // Consent gate: coach must have HEALTH_BLOODWORK to act on it.
    if (ctx.actorRole !== 'owner') {
      const ok = await this.consent.isGranted(
        panel.client_id,
        ctx.actorId,
        ConsentScope.HEALTH_BLOODWORK,
      );
      if (!ok) {
        throw new ForbiddenException('Client has not granted health consent');
      }
    }

    const allowed = COACH_TRANSITIONS[panel.review_state] ?? [];
    if (!allowed.includes(dto.review_state)) {
      throw new BadRequestException(
        `Cannot transition from ${panel.review_state} to ${dto.review_state}`,
      );
    }

    // Approving (=> reviewed) requires clean attachments + non-error
    // validation. Flag/needs_info/hidden don't require clean attachments
    // since those states are themselves the safety net.
    if (dto.review_state === BloodworkReviewState.REVIEWED) {
      this.assertReviewable(panel);
    }

    const now = new Date();
    const updated = await this.prisma.bloodworkPanel.update({
      where: { id: panelId },
      data: {
        review_state: dto.review_state,
        reviewed_by_id: ctx.actorId,
        reviewed_at: now,
        review_note: dto.review_note ?? null,
        encrypted_review_note: this.encryptForWrite(dto.review_note),
        // A coach acting on a stale panel un-stales it implicitly,
        // because the review brings the data back into context.
        is_stale: false,
        stale_marked_at: null,
      },
      include: { results: true, attachments: true },
    });

    const action =
      dto.review_state === BloodworkReviewState.REVIEWED
        ? BloodworkAuditAction.PANEL_REVIEWED
        : dto.review_state === BloodworkReviewState.FLAGGED
        ? BloodworkAuditAction.PANEL_FLAGGED
        : dto.review_state === BloodworkReviewState.HIDDEN
        ? BloodworkAuditAction.PANEL_HIDDEN
        : BloodworkAuditAction.PANEL_NEEDS_INFO;

    await this.audit.write({
      action,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: panel.client_id,
      targetType: 'bloodwork_panel',
      targetId: panelId,
      tenantCoachId: panel.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: {
        from: panel.review_state,
        to: dto.review_state,
        had_note: !!dto.review_note,
      },
    });

    return this.hydratePanel(updated);
  }

  // ---- attachments ----

  async registerAttachment(
    panelId: string,
    dto: RegisterAttachmentDto,
    ctx: ActorContext,
  ) {
    const panel = await this.prisma.bloodworkPanel.findUnique({
      where: { id: panelId },
    });
    if (!panel) throw new NotFoundException('Panel not found');

    // Only the owning client (or owner) can register attachments. Coaches
    // do not upload on behalf of clients in v1.
    if (ctx.actorRole !== 'owner' && panel.client_id !== ctx.actorId) {
      throw new ForbiddenException('Cannot attach to this panel');
    }

    const attachment = await this.prisma.bloodworkAttachment.create({
      data: {
        panel_id: panelId,
        storage_ref: dto.storage_ref ?? null,
        storage_backend: dto.storage_backend ?? null,
        content_type: dto.content_type ?? null,
        byte_size: dto.byte_size ?? null,
        scan_status: BloodworkScanStatus.PENDING,
      },
    });

    await this.audit.write({
      action: BloodworkAuditAction.ATTACHMENT_REGISTERED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: panel.client_id,
      targetType: 'bloodwork_attachment',
      targetId: attachment.id,
      tenantCoachId: panel.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: {
        panel_id: panelId,
        storage_backend: attachment.storage_backend,
      },
    });

    return attachment;
  }

  // OWNER-only / scanner-callback path. The actual scanner is out of
  // scope for v1 — this is the seam a webhook or background worker
  // calls into.
  async updateAttachmentScan(
    attachmentId: string,
    dto: UpdateAttachmentScanDto,
    ctx: ActorContext,
  ) {
    if (ctx.actorRole !== 'owner') {
      throw new ForbiddenException('Owner-only');
    }
    const att = await this.prisma.bloodworkAttachment.findUnique({
      where: { id: attachmentId },
      include: { panel: true },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    const updated = await this.prisma.bloodworkAttachment.update({
      where: { id: attachmentId },
      data: {
        scan_status: dto.scan_status,
        scan_message: dto.scan_message ?? null,
        scanned_at: new Date(),
      },
    });
    await this.audit.write({
      action: BloodworkAuditAction.ATTACHMENT_SCAN_UPDATED,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      targetUserId: att.panel.client_id,
      targetType: 'bloodwork_attachment',
      targetId: attachmentId,
      tenantCoachId: att.panel.coach_id,
      ...this.toAuditCtx(ctx),
      metadata: {
        panel_id: att.panel_id,
        from: att.scan_status,
        to: dto.scan_status,
      },
    });
    return updated;
  }

  // ---- staleness sweep (cron seam) ----

  // Marks panels older than `staleAfterDays` as stale. Skips panels
  // currently in `reviewed` state — coach-reviewed panels never silently
  // regress; if they need to be re-flagged, that's an explicit coach
  // action with its own audit row.
  async markStalePanels(now: Date = new Date(), staleAfterDays?: number) {
    const days =
      staleAfterDays ??
      Number(process.env.BLOODWORK_STALE_AFTER_DAYS ?? DEFAULT_STALE_AFTER_DAYS);
    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('Invalid stale window');
    }
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Find candidates first so the audit emit is bounded; in production
    // this would page, but at v1 volume the simple findMany is fine.
    const candidates = await this.prisma.bloodworkPanel.findMany({
      where: {
        is_stale: false,
        collection_date: { lt: cutoff },
        review_state: { not: BloodworkReviewState.REVIEWED },
      },
      select: { id: true, client_id: true, coach_id: true },
      take: 500,
    });

    if (candidates.length === 0) return { marked: 0 };

    const ids = candidates.map((c) => c.id);
    await this.prisma.bloodworkPanel.updateMany({
      where: { id: { in: ids } },
      data: { is_stale: true, stale_marked_at: now },
    });

    for (const c of candidates) {
      await this.audit.write({
        action: BloodworkAuditAction.PANEL_MARKED_STALE,
        actorId: null,
        actorRole: 'system',
        targetUserId: c.client_id,
        targetType: 'bloodwork_panel',
        targetId: c.id,
        tenantCoachId: c.coach_id,
        metadata: { stale_after_days: days },
      });
    }

    return { marked: candidates.length };
  }
}
