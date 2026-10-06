import { WearableProvider } from '@prisma/client';
import { isWearablesCloudConnectorsEnabled } from '../cloud-connectors.feature';

/**
 * B-WEARLIST-125: which cloud trackers a person can really connect right now.
 *
 * The Connections screen lists a cloud provider only when the server says it
 * is connectable, so a provider lights up the moment its keys are set, with no
 * new app build. A provider is connectable when:
 *   - the cloud master switch `FEATURE_WEARABLES_CLOUD_CONNECTORS` is on,
 *   - the shared OAuth settings are present (the callback base URL and the
 *     token-wrapping key; without either, connect or token storage fails), and
 *   - every credential that provider's OAuth start and code exchange read is
 *     present (client id, client secret and its registered redirect URI).
 *
 * Only env var NAMES live here. Values are read for presence only and are
 * never returned, logged or compared.
 */
export const CLOUD_SHARED_ENV: readonly string[] = [
  'WEARABLES_OAUTH_REDIRECT_BASE_URL',
  'KMS_MASTER_KEY',
];

/** The eight cloud connectors, in the order the list is returned. */
export const CLOUD_PROVIDERS = [
  WearableProvider.FITBIT,
  WearableProvider.GARMIN,
  WearableProvider.OURA,
  WearableProvider.POLAR,
  WearableProvider.STRAVA,
  WearableProvider.WAHOO,
  WearableProvider.WHOOP,
  WearableProvider.WITHINGS,
] as const;

export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** Per-provider credentials read by the connector's OAuth start + exchange. */
export const CLOUD_PROVIDER_ENV: Readonly<Record<CloudProvider, readonly string[]>> = {
  [WearableProvider.FITBIT]: ['FITBIT_CLIENT_ID', 'FITBIT_CLIENT_SECRET', 'FITBIT_REDIRECT_URI'],
  [WearableProvider.GARMIN]: ['GARMIN_CLIENT_ID', 'GARMIN_CLIENT_SECRET', 'GARMIN_REDIRECT_URI'],
  [WearableProvider.OURA]: ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'OURA_REDIRECT_URI'],
  [WearableProvider.POLAR]: ['POLAR_CLIENT_ID', 'POLAR_CLIENT_SECRET', 'POLAR_REDIRECT_URI'],
  [WearableProvider.STRAVA]: ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REDIRECT_URI'],
  [WearableProvider.WAHOO]: ['WAHOO_CLIENT_ID', 'WAHOO_CLIENT_SECRET', 'WAHOO_REDIRECT_URI'],
  [WearableProvider.WHOOP]: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI'],
  [WearableProvider.WITHINGS]: [
    'WITHINGS_CLIENT_ID',
    'WITHINGS_CLIENT_SECRET',
    'WITHINGS_REDIRECT_URI',
  ],
};

type Env = Readonly<Record<string, string | undefined>>;

function present(env: Env, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The cloud providers that are connectable now, in a stable order. `isRegistered`
 * reports whether a cloud OAuth connector for the provider is loaded.
 */
export function connectableCloudProviders(
  isRegistered: (provider: WearableProvider) => boolean,
  env: Env = process.env,
  masterSwitchOn: boolean = isWearablesCloudConnectorsEnabled(),
): CloudProvider[] {
  if (!masterSwitchOn) return [];
  if (!CLOUD_SHARED_ENV.every((name) => present(env, name))) return [];
  return CLOUD_PROVIDERS.filter(
    (provider) =>
      CLOUD_PROVIDER_ENV[provider].every((name) => present(env, name)) && isRegistered(provider),
  );
}
