// Read-side double for CoachMoneyService over a StatefulPrisma store.
//
// The payment pipeline's real services (DunningService,
// RefundDisputeHandlerService, SplitLedgerService) write rows into a
// StatefulPrisma; this double then answers CoachMoneyService's OWN queries
// against those rows: it evaluates the service's where clauses (scalar
// operators via matchWhere, plus Prisma relation filters `some` / `none` /
// `every` and nested to-one filters), nested `select` with relation
// where / orderBy / take, and top-level orderBy / take / cursor. So a test
// proves "what production writes is what the Money page reads", not a
// hand-shaped fixture.
import { matchWhere, StatefulPrisma } from './stateful-prisma';

type Row = Record<string, any>;
type Relation = { model: string; many: boolean; resolve: (row: Row, db: StatefulPrisma) => Row[] };

const RELATIONS: Record<string, Record<string, Relation>> = {
  clientPurchase: {
    client: {
      model: 'user',
      many: false,
      resolve: (r, db) => (db.state.user ?? []).filter((u) => u.id === r.client_user_id),
    },
    package: {
      model: 'coachPackage',
      many: false,
      resolve: (r, db) => (db.state.coachPackage ?? []).filter((p) => p.id === r.package_id),
    },
    refunds: {
      model: 'chargeRefund',
      many: true,
      resolve: (r, db) => (db.state.chargeRefund ?? []).filter((x) => x.purchase_id === r.id),
    },
    disputes: {
      model: 'chargeDispute',
      many: true,
      resolve: (r, db) => (db.state.chargeDispute ?? []).filter((x) => x.purchase_id === r.id),
    },
    splits: {
      model: 'splitLedgerEntry',
      many: true,
      resolve: (r, db) => (db.state.splitLedgerEntry ?? []).filter((x) => x.purchase_id === r.id),
    },
    dunning: {
      model: 'dunningState',
      many: false,
      resolve: (r, db) => (db.state.dunningState ?? []).filter((x) => x.purchase_id === r.id),
    },
  },
  dunningState: {
    attempts: {
      model: 'dunningAttempt',
      many: true,
      resolve: (r, db) =>
        (db.state.dunningAttempt ?? []).filter((x) => x.dunning_state_id === r.id),
    },
  },
  chargeRefund: {
    purchase: {
      model: 'clientPurchase',
      many: false,
      resolve: (r, db) => (db.state.clientPurchase ?? []).filter((p) => p.id === r.purchase_id),
    },
  },
  chargeDispute: {
    purchase: {
      model: 'clientPurchase',
      many: false,
      resolve: (r, db) => (db.state.clientPurchase ?? []).filter((p) => p.id === r.purchase_id),
    },
  },
  splitLedgerEntry: {
    purchase: {
      model: 'clientPurchase',
      many: false,
      resolve: (r, db) => (db.state.clientPurchase ?? []).filter((p) => p.id === r.purchase_id),
    },
    reversal_postings: {
      model: 'splitLedgerReversal',
      many: true,
      resolve: (r, db) => (db.state.splitLedgerReversal ?? []).filter((x) => x.entry_id === r.id),
    },
  },
};

export function whereMatch(db: StatefulPrisma, model: string, row: Row, where?: Row): boolean {
  if (!where) return true;
  const rels = RELATIONS[model] ?? {};
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(cond as Row[]).every((w) => whereMatch(db, model, row, w))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => whereMatch(db, model, row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (whereMatch(db, model, row, cond)) return false;
      continue;
    }
    const rel = rels[k];
    if (rel) {
      const related = rel.resolve(row, db);
      if (rel.many) {
        if (cond.some && !related.some((x) => whereMatch(db, rel.model, x, cond.some)))
          return false;
        if (cond.none && related.some((x) => whereMatch(db, rel.model, x, cond.none))) return false;
        if (cond.every && !related.every((x) => whereMatch(db, rel.model, x, cond.every)))
          return false;
      } else {
        const one = related[0];
        if (!one || !whereMatch(db, rel.model, one, cond)) return false;
      }
      continue;
    }
    if (!matchWhere(row, { [k]: cond })) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (av === bv) continue;
      const c = av < bv ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export function project(db: StatefulPrisma, model: string, row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const rels = RELATIONS[model] ?? {};
  const out: Row = {};
  for (const [k, spec] of Object.entries(select)) {
    if (!spec) continue;
    const rel = rels[k];
    if (rel && typeof spec === 'object') {
      let related = rel.resolve(row, db).filter((x) => whereMatch(db, rel.model, x, spec.where));
      related = sortRows(related, spec.orderBy);
      if (typeof spec.take === 'number') related = related.slice(0, spec.take);
      const projected = related.map((x) => project(db, rel.model, x, spec.select));
      out[k] = rel.many ? projected : (projected[0] ?? null);
    } else {
      out[k] = row[k] ?? null;
    }
  }
  return out;
}

export function findMany(db: StatefulPrisma, model: string, args: Row = {}): Row[] {
  let rows = (db.state[model] ?? []).filter((r) => whereMatch(db, model, r, args.where));
  rows = sortRows(rows, args.orderBy);
  if (args.cursor) {
    const i = rows.findIndex((r) => r.id === args.cursor.id);
    rows = i >= 0 ? rows.slice(i + (args.skip ?? 0)) : [];
  }
  if (Array.isArray(args.distinct)) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const key = JSON.stringify(args.distinct.map((f: string) => r[f]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (typeof args.take === 'number') rows = rows.slice(0, args.take);
  return rows.map((r) => project(db, model, r, args.select));
}

/** The prisma surface CoachMoneyService reads, answered from the store. */
export function moneyReadPrisma(db: StatefulPrisma) {
  const many = (model: string) => async (args: Row) => findMany(db, model, args);
  return {
    clientPurchase: {
      findMany: many('clientPurchase'),
      findFirst: async (args: Row) =>
        findMany(db, 'clientPurchase', { ...args, take: 1 })[0] ?? null,
    },
    splitLedgerEntry: { findMany: many('splitLedgerEntry') },
    chargeDispute: { findMany: many('chargeDispute') },
    chargeRefund: { findMany: many('chargeRefund') },
    connectAccount: {
      findUnique: async (args: Row) => findMany(db, 'connectAccount', args)[0] ?? null,
    },
  };
}
