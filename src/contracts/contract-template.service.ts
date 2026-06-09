import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ContractTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  MergeData,
  renderTemplate,
  sampleMergeData,
} from './contract-merge';

/**
 * B5 — ContractTemplateService (spec §3.1, §5).
 *
 * CRUD over ContractTemplate, version bump on edit, merge-field rendering,
 * and `test-render` against sample data. Coach ownership is enforced at the
 * service layer (IDOR guard) for every read/write: a coach can only touch a
 * template whose `coach_id` is their own user id.
 *
 * Versioning (spec §5.2): editing a template via `update()` INCREMENTS
 * `version` in place (the prior version's body is preserved on any
 * already-sent ContractEnvelope via `template_version`, which is locked at
 * send time — see ContractEnvelopeService). We do NOT delete the old body;
 * existing envelopes carry their own version-locked snapshot, rendered fresh
 * from the body that was current when they were sent.
 *
 * Platform-waiver templates (is_platform=true) are seeded by the migration
 * seeder and owned by the TGP system-coach user; coach CRUD endpoints can
 * never read or mutate them (the ownership guard rejects).
 */
@Injectable()
export class ContractTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    coachId: string,
    input: { name: string; body_markdown: string; dynamic_fields_json?: Prisma.InputJsonValue },
  ): Promise<ContractTemplate> {
    return this.prisma.contractTemplate.create({
      data: {
        coach_id: coachId,
        is_platform: false,
        name: input.name,
        body_markdown: input.body_markdown,
        version: 1,
        dynamic_fields_json: input.dynamic_fields_json ?? {},
        requires_signature: true,
      },
    });
  }

  /** List the coach's own (non-platform) templates. */
  async listForCoach(coachId: string): Promise<ContractTemplate[]> {
    return this.prisma.contractTemplate.findMany({
      where: { coach_id: coachId, is_platform: false },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Ownership-checked fetch; throws 404 (non-leaking) on miss/IDOR. */
  async getOwnedById(
    coachId: string,
    templateId: string,
  ): Promise<ContractTemplate> {
    const tpl = await this.prisma.contractTemplate.findUnique({
      where: { id: templateId },
    });
    if (!tpl || tpl.coach_id !== coachId || tpl.is_platform) {
      throw new NotFoundException({
        error: 'CONTRACT_TEMPLATE_NOT_FOUND',
        message: 'Contract template not found.',
      });
    }
    return tpl;
  }

  /**
   * Edit a template → bumps version in place (spec §5.2). Already-sent
   * envelopes are unaffected because they lock `template_version` at send.
   */
  async update(
    coachId: string,
    templateId: string,
    input: { name?: string; body_markdown?: string; dynamic_fields_json?: Prisma.InputJsonValue },
  ): Promise<ContractTemplate> {
    const existing = await this.getOwnedById(coachId, templateId);
    return this.prisma.contractTemplate.update({
      where: { id: existing.id },
      data: {
        name: input.name ?? existing.name,
        body_markdown: input.body_markdown ?? existing.body_markdown,
        dynamic_fields_json:
          input.dynamic_fields_json ??
          (existing.dynamic_fields_json as Prisma.InputJsonValue),
        version: { increment: 1 },
      },
    });
  }

  /**
   * Render a template against sample (or supplied) merge data. Returns a
   * preview + a loud list of unknown/missing tokens (spec §5.1). No envelope
   * is created. Coach-owned templates only.
   */
  async testRender(
    coachId: string,
    templateId: string,
    overrides?: MergeData,
  ): Promise<{
    preview_html: string;
    unknown_tokens: string[];
    has_client_signature_block: boolean;
    has_coach_signature_block: boolean;
  }> {
    const tpl = await this.getOwnedById(coachId, templateId);
    const data = { ...sampleMergeData(), ...(overrides ?? {}) };
    const res = renderTemplate(tpl.body_markdown, data, 'preview');
    return {
      preview_html: res.html,
      unknown_tokens: res.unknownTokens,
      has_client_signature_block: res.hasClientSignatureBlock,
      has_coach_signature_block: res.hasCoachSignatureBlock,
    };
  }

  /** Resolve the CURRENT platform liability waiver template (Layer 1). */
  async getActivePlatformWaiver(): Promise<ContractTemplate | null> {
    return this.prisma.contractTemplate.findFirst({
      where: { is_platform: true },
      orderBy: { version: 'desc' },
    });
  }

  /** Internal: load any template by id (used by the envelope service). */
  async getByIdUnscoped(templateId: string): Promise<ContractTemplate> {
    const tpl = await this.prisma.contractTemplate.findUnique({
      where: { id: templateId },
    });
    if (!tpl) {
      throw new NotFoundException({
        error: 'CONTRACT_TEMPLATE_NOT_FOUND',
        message: 'Contract template not found.',
      });
    }
    return tpl;
  }

  /** Guard helper: a coach may only attach their OWN template to a package. */
  assertCoachOwnsTemplate(
    tpl: ContractTemplate,
    coachId: string,
  ): void {
    if (tpl.is_platform || tpl.coach_id !== coachId) {
      throw new ForbiddenException({
        error: 'CONTRACT_TEMPLATE_FORBIDDEN',
        message: 'You can only attach your own contract template.',
      });
    }
  }
}
