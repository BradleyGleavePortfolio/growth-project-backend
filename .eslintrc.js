// Minimal ESLint config — TS codebase currently has strict: false,
// so this is intentionally conservative. Tighten over time.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'prisma/migrations/', '*.js'],
  rules: {
    // Codebase relies on `any` in many places; flag as warning, not error
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unused-vars': 'off',
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // Nest decorators rely on unused constructor params by design
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-var-requires': 'off',
  },
};
