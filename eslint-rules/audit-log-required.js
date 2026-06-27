'use strict';

// H6 — custom ESLint rule @tgp/audit-log-required (D-H6-3 LOCKED).
//
// Flags any Prisma write (`.create` / `.update` / `.delete` / `.upsert`,
// plus the `*Many` and `createManyAndReturn` variants) inside a
// `*.service.ts` file that is NOT lexically enclosed by a `withAuditLog(...)`
// callback. This enforces the operator ruling that every PII-touching write
// records an audit row in the same transaction.
//
// Exceptions:
//   - `exceptions: string[]` option lists model accessors that are exempt
//     (non-PII / infra tables: `auditLogEntry` itself, `auditLog`,
//     `_prisma_migrations`, ...). Start narrow; widen only when needed.
//   - Writes that already receive a transaction client whose binding is the
//     `withAuditLog` callback param are, by construction, inside the wrap.
//
// Detection model (deliberately syntactic, not type-aware so it runs in the
// existing lint job with no type-checker cost):
//   1. Find a MemberExpression call `<recv>.<model>.<writeVerb>(...)` where
//      <recv> ends in `prisma` or `tx` (e.g. `this.prisma`, `prisma`, `tx`).
//   2. Walk ancestors; if any is a CallExpression whose callee name is
//      `withAuditLog` (or `this.audit.withAuditLog`, `auditLog.withAuditLog`),
//      the write is covered -> OK.
//   3. Otherwise report.

const WRITE_VERBS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

// Default model-accessor exceptions (camelCase Prisma accessors / infra).
const DEFAULT_EXCEPTIONS = ['auditLogEntry', 'auditLog', '_prisma_migrations'];

function receiverEndsInPrismaOrTx(node) {
  // node is the object of the model member expression, e.g. `this.prisma`,
  // `prisma`, `tx`, `this.tx`. Return true if it resolves to a prisma/tx-ish
  // identifier.
  let cur = node;
  // Unwrap `this.prisma` -> property `prisma`.
  if (cur.type === 'MemberExpression') {
    cur = cur.property;
  }
  if (cur.type === 'Identifier') {
    const n = cur.name.toLowerCase();
    return n === 'prisma' || n === 'tx' || n.endsWith('prisma') || n === 'db';
  }
  return false;
}

function calleeName(node) {
  // Return the rightmost identifier name of a call's callee.
  let callee = node.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require Prisma writes in *.service.ts to run inside a withAuditLog() callback (D-H6-3).',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          exceptions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAuditWrap:
        "Prisma write '{{model}}.{{verb}}(...)' is not inside a withAuditLog() callback. Wrap PII-touching writes per D-H6-3, or add the model to the rule exceptions if it is non-PII.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const exceptions = new Set([...DEFAULT_EXCEPTIONS, ...(options.exceptions || [])]);

    const filename = (context.getFilename && context.getFilename()) || context.filename || '';
    // Only enforce inside service files.
    if (!/\.service\.ts$/.test(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier') return;

        const verb = callee.property.name;
        if (!WRITE_VERBS.has(verb)) return;

        // callee.object should be `<recv>.<model>` (a MemberExpression).
        const modelMember = callee.object;
        if (modelMember.type !== 'MemberExpression') return;
        if (modelMember.property.type !== 'Identifier') return;

        const model = modelMember.property.name;
        if (exceptions.has(model)) return;

        // The receiver of the model accessor: `this.prisma` / `prisma` / `tx`.
        if (!receiverEndsInPrismaOrTx(modelMember.object)) return;

        // Walk ancestors looking for a withAuditLog(...) call enclosing us.
        const ancestors = (context.sourceCode || context.getSourceCode()).getAncestors
          ? (context.sourceCode || context.getSourceCode()).getAncestors(node)
          : context.getAncestors();

        const wrapped = ancestors.some(
          (a) => a.type === 'CallExpression' && calleeName(a) === 'withAuditLog',
        );
        if (wrapped) return;

        context.report({
          node,
          messageId: 'missingAuditWrap',
          data: { model, verb },
        });
      },
    };
  },
};
