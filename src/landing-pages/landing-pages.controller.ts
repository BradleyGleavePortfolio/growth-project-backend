import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { LandingPageService } from './landing-pages.service';
import { CreateLandingPageDto } from './dto/create-landing-page.dto';
import { UpdateLandingPageDto } from './dto/update-landing-page.dto';
import { LeadsQueryDto } from './dto/leads-query.dto';

/**
 * Coach landing page CRUD + management.
 *
 * All routes are under `/api/v1/coach/landing-pages` (global prefix `/api`
 * applies; the `/v1/coach/` prefix is set at the controller level).
 *
 * Auth: global JwtAuthGuard covers every route. RolesGuard is global and
 * enforces @Roles. CoachGuard is not used here — @Roles('coach','owner') is
 * the authoritative gate per Phase-10 contract-test pattern.
 *
 * Throttle: 60 mutate requests / min / user (spec §5.4).
 */
@ApiTags('landing-pages')
@Roles('coach', 'owner')
@Throttle({ default: { ttl: 60_000, limit: 60 } })
@Controller('v1/coach/landing-pages')
export class LandingPageController {
  constructor(private readonly service: LandingPageService) {}

  // ─── GET / ───────────────────────────────────────────────────────────────

  /** List all pages for the authenticated coach (max 6). */
  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.service.list(req.user.id);
  }

  // ─── POST / ──────────────────────────────────────────────────────────────

  /**
   * Create a new landing page from a template.
   * Returns 409 with {error:'max_pages_reached'} if coach already has 6
   * non-archived pages (spec §9).
   */
  @Post()
  async create(@Request() req: AuthedRequest, @Body() dto: CreateLandingPageDto) {
    return this.service.create(req.user.id, dto);
  }

  // ─── GET /:id ────────────────────────────────────────────────────────────

  /** Get a single page with all sections. */
  @Get(':id')
  async get(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.get(req.user.id, id);
  }

  // ─── PATCH /:id ──────────────────────────────────────────────────────────

  /**
   * Update page fields + sections.
   * Single atomic write via prisma.$transaction.
   * Sections array (if provided) fully replaces existing sections.
   */
  @Patch(':id')
  async update(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateLandingPageDto,
  ) {
    return this.service.update(req.user.id, id, dto);
  }

  // ─── POST /:id/publish ───────────────────────────────────────────────────

  /**
   * Validate + publish a page.
   * Sets status=published, emits landing.published analytics event.
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  async publish(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.publish(req.user.id, id);
  }

  // ─── POST /:id/unpublish ─────────────────────────────────────────────────

  /**
   * Unpublish (archive) a page.
   * Sets status=archived. Public URL immediately 404s.
   */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  async unpublish(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.unpublish(req.user.id, id);
  }

  // ─── DELETE /:id ─────────────────────────────────────────────────────────

  /**
   * Hard delete a page.
   * Cascades to sections, leads, and views via Prisma FK onDelete: Cascade.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Request() req: AuthedRequest, @Param('id') id: string) {
    await this.service.delete(req.user.id, id);
  }

  // ─── GET /:id/analytics ──────────────────────────────────────────────────

  /**
   * Aggregated analytics for a page.
   * Returns: views, scroll depth avg, CTA click rate, form submit rate,
   * $/visitor, top referrers, UTM breakdown.
   */
  @Get(':id/analytics')
  async getAnalytics(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.getAnalytics(req.user.id, id);
  }

  // ─── GET /:id/leads ──────────────────────────────────────────────────────

  /**
   * Paginated leads for a page, cursor-based (newest first).
   */
  @Get(':id/leads')
  async getLeads(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Query() query: LeadsQueryDto,
  ) {
    return this.service.getLeads(req.user.id, id, query);
  }
}
