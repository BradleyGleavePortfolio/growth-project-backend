/**
 * R49 CoachDomainsController dispatch tests.
 *
 * Auth gating (the @Roles decorator) is exercised end-to-end in
 * test/roles-enforced.spec.ts, so this spec only verifies that the
 * controller dispatches with the right (coachId, pageId, ...) args
 * and that body validation happens before service is called.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CoachDomainsController } from '../src/landing-pages/domains/domains.controller';

function makeSvc() {
  return {
    create: jest.fn().mockResolvedValue({
      summary: { id: 'd1', domain: 'coaching.example.com' },
      instructions: { dns_records: [] },
    }),
    listForPage: jest.fn().mockResolvedValue([]),
    getInstructions: jest.fn().mockResolvedValue({ domain: 'coaching.example.com', status: 'pending', dns_records: [] }),
    verifyNow: jest.fn().mockResolvedValue({ id: 'd1', verification_status: 'verified' }),
    revoke: jest.fn().mockResolvedValue({ ok: true, flyTeardownPending: false }),
  };
}

const req = { user: { id: 'coach-1', role: 'coach' } } as any;

describe('CoachDomainsController', () => {
  let svc: ReturnType<typeof makeSvc>;
  let ctrl: CoachDomainsController;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new CoachDomainsController(svc as any);
  });

  it('create dispatches with coach + page + domain', async () => {
    await ctrl.create(req, 'page-1', { domain: 'coaching.example.com' });
    expect(svc.create).toHaveBeenCalledWith('coach-1', 'page-1', 'coaching.example.com');
  });

  it('create rejects non-object body', async () => {
    await expect(ctrl.create(req, 'page-1', null as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('list dispatches with coach + page', async () => {
    await ctrl.list(req, 'page-1');
    expect(svc.listForPage).toHaveBeenCalledWith('coach-1', 'page-1');
  });

  it('instructions dispatches with all three ids', async () => {
    await ctrl.instructions(req, 'page-1', 'dom-1');
    expect(svc.getInstructions).toHaveBeenCalledWith('coach-1', 'page-1', 'dom-1');
  });

  it('verify dispatches', async () => {
    await ctrl.verify(req, 'page-1', 'dom-1');
    expect(svc.verifyNow).toHaveBeenCalledWith('coach-1', 'page-1', 'dom-1');
  });

  it('revoke dispatches', async () => {
    await ctrl.revoke(req, 'page-1', 'dom-1');
    expect(svc.revoke).toHaveBeenCalledWith('coach-1', 'page-1', 'dom-1');
  });

  it('propagates 404 from service', async () => {
    svc.verifyNow.mockRejectedValueOnce(new NotFoundException({ error: 'DOMAIN_NOT_FOUND' }));
    await expect(ctrl.verify(req, 'page-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
