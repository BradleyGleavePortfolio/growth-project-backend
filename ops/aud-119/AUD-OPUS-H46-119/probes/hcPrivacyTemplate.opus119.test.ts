/**
 * AUD-OPUS-H46-119 probe (never merge): B-364-2 plugin against the full Expo bare-template
 * MainActivity shape (several members, nested braces, splash registration), at #364 529ba345.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../../plugins/withHealthConnectPermissionDelegate') as {
  addDelegateToMainActivity: (contents: string, language: string) => string;
  addPermissionUsageAlias: (manifest: unknown) => unknown;
};
import { PRIVACY_POLICY_URL } from '../../../config/env';

const TEMPLATE = `package com.growthproject.app

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper
import expo.modules.splashscreen.SplashScreenManager

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              super.invokeDefaultOnBackPressed()
          }
          return
      }
      super.invokeDefaultOnBackPressed()
  }
}
`;

function balance(s: string): number {
  let d = 0;
  for (const ch of s) {
    if (ch === '{') d += 1;
    if (ch === '}') d -= 1;
    if (d < 0) return -1;
  }
  return d;
}

describe('AUD-OPUS-H46-119 B-364-2 on the full template', () => {
  const out = plugin.addDelegateToMainActivity(TEMPLATE, 'kt');

  it('INVARIANT delegate + privacy check sit inside onCreate right after super.onCreate', () => {
    const onCreate = out.slice(out.indexOf('override fun onCreate'), out.indexOf('override fun getMainComponentName'));
    expect(onCreate).toMatch(
      /super\.onCreate\(null\)\n\s+HealthConnectPermissionDelegate\.setPermissionDelegate\(this\)\n\s+if \(showHealthConnectPrivacyPolicy\(intent\)\) finish\(\)\n\s+\}/,
    );
  });

  it('INVARIANT the handler members are inside the class body, once, braces balanced', () => {
    expect(balance(out)).toBe(0);
    expect(out.match(/fun onNewIntent\(/g)?.length).toBe(1);
    expect(out.match(/fun showHealthConnectPrivacyPolicy\(/g)?.length).toBe(1);
    const classStart = out.indexOf('class MainActivity : ReactActivity() {');
    const handler = out.indexOf('private fun showHealthConnectPrivacyPolicy');
    expect(handler).toBeGreaterThan(out.indexOf('override fun invokeDefaultOnBackPressed'));
    expect(balance(out.slice(classStart, handler))).toBe(1);
    expect(out.trimEnd().endsWith('}')).toBe(true);
    expect(out).toContain(`android.net.Uri.parse("${PRIVACY_POLICY_URL}")`);
    expect(PRIVACY_POLICY_URL).toBe('https://app.trygrowthproject.com/privacy');
  });

  it('INVARIANT idempotent on the full template', () => {
    expect(plugin.addDelegateToMainActivity(out, 'kt')).toBe(out);
  });

  it('INVARIANT the import lands after the package line, once', () => {
    expect(out.match(/import dev\.matinzd\.healthconnect\.permissions\.HealthConnectPermissionDelegate/g)?.length).toBe(1);
    expect(out.indexOf('import dev.matinzd')).toBeGreaterThan(out.indexOf('package com.growthproject.app'));
  });
});
