/**
 * H6 — @tgp/audit-log-required ESLint rule unit specs (D-H6-3 LOCKED).
 *
 * Exercises the custom rule (eslint-rules/audit-log-required.js) with the
 * ESLint RuleTester. Positive cases (valid code: writes inside withAuditLog,
 * exempt models, non-service files) and negative cases (invalid code: bare
 * prisma writes in a *.service.ts) prove the D-H6-3 guarantee: every new
 * PII-touching write in an enforced service must be wrapped, or CI fails.
 *
 * ESLint v10 syntax. The rule keys on the virtual filename, so each case sets
 * `filename` to a *.service.ts (enforced) or a non-service path (ignored).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { RuleTester } = require('eslint');
const rule = require('../../eslint-rules/audit-log-required');

// The rule is syntactic and language-agnostic about TS types, so plain JS
// parsing is sufficient; ESLint's default (espree) parser handles the member
// expressions and arrow callbacks the rule inspects.
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('audit-log-required', rule, {
  valid: [
    {
      name: 'prisma write inside a withAuditLog() callback is allowed',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.audit.withAuditLog(ctx, (tx) =>
            tx.user.update({ where: { id }, data: { name } }),
          );
        }
      `,
    },
    {
      name: 'this.prisma write inside withAuditLog() is allowed',
      filename: 'src/coach/coach.service.ts',
      code: `
        async function run() {
          await this.auditLog.withAuditLog(ctx, async (tx) => {
            await tx.coach.create({ data });
            return tx.coach.update({ where: { id }, data });
          });
        }
      `,
    },
    {
      name: 'write to an exempt model (auditLogEntry) is allowed bare',
      filename: 'src/audit-log/audit-log.service.ts',
      code: `
        async function run() {
          await this.prisma.auditLogEntry.create({ data });
        }
      `,
      options: [{ exceptions: ['auditLogEntry', 'auditLog'] }],
    },
    {
      name: 'write to a configured custom exception model is allowed bare',
      filename: 'src/foo/foo.service.ts',
      code: `
        async function run() {
          await this.prisma.featureFlag.upsert({ where, create, update });
        }
      `,
      options: [{ exceptions: ['featureFlag'] }],
    },
    {
      name: 'bare prisma write in a NON-service file is ignored by the rule',
      filename: 'src/users/users.controller.ts',
      code: `
        async function run() {
          await this.prisma.user.delete({ where: { id } });
        }
      `,
    },
    {
      name: 'a non-prisma receiver .create() is not flagged',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.someBuilder.create({ data });
        }
      `,
    },
    {
      name: 'a non-write verb (findMany) is not flagged',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.prisma.user.findMany({ where });
        }
      `,
    },
  ],

  invalid: [
    {
      name: 'bare this.prisma.user.update in a service file is reported',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.prisma.user.update({ where: { id }, data: { name } });
        }
      `,
      errors: [{ messageId: 'missingAuditWrap' }],
    },
    {
      name: 'bare prisma.user.create (no this) in a service file is reported',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await prisma.user.create({ data });
        }
      `,
      errors: [{ messageId: 'missingAuditWrap' }],
    },
    {
      name: 'a delete outside the withAuditLog callback is reported',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.audit.withAuditLog(ctx, (tx) => tx.user.update({ where, data }));
          await this.prisma.user.delete({ where: { id } });
        }
      `,
      errors: [{ messageId: 'missingAuditWrap' }],
    },
    {
      name: 'createMany and deleteMany variants are both reported',
      filename: 'src/users/users.service.ts',
      code: `
        async function run() {
          await this.prisma.user.createMany({ data });
          await this.prisma.session.deleteMany({ where });
        }
      `,
      errors: [{ messageId: 'missingAuditWrap' }, { messageId: 'missingAuditWrap' }],
    },
  ],
});

// RuleTester throws on the first failing assertion when .run() executes, so a
// trivial passing test makes the suite legible to jest's reporter.
describe('@tgp/audit-log-required (D-H6-3)', () => {
  it('passes all RuleTester valid + invalid cases', () => {
    expect(true).toBe(true);
  });
});
