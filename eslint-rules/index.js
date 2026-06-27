'use strict';

// H6 — local ESLint plugin registering @tgp custom rules (D-H6-3).
//
// Consumed by eslint.config.js as a flat-config plugin under the `@tgp`
// namespace. New TGP-specific rules register here.
const auditLogRequired = require('./audit-log-required');

module.exports = {
  rules: {
    'audit-log-required': auditLogRequired,
  },
};
