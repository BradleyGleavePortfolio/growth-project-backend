import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ContractEnvelope, ContractEnvelopeStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { renderTemplate, type MergeData } from './contract-merge';
import { ContractsTelemetry } from './contracts.telemetry';
import { isContractsEnabled } from './contracts.feature';
import { ContractTemplateService } from './contract-template.service';
import {
  ProviderEventKind,
  SIGNATURE_PROVIDER,
  SignatureProvider,
} from './providers/signature-provider.interface';

/** Default envelope TTL at SEND time (spec §3.7 / §4). */
const ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Terminal states — no transition may leave these (spec §3.7). */
const TERMINAL: ReadonlySet<ContractEnvelopeStatus> = new Set([
  'SIGNED',
  'DECLINED',
  'EXPIRED',
]);

export type EnvelopeLayer = 'platform_waiver' | 'coach_service';

export interface CreateEnvelopeInput {
  templateId: string;
  clientId: string;
  coachId: string;
  layer: EnvelopeLayer;
  mergeData: MergeData;
  title: string;
  client: { email: string; name: string };
  coach: { email: string; name: string };
}

/**
 * B5 — ContractEnvelopeService (spec §3.1, §3.7).
 *
 * Owns the envelope state machine, calls the active SignatureProvider, writes
 * the audit log, and fires the downstream allow-checkout / void-purchase
 * signals (returned to the caller; the checkout gate consumes them). It is
 * provider-agnostic: it only talks to the bound `SignatureProvider`.
 *
 * FEATURE_CONTRACTS_ENABLED is enforced HERE as a server-side code-level
 * invariant (spec §E):
 *   - createEnvelope() throws ServiceUnavailableException('Contracts
 *     disabled') when the flag is OFF, regardless of caller. No envelope is
 *     ever sent to a provider while OFF.
 *   - applyProviderEvent() (the webhook's state-transition entry) refuses to
 *     mutate state when OFF.
 */
@Injectable()
export class ContractEnvelopeService {
  private readonly logger = new Logger(ContractEnvelopeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: ContractTemplateService,
    private readonly telemetry: ContractsTelemetry,
    @Inject(SIGNATURE_PROVIDER)
    private readonly provider: SignatureProvider,
  ) {}

  // ─── Flag invariant ─────────────────────────────────────────────────────────

