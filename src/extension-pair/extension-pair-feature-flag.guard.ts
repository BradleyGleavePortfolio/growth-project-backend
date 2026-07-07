import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

// Off by default. Read per request (never boot-cached) so an operator kill
// takes effect without a redeploy — mirrors resolveCommunityFlag.
export function extensionPairingEnabled(): boolean {
  return process.env.FEATURE_EXTENSION_PAIRING === 'true';
}

@Injectable()
export class ExtensionPairingFeatureFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (extensionPairingEnabled()) return true;
    // 404, not 403: hide the route's existence entirely while the flag is off.
    throw new NotFoundException('Cannot POST /api/extension/pair');
  }
}
