/**
 * Read-only source-contract inspection for W3-17.
 * This does not execute application code, run tests, compile, or call a provider.
 * Its output records mechanically verifiable wiring facts, not device delivery.
 */
const fs = require('node:fs');
const path = require('node:path');

const backend = '/home/user/workspace/wt/RO-backend';
const mobile = '/home/user/workspace/wt/RO-mobile';
const output = '/home/user/workspace/ops/aud-123/S-PUSH-123/source-contract-evidence.json';
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const between = (s, first, last) => {
  const start = s.indexOf(first);
  const end = s.indexOf(last, start + first.length);
  if (start < 0 || end < 0) throw new Error(`Missing source boundary: ${first}`);
  return s.slice(start, end);
};

const notifications = read(backend, 'src/notifications/notifications.service.ts');
const direct = between(notifications, '  async pushToUser(', '  /**\n   * Poll Expo receipts');
const wrapper = read(backend, 'src/community/notifications/community-notifications.service.ts');
const envelope = between(wrapper, '      const result = await this.notifications.pushToUser(', '      if (result.delivered)');
const router = read(mobile, 'src/services/pushTapRouter.ts');
const clientRoutes = between(router, 'export const CLIENT_PUSH_ROUTES:', '/** Coach destinations.');
const channelsBackend = read(backend, 'src/notifications/push/push-channels.ts');
const channelsMobile = read(mobile, 'src/notifications/push-channels.ts');
const getIds = (s) => [...s.matchAll(/(?:COACH_MESSAGES|CLIENT_BOT|MILESTONES|SYSTEM): '([^']+)'/g)]
  .slice(0, 4).map((m) => m[1]).sort();
const production = JSON.parse(read(mobile, 'eas.json')).build.production.env;
const communityMessages = read(backend, 'src/community/messages/community-messages.service.ts');
const trial = read(backend, 'src/packages/trials/trial-notice.service.ts');
const prefs = read(backend, 'src/notifications/push/push-preferences.ts');
const results = {
  scope: 'Static source-contract inspection only; no application execution or device delivery',
  backendHead: '5230306cb63df7290459bb362340a42f385f39d5',
  mobileHead: 'a727eb495a0ce381a22c4ac40370c0c69f53a656',
  facts: {
    androidTaxonomyIdsMatch: JSON.stringify(getIds(channelsBackend)) === JSON.stringify(getIds(channelsMobile)),
    androidTaxonomyIds: getIds(channelsBackend),
    communityFlagReadAtCallSite: wrapper.includes("return process.env.FEATURE_COMMUNITY_PUSH === 'true'"),
    communityPrivacyForcedOn: wrapper.includes('return true; // privacy-on, unconditionally'),
    communityPushEnvelopeHasActionScreen: envelope.includes('actionScreen'),
    communityPushEnvelopeHasActionParams: envelope.includes('actionParams'),
    communityPushEnvelopeHasDeepLink: /\bdeep_?[Ll]ink\b/.test(envelope),
    communityInboxWriteResultAssigned: /(?:const|let)\s+\w+\s*=\s*await this\.notifications\.createNotification/.test(wrapper),
    directTransportReadsNotificationPreferences: /getPreferences|notificationPreferences|pushAllowedByPreferences|channelGate/.test(direct),
    directTransportHasExplicitChannelId: direct.includes('channelId'),
    mobileTapRejectsMissingActionScreen: router.includes("if (!actionScreen || typeof actionScreen !== 'string' || !SCREEN_NAME.test(actionScreen)) return;"),
    trialActionScreen: /export const TRIAL_ACTION_SCREEN = '([^']+)'/.exec(trial)?.[1],
    clientPushRoutesContainClientPackages: /ClientPackages\s*:/.test(clientRoutes),
    clientNavigatorContainsClientPackages: read(mobile, 'src/navigation/ClientNavigator.tsx').includes('name="ClientPackages"'),
    communityKindsHaveDedicatedPreferencePrefix: /if\s*\([^)]*community/.test(prefs),
    cohortMessageServiceCallsPush: /sendCommunityPush|pushToUser|sendPush/.test(communityMessages),
    authenticatedRegistrationNeverPrompts: read(mobile, 'App.tsx').includes('registerForPushNotifications({ requestPermission: false })'),
    clientHomeMountsPermissionPrimer: read(mobile, 'src/screens/client/HomeScreen.tsx').includes('<PushPermissionCard />'),
    coachNavigatorMountsPermissionPrimer: read(mobile, 'src/navigation/CoachNavigator.tsx').includes('PushPermissionCard'),
    productionRelevantBuildFlags: Object.fromEntries(Object.entries(production).filter(([k]) =>
      /NOTIFICATIONS_MOCK|COMMUNITY_(TAB|HALL|COHORTS)|CLIENT_CALENDAR/.test(k))),
  },
};
fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
console.log(`Saved ${output}`);
