/**
 * /exercise-catalog — coach + client read surface.
 * /admin/exercise-catalog — owner write surface (attach Mux assets,
 *                           seed new catalog rows).
 *
 * Auth model:
 *   - List + detail: JWT-guarded (the global JwtAuthGuard). Anyone
 *     authenticated can read; we do not gate the catalog by role.
 *   - Owner write surface: OwnerGuard. Coaches don't get a Mux upload
 *     surface in v1 — owner ingests the canonical catalog. v2 may
 *     introduce coach-uploaded variations.
 *
 * Mux-disabled handling: catches MuxDisabledError from the service and
 * re-throws it as a structured 503 matching the mobile client's
 * contract:
 *   { error: 'mux_disabled', action: '...' }.
 *
 * The mobile client is built to expect this shape only on the *attach*
 * paths — the list + detail reads degrade gracefully to
 * `playbackUrl: null` per the same contract.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OwnerGuard } from '../common/guards/owner.guard';
import { JwtAuthGuard } from '../auth/auth.guard';
import { MuxDisabledError } from '../video/mux.errors';
import {
  AttachMuxAssetDto,
  CreateCatalogItemDto,
  CreateMuxUploadDto,
  ExerciseCatalogDetailDto,
  ExerciseCatalogListQueryDto,
  ExerciseCatalogListResponse,
} from './exercise-catalog.dto';
import { ExerciseCatalogService } from './exercise-catalog.service';

function translateMuxDisabled<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err) => {
    if (err instanceof MuxDisabledError) {
      throw new HttpException(
        { error: 'mux_disabled', action: err.action },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw err;
  });
}

@ApiTags('exercise-catalog')
@Controller('exercise-catalog')
@UseGuards(JwtAuthGuard)
export class ExerciseCatalogController {
  constructor(private readonly catalog: ExerciseCatalogService) {}

  @Get()
  list(
    @Query() query: ExerciseCatalogListQueryDto,
  ): Promise<ExerciseCatalogListResponse> {
    return this.catalog.list(query);
  }

  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string): Promise<ExerciseCatalogDetailDto> {
    return this.catalog.getByIdOrSlug(idOrSlug);
  }
}

@ApiTags('exercise-catalog')
@Controller('admin/exercise-catalog')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminExerciseCatalogController {
  constructor(private readonly catalog: ExerciseCatalogService) {}

  // Bulk creation is handled by the seed script — single-row create is here
  // for ad-hoc additions from the admin console.
  @Post()
  create(@Body() dto: CreateCatalogItemDto) {
    return this.catalog.createItem(dto);
  }

  // Mux upload flow: owner POSTs `/video/upload`, gets a direct-upload URL,
  // uploads the file from the admin console, then waits for the webhook to
  // flip status from `uploading` -> `processing` -> `ready`.
  @Post(':idOrSlug/video/upload')
  createUpload(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: CreateMuxUploadDto,
  ) {
    return translateMuxDisabled(
      this.catalog.createUpload(idOrSlug, dto.playbackPolicy ?? 'public', dto.corsOrigin),
    );
  }

  // Alternate flow: an asset already exists on Mux (uploaded out-of-band)
  // and the owner just wants to bind it to a catalog row.
  @Put(':idOrSlug/video')
  attach(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: AttachMuxAssetDto,
  ) {
    return translateMuxDisabled(this.catalog.attachAsset(idOrSlug, dto.muxAssetId));
  }

  @Delete(':idOrSlug/video')
  detach(@Param('idOrSlug') idOrSlug: string) {
    return this.catalog.detachAsset(idOrSlug);
  }
}
