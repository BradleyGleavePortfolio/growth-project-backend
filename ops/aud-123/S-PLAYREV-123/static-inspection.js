// Read-only source/configuration inspection. No native generation, test runner,
// network calls, dependency installation or edits to either repository.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const mobile = '/home/user/workspace/wt/RO-mobile';
const deps = '/home/user/workspace/deps/mobile/node_modules';
const output = '/home/user/workspace/ops/aud-123/S-PLAYREV-123/static-inspection.json';
const base = require(path.join(mobile, 'app.json')).expo;
const dynamicConfig = require(path.join(mobile, 'app.config.js'));
const eas = require(path.join(mobile, 'eas.json'));
const client = fs.readFileSync(
  path.join(mobile, 'src/services/health/healthConnect/healthConnectClient.ts'),
  'utf8',
);
const readTypes = client
  .match(/export const HEALTH_CONNECT_RECORD_TYPES = \[([\s\S]*?)\] as const/)[1]
  .match(/'[^']+'/g)
  .map((value) => value.slice(1, -1));
const permissionNames = {
  Steps: 'READ_STEPS',
  ActiveCaloriesBurned: 'READ_ACTIVE_CALORIES_BURNED',
  HeartRate: 'READ_HEART_RATE',
  RestingHeartRate: 'READ_RESTING_HEART_RATE',
  Vo2Max: 'READ_VO2_MAX',
  ExerciseSession: 'READ_EXERCISE',
  Distance: 'READ_DISTANCE',
  Weight: 'READ_WEIGHT',
  BodyFat: 'READ_BODY_FAT',
  BloodPressure: 'READ_BLOOD_PRESSURE',
  SleepSession: 'READ_SLEEP',
  HeartRateVariabilityRmssd: 'READ_HEART_RATE_VARIABILITY',
  OxygenSaturation: 'READ_OXYGEN_SATURATION',
  RespiratoryRate: 'READ_RESPIRATORY_RATE',
  BodyTemperature: 'READ_BODY_TEMPERATURE',
};
const expected = readTypes
  .map((type) => `android.permission.health.${permissionNames[type]}`)
  .sort();
const configurations = {};
for (const switchValue of ['0', '1']) {
  process.env.TGP_ANDROID_HEALTH_CONNECT = switchValue;
  const config = dynamicConfig({ config: JSON.parse(JSON.stringify(base)) });
  const declared = config.android.permissions
    .filter((permission) => permission.startsWith('android.permission.health.'))
    .sort();
  configurations[switchValue] = {
    enabled: config.extra.healthConnectEnabled,
    healthPermissions: declared,
    blockedPermissions: config.android.blockedPermissions,
    declarationMatchesReadSet:
      switchValue === '1' ? JSON.stringify(declared) === JSON.stringify(expected) : null,
  };
}

const audioEntry = base.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-audio',
);
const audioPluginModule = require(path.join(deps, 'expo-audio/app.plugin.js'));
const audioPlugin = audioPluginModule.default || audioPluginModule;
const audioConfig = audioPlugin(JSON.parse(JSON.stringify(base)), audioEntry[1]);
const rnCatalog = fs.readFileSync(
  path.join(deps, 'react-native/gradle/libs.versions.toml'),
  'utf8',
);
const observations = {
  job: 'S-PLAYREV-123',
  proofLevel: 'Read-only source and config-plugin evaluation; no generated Android project or AAB',
  mobileHead: 'a727eb495a0ce381a22c4ac40370c0c69f53a656',
  backendContextHead: '5230306cb63df7290459bb362340a42f385f39d5',
  healthConnect: { readTypes, configurations },
  profiles: Object.fromEntries(
    ['production', 'clinic'].map((profile) => [
      profile,
      {
        extends: eas.build[profile].extends || null,
        healthConnectSwitch: eas.build[profile].env.TGP_ANDROID_HEALTH_CONNECT,
      },
    ]),
  ),
  audio: {
    config: audioEntry[1],
    androidPermissionsAfterPlugin: audioConfig.android.permissions.filter(
      (permission) => /RECORD_AUDIO|MODIFY_AUDIO|FOREGROUND_SERVICE/.test(permission),
    ),
    recordAudioAndroidExplicitlySpecified:
      Object.prototype.hasOwnProperty.call(audioEntry[1], 'recordAudioAndroid'),
  },
  sdkDefaults: {
    expo: require(path.join(deps, 'expo/package.json')).version,
    reactNative: require(path.join(deps, 'react-native/package.json')).version,
    targetSdk: rnCatalog.match(/^targetSdk = "(\d+)"/m)[1],
    compileSdk: rnCatalog.match(/^compileSdk = "(\d+)"/m)[1],
    configuredMinSdk: base.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withAndroidMinSdk',
    )[1].minSdkVersion,
  },
};
fs.writeFileSync(output, `${JSON.stringify(observations, null, 2)}\n`);
console.log(JSON.stringify(observations, null, 2));
