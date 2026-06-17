import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateJobListingDto, UpdateJobListingDto } from './job-listing.dto';
import { JobListingService } from './job-listing.service';
import { HirerVerifiedGuard } from './hirer-verified.guard';

// TM-2 — verified-hirer JobListing write surface. Every route is hirer-write:
// JwtAuthGuard attaches req.user, HirerVerifiedGuard restricts to a verified
// gym owner / head coach / solo coach, and the service scopes mutations to
// the caller's own listings (RLS enforces the same write-scope at the DB).
//
// Public read of published listings is RLS-driven and lives in a later
// browse ticket — this slice is writes only.
@ApiTags('talent-marketplace')
@Controller('talent-marketplace/listings')
@Roles('coach', 'owner')
@UseGuards(JwtAuthGuard, HirerVerifiedGuard)
export class JobListingController {
  constructor(private readonly listings: JobListingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: AuthedRequest, @Body() dto: CreateJobListingDto) {
    return this.listings.create(req.user.id, dto);
  }

  @Patch(':id')
  async edit(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobListingDto,
  ) {
    return this.listings.edit(req.user.id, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listings.publish(req.user.id, id);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listings.close(req.user.id, id);
  }
}
