import { randomBytes } from 'crypto';
import { BloodworkService } from '../src/bloodwork/bloodwork.service';
import { BloodworkReviewState } from '../src/bloodwork/bloodwork.constants';
import { KmsService } from '../src/common/kms/kms.service';

// Lightweight Prisma stub focused on the bloodwork read/write paths
// touched by the KMS retrofit. Independent from test/bloodwork.service.spec.ts
// because the existing stub there doesn't need to be coupled to KMS shape.
function buildPrisma() {
  let seq = 1;
  const panels: any[] = [];
  return {
    _panels: panels,
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        coach_id: null,
      })),
    },
    bloodworkPanel: {
      create: jest.fn(async ({ data, include }: any) => {
        const id = `panel-${seq++}`;
        const row: any = {
          id,
          client_id: data.client_id,
          coach_id: data.coach_id ?? null,
          collection_date: data.collection_date,
          source: data.source ?? 'manual_entry',
          panel_label: null,
          notes: data.notes ?? null,
          encrypted_notes: data.encrypted_notes ?? null,
          review_state: data.review_state,
          reviewed_by_id: null,
          reviewed_at: null,
          review_note: null,
          encrypted_review_note: null,
          disclaimer_level: data.disclaimer_level,
          validation_status: data.validation_status ?? 'ok',
          is_stale: false,
          stale_marked_at: null,
          source_missing: false,
          ai_processing_allowed: false,
          encryption_key_ref: data.encryption_key_ref ?? null,
          kms_key_version: data.kms_key_version ?? null,
          submitted_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        panels.push(row);
        const out = { ...row };
        if (include?.results) out.results = [];
        if (include?.attachments) out.attachments = [];
        return out;
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const p = panels.find((x) =>
          Object.entries(where).every(([k, v]) => (x as any)[k] === v),
        );
        if (!p) return null;
        const out = { ...p };
        if (include?.results) out.results = [];
        if (include?.attachments) out.attachments = [];
        return out;
      }),
    },
  } as any;
}

const audit = { write: jest.fn(async () => {}) } as any;
const consent = { isGranted: jest.fn(async () => false) } as any;

const VALID_KEY_B64 = randomBytes(32).toString('base64');

describe('Bloodwork KMS retrofit', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('encrypt-on-write: panel notes are persisted in encrypted_notes when KMS is configured', async () => {
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const prisma = buildPrisma();
    const kms = new KmsService();
    kms.resetForTests();
    const svc = new BloodworkService(prisma, audit, consent, kms);

    await svc.createPanel(
      'client-1',
      {
        collection_date: '2026-05-01',
        notes: 'cholesterol 180 normal',
        results: [],
      } as any,
      { actorId: 'client-1', actorRole: 'student' },
    );

    expect(prisma._panels.length).toBe(1);
    const row = prisma._panels[0];
    expect(row.notes).toBe('cholesterol 180 normal');
    expect(row.encrypted_notes).not.toBe('cholesterol 180 normal');
    expect(row.encrypted_notes).not.toBeNull();
    expect(row.encrypted_notes.startsWith('PLAINTEXT:')).toBe(false);
    expect(row.encryption_key_ref).toBe('local:v1');
    expect(row.kms_key_version).toBe('1');
  });

  it('decrypt-on-read: getForClient returns the plaintext notes for a panel written via encrypted_notes', async () => {
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const prisma = buildPrisma();
    const kms = new KmsService();
    kms.resetForTests();
    const svc = new BloodworkService(prisma, audit, consent, kms);

    const created = await svc.createPanel(
      'client-1',
      {
        collection_date: '2026-05-01',
        notes: 'secret note',
        results: [],
      } as any,
      { actorId: 'client-1', actorRole: 'student' },
    );
    expect(created.notes).toBe('secret note');

    const read = await svc.getForClient('client-1', created.id);
    expect(read.notes).toBe('secret note');
  });

  it('fallback-to-plaintext: when a row has only the legacy plaintext column populated, read returns it', async () => {
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const prisma = buildPrisma();
    const kms = new KmsService();
    kms.resetForTests();
    const svc = new BloodworkService(prisma, audit, consent, kms);

    // Simulate a pre-KMS row directly in the stub.
    prisma._panels.push({
      id: 'legacy-1',
      client_id: 'client-1',
      coach_id: null,
      collection_date: new Date('2026-04-01'),
      source: 'manual_entry',
      panel_label: null,
      notes: 'legacy plaintext from before KMS shipped',
      encrypted_notes: null,
      review_state: BloodworkReviewState.DRAFT,
      reviewed_by_id: null,
      reviewed_at: null,
      review_note: null,
      encrypted_review_note: null,
      disclaimer_level: 'educational_only',
      validation_status: 'ok',
      is_stale: false,
      stale_marked_at: null,
      source_missing: false,
      ai_processing_allowed: false,
      encryption_key_ref: null,
      kms_key_version: null,
      submitted_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const read = await svc.getForClient('client-1', 'legacy-1');
    expect(read.notes).toBe('legacy plaintext from before KMS shipped');
  });

  it('isConfigured-negative: writes a PLAINTEXT:-marked value into encrypted_notes and reads it back transparently', async () => {
    delete process.env.KMS_MASTER_KEY;
    const prisma = buildPrisma();
    const kms = new KmsService();
    kms.resetForTests();
    const svc = new BloodworkService(prisma, audit, consent, kms);

    const created = await svc.createPanel(
      'client-1',
      {
        collection_date: '2026-05-01',
        notes: 'dev note',
        results: [],
      } as any,
      { actorId: 'client-1', actorRole: 'student' },
    );

    const row = prisma._panels[0];
    expect(row.encrypted_notes).toBe('PLAINTEXT:dev note');
    expect(row.encryption_key_ref).toBeNull();
    expect(row.kms_key_version).toBeNull();
    expect(created.notes).toBe('dev note');
  });
});
