# AUD-OPUS-H7-120 — Claude Opus 5.5 lens, mobile #369 (H7 Health Connect sign-out durable) — agent 120

Job: full review of growth-project-mobile#369 at 3252ec79cd9ab1f28165a1913d8ae3096b590d4a (T4: health data, PII).
Claim: ops/lanes120/claims/mobile-369-3252ec79-opus (09:28 PDT 10-05).
Notes: ops/aud-120/AUD-OPUS-H7-120/

## Status log
- 09:28 PDT: started; read _COMMON_120/119/118/116 + AGENT_RULES; PR json + comments saved.

- 09:45 PDT: full diff read (7 files; prod: onDeviceState.ts +139/-?, authActions.ts +17/-?); call sites traced (useWearableConnections,
  onDeviceSync connect/resume/refresh, ConnectProviderSheet runImport, onDeviceCopy connectFailureMessage, api.ts refresh failure,
  biometric-lock onLockout). expo-secure-store 56.0.4 native read: iOS deleteValueWithKeyAsync ignores SecItemDelete status (never
  rejects); Android deleteItemImpl throws on commit false. PR CI Typecheck/lint/test success run 37244309360. Size 1,205 (<1,500).
- Working hypothesis: no A/B; candidate Cs: iOS silent delete makes the replacement-write fallback Android-only (residual wording);
  authority keychainAccessible default WHEN_UNLOCKED migrates in iOS backups (THIS_DEVICE_ONLY would bind consent to the phone);
  biometric lockout bypasses signOut (outside diff); recordLocalAuthorization rejection copy says "is connected" (outside diff).

## HANDOFF
In progress: writing probes (opus120) for a CI lane at 3252ec79. No verdict posted yet.
