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

// TM-3 — public browse + SEO detail. @Public() opts these routes out of the
// global JwtAuthGuard; the service's published filter + allow-list DTO keep anon
// to published, PII-free rows. Throttled per-IP since the surface is anon.
@ApiTags('talent-marketplace')
@Controller('talent-marketplace/public/listings')
@Public()
@Throttle({ default: { ttl: 60000, limit: 60 } })
export class PublicListingController {
  constructor(private readonly listings: PublicListingService) {}

  @Get()
  async browse(@Query() query: BrowseListingsQueryDto) {
    return this.listings.browse(query);
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.listings.detail(id);
  }
}
