/**
 * AUD-OPUS-H6-118 probe (lens only; never merged) — mobile #364 @ a3206441.
 *
 * Android's Health Connect guide: the activity that handles
 * ACTION_SHOW_PERMISSIONS_RATIONALE (and, on Android 14+, the
 * VIEW_PERMISSION_USAGE alias) "must display the same privacy policy you
 * provide for your app in the Google Play Console".
 *
 * At this head the library plugin adds the rationale filter to MainActivity,
 * the local plugin points the Android 14 alias at .MainActivity, and nothing
 * in the generated MainActivity (or the JS tree) reacts to either action, so
 * the Health Connect "privacy policy" link opens the app's normal screen.
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../../../plugins/withHealthConnectPermissionDelegate') as {
  addDelegateToMainActivity: (contents: string, language: string) => string;
  addPermissionUsageAlias: (manifest: Record<string, unknown>) => {
    application: { 'activity-alias': { $: Record<string, string> }[] }[];
  };
};

const ROOT = path.join(__dirname, '..', '..', '..', '..');

/** MainActivity.onCreate as decompiled from the 09-30 clinic APK (same as healthPlatformConfig.test.ts). */
const APK_MAIN_ACTIVITY = `package com.growthproject.app

import android.os.Bundle
import com.facebook.react.ReactActivity
import expo.modules.splashscreen.SplashScreenManager

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }
}
`;

const RATIONALE = 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE';
const USAGE = 'android.intent.action.VIEW_PERMISSION_USAGE';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('AUD-OPUS-H6-118: Health Connect privacy policy link', () => {
  it('control: the Android 14 alias targets MainActivity', () => {
    const out = plugin.addPermissionUsageAlias({
      application: [{ activity: [{ $: { 'android:name': '.MainActivity' } }] }],
    });
    expect(out.application[0]['activity-alias'][0].$['android:targetActivity']).toBe('.MainActivity');
  });

  it('INVARIANT: the generated MainActivity routes the rationale and usage intents to the privacy policy', () => {
    const generated = plugin.addDelegateToMainActivity(APK_MAIN_ACTIVITY, 'kt');
    expect(generated).toContain('setPermissionDelegate(this)'); // control: plugin ran
    const handlesRationale =
      generated.includes('ACTION_SHOW_PERMISSIONS_RATIONALE') || generated.includes(RATIONALE);
    const handlesUsage = generated.includes('VIEW_PERMISSION_USAGE') || generated.includes(USAGE);
    expect({ handlesRationale, handlesUsage }).toEqual({ handlesRationale: true, handlesUsage: true });
  });

  it('INVARIANT: some app code (plugins or src) reacts to either Health Connect privacy intent', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'plugins'))];
    const handlers = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      // The alias declaration itself is not a handler; look for code that
      // reads the action and shows the privacy policy.
      return (
        (text.includes('ACTION_SHOW_PERMISSIONS_RATIONALE') || text.includes('PERMISSION_USAGE')) &&
        (text.includes('PRIVACY_POLICY_URL') || text.includes('/privacy'))
      );
    });
    expect(handlers.map((f) => path.relative(ROOT, f))).not.toEqual([]);
  });
});
