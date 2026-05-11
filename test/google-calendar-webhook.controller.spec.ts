// test/google-calendar-webhook.controller.spec.ts
//
// Coverage for GoogleCalendarWebhookController.
//
// All tests use a plain object stand-in for the Express request. No
// real network, no Nest test module spin-up — the controller has no
// DI surface beyond AuditService, which is mocked.
//
// Cases:
//   1. Sync handshake: state='sync' returns ok and writes a sync audit.
//   2. Update event: state='exists' returns ok and writes one audit row.
//   3. Malformed headers (missing channel-id) returns 400.
//   4. Channel-token mismatch returns 400 when token is configured.
//   5. Channel-token check skipped when env var is unset.

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GoogleCalendarWebhookController } from '../src/scheduling/google-calendar/google-calendar-webhook.controller';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function buildAudit() {
  return { write: jest.fn(async () => undefined) };
}

function makeReq(headers: Record<string, string>) {
  return { headers } as unknown as Parameters<
    GoogleCalendarWebhookController['receive']
  >[0];
}

describe('GoogleCalendarWebhookController.receive', () => {
  it('sync handshake returns ok and writes a sync audit row', async () => {
    delete process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN;
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'sync',
      'x-goog-message-number': '1',
    });
    const out = await ctrl.receive(req);
    expect(out.ok).toBe(true);
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect((audit.write.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      action: 'calendar.watch_started',
      metadata: expect.objectContaining({ phase: 'sync_handshake' }),
    });
  });

  it('non-sync state writes the event_updated audit row', async () => {
    delete process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN;
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      'x-goog-message-number': '42',
    });
    const out = await ctrl.receive(req);
    expect(out.ok).toBe(true);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar.event_updated' }),
    );
  });

  it('rejects malformed requests missing X-Goog-Channel-Id with 400', async () => {
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
    });
    await expect(ctrl.receive(req)).rejects.toThrow(BadRequestException);
  });

  it('rejects channel-token mismatch when GOOGLE_CALENDAR_WEBHOOK_TOKEN is configured', async () => {
    process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN = 'expected-token';
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'wrong-token',
    });
    let thrown: unknown = null;
    try {
      await ctrl.receive(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as { code: string };
    expect(body.code).toBe('GOOGLE_CALENDAR_WEBHOOK_TOKEN_MISMATCH');
  });

  it('skips the channel-token check when GOOGLE_CALENDAR_WEBHOOK_TOKEN is unset', async () => {
    delete process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN;
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      // no token
    });
    const out = await ctrl.receive(req);
    expect(out.ok).toBe(true);
  });
});
