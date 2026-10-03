/**
 * In-memory Prisma + Storage fakes for the A6-PHOTOS service specs.
 *
 * Implements just the query shapes MessagePhotosService and the erasure
 * helpers use (equality, null, in, lt/lte/gt, not, OR, nested
 * `message: { photos: { some: {} } }`), so the specs exercise the real
 * conditional updates rather than mocks that always succeed.
 */
import { randomUUID } from 'crypto';
import type {
  MessagePhotoStorageApi,
  PhotoDownload,
  PhotoObjectStat,
} from '../../../src/message-photos/message-photo-storage';

type Row = Record<string, unknown>;

function cmp(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    for (const [op, arg] of Object.entries(c)) {
      const v = value instanceof Date ? value.getTime() : value;
      const a = arg instanceof Date ? arg.getTime() : arg;
      if (op === 'in') {
        if (!(arg as unknown[]).includes(value)) return false;
      } else if (op === 'lt') {
        if (v === null || v === undefined || !((v as number) < (a as number))) return false;
      } else if (op === 'lte') {
        if (v === null || v === undefined || !((v as number) <= (a as number))) return false;
      } else if (op === 'gt') {
        if (v === null || v === undefined || !((v as number) > (a as number))) return false;
      } else if (op === 'not') {
        if (cmp(value, arg)) return false;
      } else {
        throw new Error(`fake prisma: unsupported operator ${op}`);
      }
    }
    return true;
  }
  return value === cond;
}

export class FakeTable {
  rows: Row[] = [];
  constructor(
    private readonly world: FakeWorld,
    private readonly name: string,
    private readonly defaults: () => Row = () => ({}),
  ) {}

  matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(cond as Row[]).some((w) => this.matches(row, w))) return false;
        continue;
      }
      if (k === 'message' && this.name === 'messageReport') {
        const msg = this.world.messages.find((m) => m.id === row.message_id);
        const some = (cond as { photos?: { some?: Row } }).photos?.some;
        if (some) {
          const has = this.world.messagePhoto.rows.some(
            (p) => p.message_id === row.message_id && this.world.messagePhoto.matches(p, some),
          );
          if (!msg || !has) return false;
        }
        continue;
      }
      if (k === 'kind_target') {
        const kt = cond as { kind: string; target: string };
        if (row.kind !== kt.kind || row.target !== kt.target) return false;
        continue;
      }
      if (!cmp(row[k], cond)) return false;
    }
    return true;
  }

  private project(row: Row, select?: Row): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (k === 'message' && this.name === 'messageReport') {
        const msg = this.world.messages.find((m) => m.id === row.message_id) ?? {};
        const sel = (v as { select: Row }).select;
        const m: Row = {};
        for (const mk of Object.keys(sel)) {
          if (mk === 'photos') {
            const photosSel = (sel.photos as { select: Row }).select;
            m.photos = this.world.messagePhoto.rows
              .filter((p) => p.message_id === row.message_id)
              .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
              .map((p) => this.world.messagePhoto.project(p, photosSel));
          } else m[mk] = msg[mk];
        }
        out.message = m;
      } else if (v === true) out[k] = row[k] ?? null;
    }
    return out;
  }

  async findMany(
    args: { where?: Row; select?: Row; take?: number; orderBy?: unknown } = {},
  ): Promise<Row[]> {
    let rows = this.rows.filter((r) => this.matches(r, args.where));
    if (args.orderBy) {
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      rows = [...rows].sort((a, b) => {
        for (const o of orders as Row[]) {
          const [k, dir] = Object.entries(o)[0];
          const av = a[k] instanceof Date ? (a[k] as Date).getTime() : Number(a[k] ?? 0);
          const bv = b[k] instanceof Date ? (b[k] as Date).getTime() : Number(b[k] ?? 0);
          if (av !== bv) return dir === 'asc' ? av - bv : bv - av;
        }
        return 0;
      });
    }
    if (args.take) rows = rows.slice(0, args.take);
    return rows.map((r) => this.project(r, args.select));
  }

  async findFirst(args: { where?: Row; select?: Row } = {}): Promise<Row | null> {
    const row = this.rows.find((r) => this.matches(r, args.where));
    return row ? this.project(row, args.select) : null;
  }

  async findUnique(args: { where?: Row; select?: Row } = {}): Promise<Row | null> {
    return this.findFirst(args);
  }

  async count(args: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((r) => this.matches(r, args.where)).length;
  }

  async create(args: { data: Row }): Promise<Row> {
    this.world.maybeFail(this.name, 'create');
    const row = { ...this.defaults(), ...args.data };
    if (!row.id) row.id = randomUUID();
    this.rows.push(row);
    return { ...row };
  }

  async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    this.world.maybeFail(this.name, 'updateMany');
    let count = 0;
    for (const r of this.rows) {
      if (this.matches(r, args.where)) {
        Object.assign(r, args.data);
        count += 1;
      }
    }
    return { count };
  }

  async deleteMany(args: { where?: Row }): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.matches(r, args.where));
    return { count: before - this.rows.length };
  }

  async upsert(args: { where: Row; create: Row; update: Row; select?: Row }): Promise<Row> {
    this.world.maybeFail(this.name, 'upsert');
    const existing = this.rows.find((r) => this.matches(r, args.where));
    if (existing) {
      Object.assign(existing, args.update);
      return this.project(existing, args.select);
    }
    const row = { ...this.defaults(), ...args.create, id: randomUUID() };
    this.rows.push(row);
    return this.project(row, args.select);
  }
}

