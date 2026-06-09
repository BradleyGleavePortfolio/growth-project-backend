import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { ContractTemplateService } from './contract-template.service';
import { ContractEnvelopeService } from './contract-envelope.service';
import { SignedPdfStore } from './signed-pdf-store.service';
import {
  CreateTemplateDto,
  TestRenderDto,
  UpdateTemplateDto,
} from './contract.dto';
import type { MergeData } from './contract-merge';
import type { Prisma } from '@prisma/client';

/**
 * B5 — ContractEnvelopeController (spec §3.4 / §3.5).
 *
 * Coach-side template CRUD (`@Roles('coach')`, ownership-checked at the
 * service layer — IDOR guard) and client-side envelope endpoints
 * (ownership-checked on `client_id`). The signed-PDF download is gated by a
 * fresh 5-minute signed token (spec §7) bound to the envelope + requester.
 *
 * The webhook (`hellosign-webhook.controller.ts`) is the AUTHORITATIVE source
 * for SIGNED/DECLINED/VIEWED; the client `:id/sign` endpoint is a UX
 * confirmation accelerator only (it never advances state — spec §3.7).
 */
@Controller('contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContractEnvelopeController {
  constructor(
    private readonly templates: ContractTemplateService,
    private readonly envelopes: ContractEnvelopeService,
    private readonly pdfStore: SignedPdfStore,
  ) {}

  // ─── Coach: template CRUD (§3.4) ────────────────────────────────────────────

  @Roles('coach')
  @Post('templates')
  async createTemplate(
    @Req() req: AuthedRequest,
    @Body() dto: CreateTemplateDto,
  ) {
    const tpl = await this.templates.create(req.user.id, {
      name: dto.name,
      body_markdown: dto.body_markdown,
      dynamic_fields_json: dto.dynamic_fields_json as
        | Prisma.InputJsonValue
        | undefined,
    });
    return this.toTemplateView(tpl);
  }

  @Roles('coach')
  @Get('templates')
  async listTemplates(@Req() req: AuthedRequest) {
    const rows = await this.templates.listForCoach(req.user.id);
    return rows.map((t) => this.toTemplateView(t));
  }

  @Roles('coach')
  @Put('templates/:id')
  async updateTemplate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    const tpl = await this.templates.update(req.user.id, id, {
      name: dto.name,
      body_markdown: dto.body_markdown,
      dynamic_fields_json: dto.dynamic_fields_json as
        | Prisma.InputJsonValue
        | undefined,
    });
    return this.toTemplateView(tpl);
  }

  @Roles('coach')
  @Post('templates/:id/test-render')
  @HttpCode(HttpStatus.OK)
  async testRender(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: TestRenderDto,
  ) {
    return this.templates.testRender(
      req.user.id,
      id,
      dto.merge_data as MergeData | undefined,
    );
  }

  // ─── Client: envelope endpoints (§3.5) ──────────────────────────────────────

  @Roles('student', 'coach', 'owner')
  @Get('envelopes/:id')
  async getEnvelope(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { envelope, embedUrl } = await this.envelopes.getEnvelopeViewForClient(
      id,
      req.user.id,
    );
    return this.toEnvelopeView(envelope, embedUrl);
  }

  /**
   * Client-acknowledged confirmation after signing in the embedded iframe.
   * NOT authoritative: the webhook owns the SIGNED transition. This returns
   * the current server-owned state so the client UI can stop polling.
   */
  @Roles('student', 'coach', 'owner')
  @Post('envelopes/:id/sign')
  @HttpCode(HttpStatus.OK)
  async confirmSign(@Req() req: AuthedRequest, @Param('id') id: string) {
    const env = await this.envelopes.getOwnedByClient(id, req.user.id);
    return this.toEnvelopeView(env, null);
  }

  @Roles('student', 'coach', 'owner')
  @Post('envelopes/:id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(@Req() req: AuthedRequest, @Param('id') id: string) {
    const env = await this.envelopes.declineByClient(id, req.user.id, {
      ip: this.ipOf(req),
      userAgent: this.uaOf(req),
    });
    return this.toEnvelopeView(env, null);
  }

  /**
   * Mint a 5-minute signed PDF download token (spec §7). The actual bytes are
   * served via GET `:id/pdf?token=` below.
   */
  @Roles('student', 'coach', 'owner')
  @Post('envelopes/:id/pdf-token')
  @HttpCode(HttpStatus.OK)
  async mintPdfToken(@Req() req: AuthedRequest, @Param('id') id: string) {
    const env = await this.envelopes.getOwnedByClient(id, req.user.id);
    if (!env.signed_pdf_url) {
      throw new NotFoundException({
        error: 'CONTRACT_PDF_NOT_READY',
        message: 'Signed PDF is not available yet.',
      });
    }
    const token = await this.pdfStore.mintSignedToken(env.id, req.user.id);
    return { token, expires_in: this.pdfStore.ttlSeconds };
  }

  /**
   * Download the signed PDF using a fresh 5-minute signed token. The token is
   * bound to the envelope id and the requesting user id — it cannot be
   * replayed for another envelope or by another user (spec §7).
   */
  @Roles('student', 'coach', 'owner')
  @Get('envelopes/:id/pdf')
  async downloadPdf(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    if (!token) {
      throw new BadRequestException({
        error: 'CONTRACT_PDF_TOKEN_REQUIRED',
        message: 'A signed download token is required.',
      });
    }
    let claims;
    try {
      claims = await this.pdfStore.verifySignedToken(token);
    } catch {
      throw new BadRequestException({
        error: 'CONTRACT_PDF_TOKEN_INVALID',
        message: 'The download link is invalid or expired.',
      });
    }
    if (claims.envelope_id !== id || claims.sub !== req.user.id) {
      throw new NotFoundException({
        error: 'CONTRACT_PDF_NOT_FOUND',
        message: 'Signed PDF not found.',
      });
    }
    const env = await this.envelopes.getOwnedByClient(id, req.user.id);
    if (!env.signed_pdf_url) {
      throw new NotFoundException({
        error: 'CONTRACT_PDF_NOT_FOUND',
        message: 'Signed PDF not found.',
      });
    }
    const bytes = await this.pdfStore.readStored(env.signed_pdf_url);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="contract-${env.id}.pdf"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  }

  // ─── View mappers ────────────────────────────────────────────────────────────

  private toTemplateView(t: {
    id: string;
    name: string;
    version: number;
    requires_signature: boolean;
    created_at: Date;
  }) {
    return {
      id: t.id,
      name: t.name,
      version: t.version,
      requires_signature: t.requires_signature,
      created_at: t.created_at,
    };
  }

  private toEnvelopeView(
    e: {
      id: string;
      status: string;
      template_id: string;
      template_version: number;
      signed_at: Date | null;
      expires_at: Date | null;
      created_at: Date;
      signed_pdf_url: string | null;
    },
    embedUrl: string | null,
  ) {
    return {
      id: e.id,
      status: e.status,
      template_id: e.template_id,
      template_version: e.template_version,
      embed_url: embedUrl,
      signed_at: e.signed_at,
      expires_at: e.expires_at,
      created_at: e.created_at,
      has_signed_pdf: !!e.signed_pdf_url,
    };
  }

  private ipOf(req: AuthedRequest): string | null {
    return req.ip ?? req.socket?.remoteAddress ?? null;
  }

  private uaOf(req: AuthedRequest): string | null {
    const ua = req.headers?.['user-agent'];
    return Array.isArray(ua) ? ua[0] : (ua ?? null);
  }
}
