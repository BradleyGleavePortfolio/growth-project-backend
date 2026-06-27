// Flat config (ESLint v10+) — translated 1:1 from legacy .eslintrc.js.
// Codebase has strict: false TypeScript, so this is intentionally
// conservative. Tighten over time.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');
// H6 (D-H6-3): local plugin exposing @tgp/audit-log-required.
const tgpPlugin = require('./eslint-rules');

module.exports = [
  // Global ignores (replaces .eslintignore + ignorePatterns).
  // Mirrors legacy patterns: dist/, node_modules/, prisma/migrations/, *.js.
  // node_modules is ignored by ESLint by default but we keep it explicit.
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', '**/*.js'],
  },

  // eslint:recommended
  js.configs.recommended,

  // plugin:@typescript-eslint/recommended
  ...tseslint.configs.recommended,

  // Project rules (replaces top-level parser/parserOptions/env/rules)
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    // Preserve legacy behavior: legacy .eslintrc did not enable
    // reportUnusedDisableDirectives, but flat config defaults it to 'warn'.
    // Turn it off to keep parity with pre-migration output.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Codebase relies on `any` in many places; flag as warning, not error
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // typescript-eslint v8 began checking caught errors by default;
          // legacy v6 did not. Preserve original behavior — do not flag
          // unused catch-bound errors.
          caughtErrors: 'none',
        },
      ],
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Nest decorators rely on unused constructor params by design
      '@typescript-eslint/no-empty-function': 'off',
      // Legacy config disabled '@typescript-eslint/no-var-requires'; in
      // typescript-eslint v8 that rule was removed and superseded by
      // 'no-require-imports'. Preserve original intent — allow require().
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // New in eslint:recommended in v9 — was not enforced under the old
      // setup. Disable to preserve 1:1 behavior with the legacy config.
      'no-useless-assignment': 'off',
      // New in eslint:recommended in v10 — was not enforced under the old
      // setup. Disable to preserve 1:1 behavior with the legacy config.
      'preserve-caught-error': 'off',
    },
  },

  // H6 (D-H6-3): @tgp/audit-log-required. Enforced as an error.
  //
  // Scope note (R18 + ratchet): the rule is registered repo-wide as a
  // plugin, but enforcement is RATCHETED onto the set of services whose
  // PII writes are UNCONDITIONALLY brought under withAuditLog() in this
  // wave. The pre-H6 codebase has ~577 historical unwrapped writes across
  // services this lane does not own; flipping the rule to error globally in
  // one PR would (a) break CI on files outside the H6 OWNS set and (b) force
  // edits this lane is forbidden to make. Per BL-DATA-CAPTURE, coverage
  // widens service-by-service as each is migrated; add a path here the
  // moment its writes are wrapped. New files added to this list fail CI on
  // any wrap-less write, which is the D-H6-3 guarantee for everything in
  // scope.
  //
  // Ratchet boundary (deliberate): only files whose EVERY prisma write is
  // unconditionally inside a withAuditLog() callback are enforced here.
  // Several services in this wave (coach, check-ins, messaging, packages,
  // account-deletion, coach-brief) wrap their writes behind an optional
  // `auditLog?` constructor param with a raw-prisma ELSE branch retained so
  // their pre-existing direct-construction specs keep compiling. That ELSE
  // branch is a legitimate wrap-less `this.prisma.<model>.write()` the
  // syntactic rule cannot tell apart from an un-audited write, so enforcing
  // the rule on those files would false-positive on the fallback. They are
  // intentionally EXCLUDED until a follow-up makes the substrate mandatory
  // (drops the fallback). feature-flags.service.ts is excluded because it
  // has no prisma writes at all (no setFlag on HEAD).
  {
    files: [
      // Services whose writes are unconditionally wrapped in this wave.
      'src/users/users.service.ts',
      // The audit substrate itself (writes audit_log; exempted by model).
      'src/audit-log/audit-log.service.ts',
    ],
    plugins: {
      '@tgp': tgpPlugin,
    },
    rules: {
      '@tgp/audit-log-required': [
        'error',
        {
          exceptions: ['auditLogEntry', 'auditLog'],
        },
      ],
    },
  },
];
