/**
 * R47 CRM controller tests.
 *
 * Validates the HTTP surface: provider-name guarding, dispatch to
 * service, and shape of the response.  Auth gating is enforced by
 * @Roles + global guards — covered by roles-enforced.spec.ts so we do
 * not duplicate it here.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CrmController } from '../src/landing-pages/crm/crm.controller';

function makeSvcStub() {
  return {
    upsert: jest.fn().mockResolvedValue({
      id: 'i1',
      provider: 'hubspot',
      enabled: true,
      last_synced_at: null,
      last_error: null,
      created_at: new Date(),
    }),
    list: jest.fn().mockResolvedValue([]),
    remove: jest.fn().mockResolvedValue(undefined),
    testPush: jest.fn().mockResolvedValue({ ok: true, external_id: 'ext-1' }),
  };
}

const req = { user: { id: 'coach-1', role: 'coach' } } as any;

describe('CrmController', () => {
  let svc: ReturnType<typeof makeSvcStub>;
  let ctrl: CrmController;

  beforeEach(() => {
    svc = makeSvcStub();
    ctrl = new CrmController(svc as any);
  });

  it('upsert rejects unknown provider with BadRequest', async () => {
    await expect(
      ctrl.upsert(req, { provider: 'evil-crm', config: { x: 'y' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.upsert).not.toHaveBeenCalled();
  });

  it('upsert dispatches to service for valid provider', async () => {
    await ctrl.upsert(req, { provider: 'hubspot', config: { access_token: 'tok' } });
    expect(svc.upsert).toHaveBeenCalledWith('coach-1', 'hubspot', { access_token: 'tok' });
  });

  it('list returns service output', async () => {
    svc.list.mockResolvedValueOnce([
      { id: 'i1', provider: 'webhook', enabled: true, last_synced_at: null, last_error: null, created_at: new Date() },
    ]);
    const out = await ctrl.list(req);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe('webhook');
    // Response shape must not include credentials.
    expect(JSON.stringify(out)).not.toContain('credentials');
  });

  it('remove rejects bad provider name', async () => {
    await expect(ctrl.remove(req, 'bad-name')).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it('remove propagates 404 from service', async () => {
    svc.remove.mockRejectedValueOnce(new NotFoundException({ error: 'INTEGRATION_NOT_FOUND' }));
    await expect(ctrl.remove(req, 'hubspot')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('test endpoint dispatches to service with normalized provider', async () => {
    const out = await ctrl.test(req, 'mailchimp');
    expect(out.ok).toBe(true);
    expect(svc.testPush).toHaveBeenCalledWith('coach-1', 'mailchimp');
  });

  it('upsert rejects non-object body', async () => {
    await expect(ctrl.upsert(req, null as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
