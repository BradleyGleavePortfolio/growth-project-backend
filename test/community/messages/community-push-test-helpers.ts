import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';

/**
 * Community push stub with push switched off, for unit specs that construct
 * CommunityMessagesService directly and do not exercise the group chat push
 * (C-S-PUSH-4). The fan-out returns before any recipient lookup.
 */
export function noCommunityPush(): CommunityNotificationsService {
  const push: Pick<CommunityNotificationsService, 'pushEnabled' | 'sendCommunityPush'> = {
    pushEnabled: () => false,
    sendCommunityPush: async () => undefined,
  };
  return push as CommunityNotificationsService;
}
