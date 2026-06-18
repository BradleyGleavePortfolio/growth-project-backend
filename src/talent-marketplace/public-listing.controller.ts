import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { BrowseListingsQueryDto } from './public-listing.dto';
import { PublicListingService } from './public-listing.service';

// TM-3 — public, unauthenticated browse + SEO detail. @Public() opts these two
// routes out of the global JwtAuthGuard; RLS + an explicit published filter in
// the service keep anon to published rows only, and the allow-list DTO keeps the
// payload PII-free. Throttled per-IP since the surface is unauthenticated.
@ApiTags('talent-marketplace')
@Controller('listings')
export class PublicListingController {
  constructor(private readonly listings: PublicListingService) {}

  @Public()
  @Get()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async browse(@Query() query: BrowseListingsQueryDto) {
    return this.listings.browse(query);
  }

  @Public()
  @Get(':id')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.listings.detail(id);
  }
}
