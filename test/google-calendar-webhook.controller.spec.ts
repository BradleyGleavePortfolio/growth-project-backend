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
//   3. Malformed headers (missing channel-id) → 400 with structured { code, message }.
//   4. Channel-token mismatch → 403 with structured { code, message }.
//   5. Absent token with feature on → 403 with structured { code, message }.
//   6. Feature off → 404 with structured { code, message } (RFC-142 contract).

import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GoogleCalendarWebhookController } from '../src/scheduling/google-calendar/google-calendar-webhook.controller';

const ORIGINAL_ENV = { ...process.env };

// Phase 2 master switch — webhook handler 404s when flag is off.
// Tests below assert the inner validation behaviour, so flag is
// on for every test. Flag-off has its own dedicated test.
beforeEach(() => {
  process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'true';
  // Security hardening: when the feature is enabled a webhook token MUST
  // be present or the controller rejects all requests fail-closed.
  process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN = 'test-token';
});

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

async function captureThrown<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return null;
}

describe('GoogleCalendarWebhookController.receive', () => {
  it('sync handshake returns ok and writes a sync audit row', async () => {
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'sync',
      'x-goog-message-number': '1',
      'x-goog-channel-token': 'test-token',
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
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      'x-goog-message-number': '42',
      'x-goog-channel-token': 'test-token',
    });
    const out = await ctrl.receive(req);
    expect(out.ok).toBe(true);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar.event_updated' }),
    );
  });

  it('rejects malformed requests missing X-Goog-Channel-Id with structured 400', async () => {
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'test-token',
    });
    const thrown = await captureThrown(ctrl.receive(req));
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: 'GOOGLE_CALENDAR_WEBHOOK_MALFORMED',
      message: expect.stringContaining('X-Goog-Channel-Id'),
    });
  });

  it('rejects channel-token mismatch with structured 403', async () => {
    // beforeEach already set GOOGLE_CALENDAR_WEBHOOK_TOKEN='test-token'.
    // Send a different token so the mismatch guard fires.
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'wrong-token',
    });
    const thrown = await captureThrown(ctrl.receive(req));
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({
      code: 'GOOGLE_CALENDAR_WEBHOOK_TOKEN_MISMATCH',
      message: expect.stringContaining('webhook token'),
    });
  });

  it('rejects with structured 403 when GOOGLE_CALENDAR_WEBHOOK_TOKEN is unset and feature is on', async () => {
    delete process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN;
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
      // no token in headers
    });
    const thrown = await captureThrown(ctrl.receive(req));
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({
      code: 'WEBHOOK_TOKEN_NOT_CONFIGURED',
      message: expect.stringContaining('webhook token'),
    });
  });

  // RFC-142 contract: when FEATURE_GOOGLE_CALENDAR_SYNC is off, the endpoint
  // must respond 404 with a structured body — "feature truly not available,
  // not 'configured but broken'". Returning {ok:true} silently hid
  // misconfigurations; 404 forces operational visibility.
  it('throws structured 404 when FEATURE_GOOGLE_CALENDAR_SYNC is off', async () => {
    delete process.env.FEATURE_GOOGLE_CALENDAR_SYNC;
    const audit = buildAudit();
    const ctrl = new GoogleCalendarWebhookController(audit as never);
    const req = makeReq({
      'x-goog-channel-id': 'ch-1',
      'x-goog-resource-id': 'res-1',
      'x-goog-resource-state': 'exists',
    });
    const thrown = await captureThrown(ctrl.receive(req));
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getResponse()).toMatchObject({
      code: 'FEATURE_DISABLED',
      message: expect.stringContaining('Google Calendar integration'),
    });
  });
});
