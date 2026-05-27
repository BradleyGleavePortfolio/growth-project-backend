// Flat config (ESLint v10+) — translated 1:1 from legacy .eslintrc.js.
// Codebase has strict: false TypeScript, so this is intentionally
// conservative. Tighten over time.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = [
  // Global ignores (replaces .eslintignore + ignorePatterns).
  // Mirrors legacy patterns: dist/, node_modules/, prisma/migrations/, *.js.
  // node_modules is ignored by ESLint by default but we keep it explicit.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'prisma/migrations/**',
      '**/*.js',
    ],
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
];
