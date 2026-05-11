import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BloodworkService } from '../src/bloodwork/bloodwork.service';
import {
  BloodworkAuditAction,
  BloodworkReviewState,
  BloodworkScanStatus,
  BloodworkValidationStatus,
} from '../src/bloodwork/bloodwork.constants';
import { ConsentScope } from '../src/consent/consent.service';
import { KmsService } from '../src/common/kms/kms.service';

// In-memory Prisma stub. Just enough surface to exercise the bloodwork
// service paths under test. Models the panel/result/attachment relations
// with naive arrays.
function buildPrisma(initialUsers: Array<{ id: string; coach_id?: string | null }> = []) {
  const users = new Map(
    initialUsers.map((u) => [u.id, { id: u.id, coach_id: u.coach_id ?? null }]),
  );
  const panels: any[] = [];
  const results: any[] = [];
  const attachments: any[] = [];
  let seq = 1;
  const newId = (p: string) => `${p}-${seq++}`;

  return {
    _panels: panels,
    _results: results,
    _attachments: attachments,
    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = users.get(where.id);
        if (!u) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (u as any)[k];
          return out;
        }
        return { ...u };
      }),
    },
    bloodworkPanel: {
      create: jest.fn(async ({ data, include }: any) => {
        const id = newId('panel');
        const panel: any = {
          id,
          client_id: data.client_id,
          coach_id: data.coach_id ?? null,
          collection_date: data.collection_date,
          source: data.source ?? 'manual_entry',
          panel_label: data.panel_label ?? null,
          notes: data.notes ?? null,
          encrypted_notes: data.encrypted_notes ?? null,
          review_state: data.review_state ?? 'draft',
          reviewed_by_id: null,
          reviewed_at: null,
          review_note: null,
          encrypted_review_note: null,
          disclaimer_level: data.disclaimer_level ?? 'educational_only',
          validation_status: data.validation_status ?? 'ok',
          is_stale: false,
          stale_marked_at: null,
          source_missing: data.source_missing ?? false,
          ai_processing_allowed: data.ai_processing_allowed ?? false,
          encryption_key_ref: data.encryption_key_ref ?? null,
          kms_key_version: data.kms_key_version ?? null,
          submitted_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        panels.push(panel);
        if (data.results?.create) {
          for (const r of data.results.create) {
            results.push({
              id: newId('result'),
              panel_id: id,
              ...r,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }
        }
        if (include) {
          const out: any = { ...panel };
          if (include.results) out.results = results.filter((r) => r.panel_id === id);
          if (include.attachments) out.attachments = attachments.filter((a) => a.panel_id === id);
          return out;
        }
        return panel;
      }),
      findUnique: jest.fn(async ({ where, include }: any) => {
        const p = panels.find((x) => x.id === where.id);
        if (!p) return null;
        const out: any = { ...p };
        if (include?.results) out.results = results.filter((r) => r.panel_id === p.id);
        if (include?.attachments) out.attachments = attachments.filter((a) => a.panel_id === p.id);
        if (include?.panel) out.panel = p;
        return out;
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const p = panels.find((x) => {
          for (const k of Object.keys(where)) {
            if ((x as any)[k] !== (where as any)[k]) return false;
          }
          return true;
        });
        if (!p) return null;
        const out: any = { ...p };
        if (include?.results) out.results = results.filter((r) => r.panel_id === p.id);
        if (include?.attachments) out.attachments = attachments.filter((a) => a.panel_id === p.id);
        return out;
      }),
      findMany: jest.fn(async ({ where, include, take }: any) => {
        const matches = panels.filter((p) => {
          if (where?.client_id && p.client_id !== where.client_id) return false;
          if (where?.coach_id && p.coach_id !== where.coach_id) return false;
          if (where?.review_state) {
            if (typeof where.review_state === 'string') {
              if (p.review_state !== where.review_state) return false;
            } else if (where.review_state.in) {
              if (!where.review_state.in.includes(p.review_state)) return false;
            } else if (where.review_state.not) {
              if (p.review_state === where.review_state.not) return false;
            }
          }
          if (where?.is_stale === false && p.is_stale !== false) return false;
          if (where?.collection_date?.lt) {
            if (!(p.collection_date < where.collection_date.lt)) return false;
          }
          return true;
        });
        const sliced = take ? matches.slice(0, take) : matches;
        return sliced.map((p) => {
          const out: any = { ...p };
          if (include?.results) out.results = results.filter((r) => r.panel_id === p.id);
          if (include?.attachments) {
            out.attachments = attachments.filter((a) => a.panel_id === p.id);
          }
          return out;
        });
      }),
      update: jest.fn(async ({ where, data, include }: any) => {
        const p = panels.find((x) => x.id === where.id);
        if (!p) throw new Error('not found');
        Object.assign(p, data, { updated_at: new Date() });
        const out: any = { ...p };
        if (include?.results) out.results = results.filter((r) => r.panel_id === p.id);
        if (include?.attachments) out.attachments = attachments.filter((a) => a.panel_id === p.id);
        return out;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const p of panels) {
          if (where.id?.in && where.id.in.includes(p.id)) {
            Object.assign(p, data, { updated_at: new Date() });
            count++;
          }
        }
        return { count };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = panels.findIndex((x) => x.id === where.id);
        if (idx >= 0) panels.splice(idx, 1);
        return { id: where.id };
      }),
    },
    bloodworkAttachment: {
      create: jest.fn(async ({ data }: any) => {
        const att = {
          id: newId('att'),
          panel_id: data.panel_id,
          storage_ref: data.storage_ref ?? null,
          storage_backend: data.storage_backend ?? null,
          content_type: data.content_type ?? null,
          byte_size: data.byte_size ?? null,
          scan_status: data.scan_status ?? 'pending_scan',
          scan_message: null,
          scanned_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        attachments.push(att);
        return att;
      }),
      findUnique: jest.fn(async ({ where, include }: any) => {
        const a = attachments.find((x) => x.id === where.id);
        if (!a) return null;
        const out: any = { ...a };
        if (include?.panel) out.panel = panels.find((p) => p.id === a.panel_id);
        return out;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const a = attachments.find((x) => x.id === where.id);
        if (!a) throw new Error('not found');
        Object.assign(a, data, { updated_at: new Date() });
        return a;
      }),
    },
  } as any;
}

const buildAudit = () => ({
  write: jest.fn(async () => {}),
}) as any;

const buildConsent = (granted: Set<string> = new Set()) => ({
  isGranted: jest.fn(async (clientId: string, coachId: string, scope: string) => {
    return granted.has(`${clientId}:${coachId}:${scope}`);
  }),
}) as any;

const baseCtx = (id: string, role = 'student') => ({
  actorId: id,
  actorRole: role,
  ip: null,
  userAgent: null,
});

describe('BloodworkService', () => {
  describe('createPanel', () => {
    it('requires HEALTH_BLOODWORK consent when client has a coach', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(); // no consents granted
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());
      await expect(
        svc.createPanel(
          'client-1',
          { collection_date: '2026-04-01', results: [] },
          baseCtx('client-1'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('creates a draft panel + results and emits audit when consent granted', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const audit = buildAudit();
      const consent = buildConsent(
        new Set([`client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`]),
      );
      const svc = new BloodworkService(prisma, audit, consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        {
          collection_date: '2026-04-01',
          panel_label: 'CBC',
          results: [
            {
              marker_name: 'hemoglobin',
              value_numeric: 14.2,
              unit: 'g/dL',
              reference_low: 13.0,
              reference_high: 17.0,
            },
            {
              marker_name: 'ldl_c',
              value_numeric: 200,
              unit: 'mg/dL',
              reference_low: 0,
              reference_high: 130,
            },
          ],
        },
        baseCtx('client-1'),
      );
      expect(panel.review_state).toBe(BloodworkReviewState.DRAFT);
      expect(panel.disclaimer_level).toBe('educational_only');
      expect(panel.coach_id).toBe('coach-1');
      expect(panel.ai_processing_allowed).toBe(false); // no AI scope granted
      expect(panel.results).toHaveLength(2);
      const ldl = panel.results.find((r: any) => r.marker_name === 'ldl_c') as any;
      expect(ldl?.out_of_range).toBe(true);
      const hgb = panel.results.find((r: any) => r.marker_name === 'hemoglobin') as any;
      expect(hgb?.out_of_range).toBe(false);
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0].action).toBe(
        BloodworkAuditAction.PANEL_CREATED,
      );
    });

    it('captures ai_processing_allowed only when AI scope is granted at create time', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(
        new Set([
          `client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`,
          `client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK_AI}`,
        ]),
      );
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        { collection_date: '2026-04-01', results: [] },
        baseCtx('client-1'),
      );
      expect(panel.ai_processing_allowed).toBe(true);
    });

    it('flags panel validation_status=errors when a result has no value', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(
        new Set([`client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`]),
      );
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        {
          collection_date: '2026-04-01',
          results: [
            { marker_name: 'glucose' }, // no value_numeric, no value_text
          ],
        },
        baseCtx('client-1'),
      );
      expect(panel.validation_status).toBe(BloodworkValidationStatus.ERRORS);
    });
  });

  describe('submit / state machine', () => {
    const consentSet = (clientId: string, coachId: string) =>
      new Set([
        `${clientId}:${coachId}:${ConsentScope.HEALTH_BLOODWORK}`,
      ]);

    async function seedSubmittedPanel() {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(consentSet('client-1', 'coach-1'));
      const audit = buildAudit();
      const svc = new BloodworkService(prisma, audit, consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        {
          collection_date: '2026-04-01',
          results: [
            {
              marker_name: 'hemoglobin',
              value_numeric: 14,
              unit: 'g/dL',
            },
          ],
        },
        baseCtx('client-1'),
      );
      await svc.submitPanel('client-1', panel.id, baseCtx('client-1'));
      return { svc, prisma, audit, consent, panel };
    }

    it('client cannot edit after submit', async () => {
      const { svc, panel } = await seedSubmittedPanel();
      await expect(
        svc.updateDraftPanel(
          'client-1',
          panel.id,
          { notes: 'late edit' },
          baseCtx('client-1'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('coach can review submitted panel and audit fires', async () => {
      const { svc, audit, panel } = await seedSubmittedPanel();
      const after = await svc.reviewPanel(
        panel.id,
        { review_state: BloodworkReviewState.REVIEWED, review_note: 'ok' },
        baseCtx('coach-1', 'coach'),
      );
      expect(after.review_state).toBe(BloodworkReviewState.REVIEWED);
      expect(after.reviewed_by_id).toBe('coach-1');
      expect(after.review_note).toBe('ok');
      const lastCall = audit.write.mock.calls.at(-1)[0];
      expect(lastCall.action).toBe(BloodworkAuditAction.PANEL_REVIEWED);
    });

    it('AI cannot mutate review state', async () => {
      const { svc, panel } = await seedSubmittedPanel();
      await expect(
        svc.reviewPanel(
          panel.id,
          { review_state: BloodworkReviewState.REVIEWED },
          baseCtx('ai-bot', 'ai'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('coach in another tenant cannot review (tenant boundary)', async () => {
      const { svc, panel } = await seedSubmittedPanel();
      await expect(
        svc.reviewPanel(
          panel.id,
          { review_state: BloodworkReviewState.REVIEWED },
          baseCtx('coach-other', 'coach'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects illegal state transitions', async () => {
      const { svc, panel } = await seedSubmittedPanel();
      // submitted -> draft is not allowed by COACH_TRANSITIONS
      await expect(
        svc.reviewPanel(
          panel.id,
          { review_state: BloodworkReviewState.DRAFT as any },
          baseCtx('coach-1', 'coach'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks coach approval when an attachment scan is not clean', async () => {
      const { svc, prisma, panel } = await seedSubmittedPanel();
      await svc.registerAttachment(
        panel.id,
        { storage_ref: 's3://bucket/key', storage_backend: 'stub' },
        baseCtx('client-1'),
      );
      await expect(
        svc.reviewPanel(
          panel.id,
          { review_state: BloodworkReviewState.REVIEWED },
          baseCtx('coach-1', 'coach'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Flip to clean, retry — should succeed.
      const att = prisma._attachments[0];
      att.scan_status = BloodworkScanStatus.CLEAN;
      const ok = await svc.reviewPanel(
        panel.id,
        { review_state: BloodworkReviewState.REVIEWED },
        baseCtx('coach-1', 'coach'),
      );
      expect(ok.review_state).toBe(BloodworkReviewState.REVIEWED);
    });
  });

  describe('listForCoach', () => {
    it('filters out clients who have not granted health consent', async () => {
      const prisma = buildPrisma([
        { id: 'client-a', coach_id: 'coach-1' },
        { id: 'client-b', coach_id: 'coach-1' },
      ]);
      const consent = buildConsent(
        new Set([
          `client-a:coach-1:${ConsentScope.HEALTH_BLOODWORK}`,
          `client-b:coach-1:${ConsentScope.HEALTH_BLOODWORK}`,
        ]),
      );
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());

      const a = await svc.createPanel(
        'client-a',
        { collection_date: '2026-04-01', results: [{ marker_name: 'x', value_numeric: 1 }] },
        baseCtx('client-a'),
      );
      await svc.submitPanel('client-a', a.id, baseCtx('client-a'));
      const b = await svc.createPanel(
        'client-b',
        { collection_date: '2026-04-01', results: [{ marker_name: 'x', value_numeric: 1 }] },
        baseCtx('client-b'),
      );
      await svc.submitPanel('client-b', b.id, baseCtx('client-b'));

      // Revoke client-b consent before coach reads.
      (consent.isGranted as jest.Mock).mockImplementation(
        async (clientId: string, _coachId: string, scope: string) =>
          clientId === 'client-a' && scope === ConsentScope.HEALTH_BLOODWORK,
      );
      const queue = await svc.listForCoach('coach-1', 'coach', {});
      expect(queue).toHaveLength(1);
      expect(queue[0].client_id).toBe('client-a');
    });
  });

  describe('markStalePanels', () => {
    it('marks old non-reviewed panels as stale and emits audit; reviewed panels do not regress', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(
        new Set([`client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`]),
      );
      const audit = buildAudit();
      const svc = new BloodworkService(prisma, audit, consent, new KmsService());

      // Old submitted panel.
      const old = await svc.createPanel(
        'client-1',
        { collection_date: '2024-01-01', results: [{ marker_name: 'x', value_numeric: 1 }] },
        baseCtx('client-1'),
      );
      await svc.submitPanel('client-1', old.id, baseCtx('client-1'));
      // Old reviewed panel — must NOT be marked stale.
      const oldReviewed = await svc.createPanel(
        'client-1',
        { collection_date: '2024-01-01', results: [{ marker_name: 'y', value_numeric: 2 }] },
        baseCtx('client-1'),
      );
      await svc.submitPanel('client-1', oldReviewed.id, baseCtx('client-1'));
      await svc.reviewPanel(
        oldReviewed.id,
        { review_state: BloodworkReviewState.REVIEWED },
        baseCtx('coach-1', 'coach'),
      );

      const out = await svc.markStalePanels(new Date('2026-04-01'), 365);
      expect(out.marked).toBe(1);

      const reloaded = prisma._panels.find((p: any) => p.id === old.id);
      const reviewedPanel = prisma._panels.find((p: any) => p.id === oldReviewed.id);
      expect(reloaded.is_stale).toBe(true);
      expect(reviewedPanel.is_stale).toBe(false);
      expect(
        audit.write.mock.calls.some(
          (c: any[]) => c[0].action === BloodworkAuditAction.PANEL_MARKED_STALE,
        ),
      ).toBe(true);
    });
  });

  describe('attachments', () => {
    it('client can register an attachment in pending_scan state', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(
        new Set([`client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`]),
      );
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        { collection_date: '2026-04-01', results: [] },
        baseCtx('client-1'),
      );
      const att = await svc.registerAttachment(
        panel.id,
        { storage_ref: 's3://b/k' },
        baseCtx('client-1'),
      );
      expect(att.scan_status).toBe(BloodworkScanStatus.PENDING);
    });

    it('non-owner cannot update scan status', async () => {
      const prisma = buildPrisma([{ id: 'client-1', coach_id: 'coach-1' }]);
      const consent = buildConsent(
        new Set([`client-1:coach-1:${ConsentScope.HEALTH_BLOODWORK}`]),
      );
      const svc = new BloodworkService(prisma, buildAudit(), consent, new KmsService());
      const panel = await svc.createPanel(
        'client-1',
        { collection_date: '2026-04-01', results: [] },
        baseCtx('client-1'),
      );
      const att = await svc.registerAttachment(
        panel.id,
        { storage_ref: 's3://b/k' },
        baseCtx('client-1'),
      );
      await expect(
        svc.updateAttachmentScan(
          att.id,
          { scan_status: BloodworkScanStatus.CLEAN },
          baseCtx('coach-1', 'coach'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
