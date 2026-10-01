import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WearableProvider } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/auth.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import { Roles } from '../../common/decorators/roles.decorator';
import { WearablesCloudConnectorsGuard } from '../cloud-connectors.feature';
import { ConnectionsService } from './connections.service';
import { ConnectProviderDto } from './dto/connect-provider.dto';
import { OauthCallbackDto } from './dto/oauth-callback.dto';
import { RegisterOnDeviceDto } from './dto/register-on-device.dto';
import { assertOnDeviceIngestEnabled } from '../on-device-ingest.feature';
import {
  DisconnectResult,
  OauthCallbackResult,
  SafeWearableConnection,
  StartOauthResult,
} from './types';

/**
 * PR-HK-1 — generic wearable OAuth + connection-management API.
 *
 * Every route is JWT-authenticated and user-scoped (the owning user comes
 * from the verified token via `req.user.id`, NEVER from the request body or
 * path — no IDOR surface, 50-Failures #5). Connect + callback are rate-limited
 * (#6) because each triggers an outbound provider OAuth round-trip. Inputs are
 * validated by the global ValidationPipe against the DTOs below; the
 * `:provider` path param is validated against the `WearableProvider` enum by
 * `ParseEnumPipe`. No token material is ever returned or logged (#12).
 *
 * On-device providers (Apple Health / Health Connect) have no server OAuth
 * flow. After the user grants access on the device, the app registers the
 * source with `POST /v1/wearables/connections/on-device` (S14) and then posts
 * samples to `POST /v1/wearables/samples/ingest` with the returned connection
 * id. The service rejects OAuth connect/callback for on-device providers with
 * a 400.
 */
@ApiTags('wearables-connections')
@Controller('v1/wearables/connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  /**
   * Begin a cloud-OAuth connect flow for the authenticated user. Returns the
   * provider authorization URL + an opaque, single-use CSRF state. Tightly
   * rate-limited — 10/min/user is ample for a human tapping "Connect" while
   * stopping automated abuse of the outbound OAuth round-trip.
   */
  @Post('oauth/start')
  @Roles('student')
  @UseGuards(WearablesCloudConnectorsGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async startOauth(
    @Request() req: AuthedRequest,
    @Body() body: ConnectProviderDto,
  ): Promise<StartOauthResult> {
    return this.connections.startOauth(req.user.id, body.provider);
  }

  /**
   * Complete an OAuth callback. The provider redirects the in-app web-view
   * here with `?code&state`; the web-view carries the user's JWT so the route
   * stays authenticated. The CSRF `state` is validated + consumed (single-use)
   * BEFORE any token exchange. Tokens are KMS-wrapped server-side and NEVER
   * returned — the response is just `{success, provider}`.
   */
  @Get('oauth/callback')
  @Roles('student')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async oauthCallback(
    @Query() query: OauthCallbackDto,
  ): Promise<OauthCallbackResult> {
    return this.connections.handleCallback({
      code: query.code,
      state: query.state,
    });
  }

  /**
   * S14 — register the caller's Apple Health or Health Connect source after the
   * device permission grant. Idempotent upsert; returns the token-free
   * connection (its `id` is the `connectionId` for sample ingest). Gated by the
   * same kill switch as ingest (`FEATURE_WEARABLES_INGEST_POST`): when off it
   * returns the typed 503 `wearables_ingest_disabled`, before any DB access.
   */
  @Post('on-device')
  @Roles('student')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async registerOnDevice(
    @Request() req: AuthedRequest,
    @Body() body: RegisterOnDeviceDto,
  ): Promise<SafeWearableConnection> {
    assertOnDeviceIngestEnabled();
    return this.connections.registerOnDevice(req.user.id, body.provider);
  }

  /**
   * List the authenticated user's wearable connections, projected to a
   * token-free shape (mirrors the `WearableConnectionSafe` view). A user only
   * ever sees their own connections.
   */
  @Get()
  @Roles('student', 'coach')
  async list(
    @Request() req: AuthedRequest,
  ): Promise<SafeWearableConnection[]> {
    return this.connections.list(req.user.id);
  }

  /**
   * Soft-disconnect the authenticated user's connection for a provider:
   * status → 'disconnected', tokens cleared, `disconnected_at` stamped. The
   * `:provider` param is enum-validated. IDOR-safe: scoped to `req.user.id`.
   */
  @Delete(':provider')
  @Roles('student')
  @HttpCode(HttpStatus.OK)
  async disconnect(
    @Request() req: AuthedRequest,
    @Param('provider', new ParseEnumPipe(WearableProvider))
    provider: WearableProvider,
  ): Promise<DisconnectResult> {
    return this.connections.disconnect(req.user.id, provider);
  }
}
