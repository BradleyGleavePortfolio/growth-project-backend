import { SetMetadata } from '@nestjs/common';

export const SKIP_CLIENT_ENTITLEMENT_KEY = 'skipClientEntitlement';
export const SkipClientEntitlement = () => SetMetadata(SKIP_CLIENT_ENTITLEMENT_KEY, true);