export class FakeWorld {
  messages: Row[] = [];
  failures = new Set<string>();
  readonly messagePhoto: FakeTable;
  readonly messagePhotoErasure: FakeTable;
  readonly messageReport: FakeTable;
  readonly coachMessage: FakeTable;
  readonly user: FakeTable;
  readonly subCoachAssignment: FakeTable;

  constructor() {
    this.messagePhoto = new FakeTable(this, 'messagePhoto', () => ({
      status: 'pending',
      message_id: null,
      storage_key: null,
      content_type: null,
      width: null,
      height: null,
      position: null,
      processing_at: null,
      attached_at: null,
      removed_at: null,
      finalized_at: null,
      created_at: new Date(),
    }));
    this.messagePhotoErasure = new FakeTable(this, 'messagePhotoErasure', () => ({
      attempts: 0,
      completed_at: null,
      last_error: null,
    }));
    this.messageReport = new FakeTable(this, 'messageReport', () => ({
      status: 'pending',
      created_at: new Date(),
    }));
    this.coachMessage = new FakeTable(this, 'coachMessage', () => ({ created_at: new Date() }));
    this.user = new FakeTable(this, 'user');
    this.subCoachAssignment = new FakeTable(this, 'subCoachAssignment');
    // Messages are shared with the report join.
    this.coachMessage.rows = this.messages;
  }

  maybeFail(table: string, method: string): void {
    if (this.failures.has(`${table}.${method}`)) throw new Error(`${table}.${method} unavailable`);
  }

  /** The PrismaService stand-in. $transaction snapshots and restores on throw. */
  prisma() {
    const tables = {
      messagePhoto: this.messagePhoto,
      messagePhotoErasure: this.messagePhotoErasure,
      messageReport: this.messageReport,
      coachMessage: this.coachMessage,
      user: this.user,
      subCoachAssignment: this.subCoachAssignment,
    };
    const snapshot = () =>
      Object.fromEntries(
        Object.entries(tables).map(([k, t]) => [k, t.rows.map((r) => ({ ...r }))]),
      );
    const restore = (snap: Record<string, Row[]>) => {
      for (const [k, t] of Object.entries(tables)) {
        t.rows.splice(0, t.rows.length, ...snap[k]);
      }
    };
    const client = {
      ...tables,
      $transaction: async <T>(fn: (tx: typeof tables) => Promise<T>): Promise<T> => {
        const snap = snapshot();
        try {
          return await fn(tables);
        } catch (err) {
          restore(snap);
          throw err;
        }
      },
    };
    return client;
  }
}

/** A storage fake with real object semantics and switchable faults. */
export class FakePhotoStorage implements MessagePhotoStorageApi {
  objects = new Map<string, { bytes: Buffer; contentType: string }>();
  signedUploads: string[] = [];
  signedReads: Array<{ keys: string[]; ttl: number }> = [];
  down = false;
  failPut = false;

  async createSignedUpload(key: string) {
    if (this.down) return null;
    this.signedUploads.push(key);
    return {
      uploadUrl: `https://storage.invalid/object/upload/sign/message-photos/${key}?token=t`,
      token: 't',
    };
  }

  async stat(key: string): Promise<PhotoObjectStat> {
    if (this.down) return { state: 'unavailable' };
    const o = this.objects.get(key);
    return o ? { state: 'present', size: o.bytes.length } : { state: 'missing' };
  }

  async download(key: string, maxBytes: number): Promise<PhotoDownload> {
    if (this.down) return { state: 'unavailable' };
    const o = this.objects.get(key);
    if (!o) return { state: 'missing' };
    if (o.bytes.length > maxBytes) return { state: 'too_large' };
    return { state: 'ok', bytes: Buffer.from(o.bytes) };
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<'ok' | 'failed'> {
    if (this.down || this.failPut || this.objects.has(key)) return 'failed';
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
    return 'ok';
  }

  async signRead(keys: string[], ttlSec: number): Promise<Map<string, string>> {
    this.signedReads.push({ keys, ttl: ttlSec });
    if (this.down) return new Map();
    return new Map(
      keys
        .filter((k) => this.objects.has(k))
        .map((k) => [
          k,
          `https://storage.invalid/object/sign/message-photos/${k}?token=r&ttl=${ttlSec}`,
        ]),
    );
  }

  async removeObjects(keys: string[]) {
    if (this.down) return { removed: 0, failed: true };
    let removed = 0;
    for (const k of keys) if (this.objects.delete(k)) removed += 1;
    return { removed, failed: false };
  }

  async objectGone(key: string) {
    if (this.down) return null;
    return !this.objects.has(key);
  }

  async removeOwnerFolder(ownerId: string) {
    if (this.down) return { removed: 0, failed: true };
    let removed = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(`${ownerId}/`)) {
        this.objects.delete(k);
        removed += 1;
      }
    }
    return { removed, failed: false };
  }

  async ownerFolderEmpty(ownerId: string) {
    if (this.down) return null;
    return ![...this.objects.keys()].some((k) => k.startsWith(`${ownerId}/`));
  }

  /** Simulate the phone's PUT to the signed upload URL. */
  phoneUploads(key: string, bytes: Buffer): void {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType: 'application/octet-stream' });
  }
}