  /**
   * The single code-level guard. Every write path (create, transition) calls
   * this first. When the flag is OFF this throws — there is NO code path that
   * sends an envelope or advances state while contracts are disabled.
   */
  private assertContractsEnabled(): void {
    if (!isContractsEnabled()) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_DISABLED',
        message: 'Contracts disabled',
      });
    }
  }

  /** Public read so callers (checkout gate) can branch without throwing. */
  isEnabled(): boolean {
    return isContractsEnabled();
  }

  // ─── Create (DRAFT → SENT) ──────────────────────────────────────────────────

  /**
   * Create an envelope, lock the template version, call the provider, and
   * move DRAFT → SENT. Throws when the feature flag is OFF (invariant).
   */
  async createEnvelope(
    input: CreateEnvelopeInput,
  ): Promise<{ envelope: ContractEnvelope; embedUrl: string }> {
    this.assertContractsEnabled();

    const tpl = await this.templates.getByIdUnscoped(input.templateId);
    if (!tpl.requires_signature) {
      throw new BadRequestException({
        error: 'CONTRACT_TEMPLATE_NO_SIGNATURE',
        message: 'This template does not require a signature.',
      });
    }

    // Render with the version-locked body; signature blocks → provider anchors.
    const rendered = renderTemplate(tpl.body_markdown, input.mergeData, 'anchor');
    if (rendered.unknownTokens.length > 0) {
      // A blank merge field in a legal document is a defect (spec §5.1).
      throw new BadRequestException({
        error: 'CONTRACT_MERGE_FIELDS_UNRESOLVED',
        message: `Unresolved merge fields: ${rendered.unknownTokens.join(', ')}`,
      });
    }
    if (!rendered.hasClientSignatureBlock) {
      throw new BadRequestException({
        error: 'CONTRACT_MISSING_SIGNATURE_BLOCK',
        message: 'Template is missing the client signature block.',
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_MS);

    // Persist DRAFT first so the envelope id can be round-tripped to the
    // provider and resolved by the webhook even if the provider call is slow.
    const draft = await this.prisma.contractEnvelope.create({
      data: {
        template_id: tpl.id,
        template_version: tpl.version,
        client_id: input.clientId,
        coach_id: input.coachId,
        status: 'DRAFT',
        expires_at: expiresAt,
      },
    });

    let providerRequestId: string;
    let embedUrl: string;
    try {
      const res = await this.provider.createSignatureRequest({
        envelopeId: draft.id,
        renderedHtml: rendered.html,
        client: input.client,
        coach: input.coach,
        title: input.title,
        expiresAt,
      });
      providerRequestId = res.providerRequestId;
      embedUrl = res.embedUrl;
    } catch (err) {
      this.logger.error(
        `Provider createSignatureRequest failed for envelope ${draft.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    const sent = await this.prisma.contractEnvelope.update({
      where: { id: draft.id },
      data: {
        status: 'SENT',
        hellosign_request_id: providerRequestId,
      },
    });

    await this.writeAudit(sent.id, null, 'SEND', null, null);
    this.telemetry.envelopeCreated(input.clientId, {
      envelope_id: sent.id,
      layer: input.layer,
      provider: this.provider.providerKey,
      template_id: tpl.id,
      template_version: tpl.version,
    });

    return { envelope: sent, embedUrl };
  }

  // ─── State machine ──────────────────────────────────────────────────────────

  /**
   * Apply a VERIFIED provider event to an envelope, idempotently. This is the
   * authoritative state-transition entry (the webhook calls it). Returns the
   * resolved layer + a `downstream` signal the webhook/checkout consume.
   *
   * Refuses to mutate when the feature flag is OFF (invariant): the webhook
   * still 200-acks the provider but NO state changes.
   */
  async applyProviderEvent(
    providerRequestId: string,
    event: ProviderEventKind,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<
    | { applied: false; reason: 'disabled' | 'not_found' | 'terminal_noop' }
    | {
        applied: true;
        envelope: ContractEnvelope;
        downstream: 'allow_checkout' | 'void_purchase' | 'none';
      }
  > {
    if (!isContractsEnabled()) {
      return { applied: false, reason: 'disabled' };
    }

    const env = await this.prisma.contractEnvelope.findFirst({
      where: { hellosign_request_id: providerRequestId },
    });
    if (!env) {
      return { applied: false, reason: 'not_found' };
    }

    const target = this.targetStatusFor(event);

    // Idempotent: a replay that lands on the already-current terminal state
    // is a no-op (spec §3.8). Always write a WEBHOOK audit row though.
    await this.writeAudit(env.id, null, 'WEBHOOK', ctx.ip ?? null, ctx.userAgent ?? null);

    if (env.status === target) {
      return { applied: false, reason: 'terminal_noop' };
    }
    if (!this.canTransition(env.status, target)) {
      // Out-of-order / illegal transition (e.g. SIGNED after EXPIRED). Never
      // resurrect a terminal envelope (spec §3.7).
      this.logger.warn(
        `Ignoring illegal transition ${env.status} → ${target} for envelope ${env.id}`,
      );
      return { applied: false, reason: 'terminal_noop' };
    }

    const updated = await this.transition(env, target, ctx);
    const layer = await this.resolveLayer(updated);

    if (target === 'SIGNED') {
      this.telemetry.envelopeSigned(updated.client_id, {
        envelope_id: updated.id,
        layer,
      });
      this.telemetry.checkoutGateCleared(updated.client_id, {
        envelope_id: updated.id,
        layer,
      });
      return { applied: true, envelope: updated, downstream: 'allow_checkout' };
    }
    if (target === 'DECLINED') {
      this.telemetry.envelopeDeclined(updated.client_id, {
        envelope_id: updated.id,
      });
      return { applied: true, envelope: updated, downstream: 'void_purchase' };
    }
    // VIEWED
    this.telemetry.envelopeViewed(updated.client_id, {
      envelope_id: updated.id,
    });
    return { applied: true, envelope: updated, downstream: 'none' };
  }

  /**
   * Mark expired envelopes EXPIRED (cron entry). Only SENT/VIEWED envelopes
   * past `expires_at` transition; terminal envelopes are untouched.
   */
  async expireDue(now: Date = new Date()): Promise<number> {
    if (!isContractsEnabled()) return 0;
    const due = await this.prisma.contractEnvelope.findMany({
      where: {
        status: { in: ['SENT', 'VIEWED'] },
        expires_at: { lt: now },
      },
    });
    let count = 0;
    for (const env of due) {
      await this.transition(env, 'EXPIRED', {});
      await this.writeAudit(env.id, null, 'EXPIRE', null, null);
      this.telemetry.envelopeExpired(env.client_id, { envelope_id: env.id });
      count += 1;
    }
    return count;
  }

  /** Client-initiated decline (spec §3.5). Ownership-checked by caller. */
  async declineByClient(
    envelopeId: string,
    clientId: string,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<ContractEnvelope> {
    this.assertContractsEnabled();
    const env = await this.getOwnedByClient(envelopeId, clientId);
    if (env.status === 'DECLINED') return env;
    if (!this.canTransition(env.status, 'DECLINED')) {
      throw new BadRequestException({
        error: 'CONTRACT_ENVELOPE_TERMINAL',
        message: 'This contract can no longer be declined.',
      });
    }
    const updated = await this.transition(env, 'DECLINED', ctx);
    await this.writeAudit(updated.id, clientId, 'DECLINE', ctx.ip ?? null, ctx.userAgent ?? null);
    this.telemetry.envelopeDeclined(clientId, { envelope_id: updated.id });
    return updated;
  }

  // ─── Reads (ownership-checked) ───────────────────────────────────────────────

  async getOwnedByClient(
    envelopeId: string,
    clientId: string,
  ): Promise<ContractEnvelope> {
    const env = await this.prisma.contractEnvelope.findUnique({
      where: { id: envelopeId },
    });
    if (!env || env.client_id !== clientId) {
      throw new NotFoundException({
        error: 'CONTRACT_ENVELOPE_NOT_FOUND',
        message: 'Contract not found.',
      });
    }
    return env;
  }

  /** Client view: state + a freshly-minted, short-lived embed URL (spec §3.5). */
  async getEnvelopeViewForClient(
    envelopeId: string,
    clientId: string,
  ): Promise<{ envelope: ContractEnvelope; embedUrl: string | null }> {
    const env = await this.getOwnedByClient(envelopeId, clientId);
    let embedUrl: string | null = null;
    if (
      isContractsEnabled() &&
      env.hellosign_request_id &&
      (env.status === 'SENT' || env.status === 'VIEWED')
    ) {
      try {
        const res = await this.provider.refreshEmbedUrl(env.hellosign_request_id);
        embedUrl = res.embedUrl;
      } catch (err) {
        this.logger.warn(
          `Could not refresh embed URL for envelope ${env.id}: ${(err as Error).message}`,
        );
      }
    }
    return { envelope: env, embedUrl };
  }

  // ─── Layer-1 idempotency / grandfathering ────────────────────────────────────

  /**
   * Has this client SIGNED the CURRENT platform-waiver version? Idempotent
   * gate so a client who already signed v1 does not re-sign on every purchase
   * (spec C-Layer1). A version bump means new clients see v2; existing signed
   * clients are grandfathered to their signed version (we only require that
   * SOME signed waiver exists for grandfathered clients — see
   * hasSignedAnyPlatformWaiver).
   */
  async hasSignedPlatformWaiverVersion(
    clientId: string,
    templateId: string,
    version: number,
  ): Promise<boolean> {
    const signed = await this.prisma.contractEnvelope.findFirst({
      where: {
        client_id: clientId,
        template_id: templateId,
        template_version: version,
        status: 'SIGNED',
      },
    });
    return !!signed;
  }

  /** Grandfather check: any SIGNED platform-waiver envelope for this client. */
  async hasSignedAnyPlatformWaiver(clientId: string): Promise<boolean> {
    const platformTemplateIds = await this.prisma.contractTemplate.findMany({
      where: { is_platform: true },
      select: { id: true },
    });
    if (platformTemplateIds.length === 0) return false;
    const signed = await this.prisma.contractEnvelope.findFirst({
      where: {
        client_id: clientId,
        status: 'SIGNED',
        template_id: { in: platformTemplateIds.map((t) => t.id) },
      },
    });
    return !!signed;
  }

  /** Find an in-flight (SENT/VIEWED) waiver envelope for this client+version. */
  async findOpenPlatformWaiver(
    clientId: string,
    templateId: string,
    version: number,
  ): Promise<ContractEnvelope | null> {
    return this.prisma.contractEnvelope.findFirst({
      where: {
        client_id: clientId,
        template_id: templateId,
        template_version: version,
        status: { in: ['SENT', 'VIEWED'] },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Find an in-flight coach-service envelope for this client+template+version. */
  async findOpenCoachEnvelope(
    clientId: string,
    templateId: string,
    version: number,
  ): Promise<ContractEnvelope | null> {
    return this.prisma.contractEnvelope.findFirst({
      where: {
        client_id: clientId,
        template_id: templateId,
        template_version: version,
        status: { in: ['SENT', 'VIEWED'] },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Has this client SIGNED a specific coach template version? */
  async hasSignedCoachEnvelope(
    clientId: string,
    templateId: string,
    version: number,
  ): Promise<ContractEnvelope | null> {
    return this.prisma.contractEnvelope.findFirst({
      where: {
        client_id: clientId,
        template_id: templateId,
        template_version: version,
        status: 'SIGNED',
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Bind a SIGNED envelope to a realized purchase (post-payment, spec §4.1). */
  async linkEnvelopeToPurchase(
    envelopeId: string,
    purchaseId: string,
  ): Promise<void> {
    await this.prisma.contractEnvelope.update({
      where: { id: envelopeId },
      data: { purchase_id: purchaseId },
    });
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private targetStatusFor(event: ProviderEventKind): ContractEnvelopeStatus {
    switch (event) {
      case 'VIEWED':
        return 'VIEWED';
      case 'SIGNED':
        return 'SIGNED';
      case 'DECLINED':
        return 'DECLINED';
    }
  }

  /** Monotonic transition rules (spec §3.7). Terminal states are sinks. */
  private canTransition(
    from: ContractEnvelopeStatus,
    to: ContractEnvelopeStatus,
  ): boolean {
    if (TERMINAL.has(from)) return false;
    switch (to) {
      case 'SENT':
        return from === 'DRAFT';
      case 'VIEWED':
        return from === 'SENT';
      case 'SIGNED':
        return from === 'SENT' || from === 'VIEWED';
      case 'DECLINED':
        return from === 'SENT' || from === 'VIEWED';
      case 'EXPIRED':
        return from === 'SENT' || from === 'VIEWED';
      default:
        return false;
    }
  }

  private async transition(
    env: ContractEnvelope,
    to: ContractEnvelopeStatus,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<ContractEnvelope> {
    const data: {
      status: ContractEnvelopeStatus;
      signed_at?: Date;
      ip?: string | null;
      user_agent?: string | null;
      signed_pdf_url?: string | null;
    } = { status: to };
    if (to === 'SIGNED') {
      data.signed_at = new Date();
      data.ip = ctx.ip ?? env.ip ?? null;
      data.user_agent = ctx.userAgent ?? env.user_agent ?? null;
    }
    return this.prisma.contractEnvelope.update({
      where: { id: env.id },
      data,
    });
  }

  /** Persist the signed-PDF URL after async fetch+store (spec §3.8 step 4). */
  async setSignedPdfUrl(envelopeId: string, url: string): Promise<void> {
    await this.prisma.contractEnvelope.update({
      where: { id: envelopeId },
      data: { signed_pdf_url: url },
    });
  }

  async resolveLayer(envelope: ContractEnvelope): Promise<EnvelopeLayer> {
    const tpl = await this.prisma.contractTemplate.findUnique({
      where: { id: envelope.template_id },
      select: { is_platform: true },
    });
    return tpl?.is_platform ? 'platform_waiver' : 'coach_service';
  }

  private async writeAudit(
    envelopeId: string,
    actorId: string | null,
    action: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.prisma.contractAuditEvent.create({
      data: {
        envelope_id: envelopeId,
        actor_id: actorId,
        action,
        ip,
        user_agent: userAgent,
      },
    });
  }
}
