/**
 * W3-08 (agent 123): an expected "feature off" answer is not a Sentry error.
 *
 * While FEATURE_COACH_BROADCASTS is unset the mobile app probes broadcasts on
 * every coach Messages visit and gets 503 broadcasts.disabled (C-388-1). The
 * global filter forwarded every 503 to Sentry, so each visit made one event.
 * Kill-switch 503s are now skipped; every other 5xx is still reported. The
 * 404 kill switches (coachless_disabled, coach_code_tools_disabled) never
 * reached Sentry and still do not.
 */
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  withScope: (fn: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
    fn({ setTag: jest.fn(), setExtra: jest.fn() }),
}));

import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FEATURE_OFF_503_CODES,
  HttpExceptionFilter,
  isFeatureOffResponse,
} from '../src/filters/http-exception.filter';
import { CoachBroadcastsEnabledGuard } from '../src/broadcasts/broadcasts.feature';
import { MessagingCoreV2Guard } from '../src/messaging/messaging-core.feature';
import { COMMUNITY_DISABLED_BODY } from '../src/community/dto/disabled-response.dto';
import { CoachlessFeatureGuard } from '../src/coachless/coachless-feature.guard';
import { assertCoachCodeToolsEnabled } from '../src/invite-codes/coach-code-tools.feature';

function buildHost(): { host: ArgumentsHost; status: jest.Mock; json: jest.Mock } {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const response = { status, json };
  const request = { url: '/coach/broadcasts', method: 'GET', route: { path: '/coach/broadcasts' } };
  const host: ArgumentsHost = new ExecutionContextHost([request, response]);
  return { host, status, json };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

function run(exception: unknown): { status: jest.Mock; json: jest.Mock } {
  const { host, status, json } = buildHost();
  new HttpExceptionFilter().catch(exception, host);
  return { status, json };
}

describe('HttpExceptionFilter: feature-off answers stay out of Sentry (W3-08)', () => {
  const saved = {
    broadcasts: process.env.FEATURE_COACH_BROADCASTS,
    messaging: process.env.FEATURE_MESSAGING_CORE_V2,
    coachless: process.env.FEATURE_COACHLESS_HOME,
    codes: process.env.FEATURE_COACH_CODE_TOOLS,
  };

  beforeEach(() => {
    mockCaptureException.mockReset();
    delete process.env.FEATURE_COACH_BROADCASTS;
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    delete process.env.FEATURE_COACHLESS_HOME;
    delete process.env.FEATURE_COACH_CODE_TOOLS;
  });

  afterAll(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('FEATURE_COACH_BROADCASTS', saved.broadcasts);
    restore('FEATURE_MESSAGING_CORE_V2', saved.messaging);
    restore('FEATURE_COACHLESS_HOME', saved.coachless);
    restore('FEATURE_COACH_CODE_TOOLS', saved.codes);
  });

  it('broadcasts off: the coach Messages probe answers 503 broadcasts.disabled and sends nothing to Sentry', () => {
    const err = thrown(() => new CoachBroadcastsEnabledGuard().canActivate(new ExecutionContextHost([])));
    const { status, json } = run(err);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json.mock.calls[0][0]).toMatchObject({ statusCode: 503, code: 'broadcasts.disabled' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('messaging v2 off: 503 messaging.feature_disabled sends nothing to Sentry', () => {
    const err = thrown(() => new MessagingCoreV2Guard().canActivate());
    const { json } = run(err);
    expect(json.mock.calls[0][0]).toMatchObject({ statusCode: 503, code: 'messaging.feature_disabled' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('community kill switch: 503 community.disabled sends nothing to Sentry', () => {
    const { json } = run(new HttpException(COMMUNITY_DISABLED_BODY, HttpStatus.SERVICE_UNAVAILABLE));
    expect(json.mock.calls[0][0]).toMatchObject({ statusCode: 503, error: 'community.disabled' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('coachless off (404 coachless_disabled) and code tools off (404 coach_code_tools_disabled) send nothing to Sentry', () => {
    run(thrown(() => new CoachlessFeatureGuard().canActivate()));
    run(thrown(() => assertCoachCodeToolsEnabled()));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a real 503 (no kill-switch code) is still reported', () => {
    run(new ServiceUnavailableException({ code: 'DATA_EXPORT_STORAGE_UNAVAILABLE', message: 'Storage is unavailable.' }));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('an unknown exception (500) is still reported', () => {
    const { host } = buildHost();
    const filter = new HttpExceptionFilter();
    const logger = jest.spyOn(Reflect.get(filter, 'logger'), 'error').mockImplementation(() => undefined);
    filter.catch(new Error('boom'), host);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    logger.mockRestore();
  });

  it('a kill-switch code on a status other than 503 is still reported', () => {
    run(new HttpException({ code: 'broadcasts.disabled', message: 'x' }, HttpStatus.INTERNAL_SERVER_ERROR));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('the skip list is closed and exact', () => {
    expect([...FEATURE_OFF_503_CODES].sort()).toEqual([
      'broadcasts.disabled',
      'community.disabled',
      'messaging.feature_disabled',
    ]);
    expect(isFeatureOffResponse(503, { code: 'broadcasts.disabled.extra' })).toBe(false);
    expect(isFeatureOffResponse(503, 'broadcasts.disabled')).toBe(false);
    expect(isFeatureOffResponse(503, null)).toBe(false);
    expect(isFeatureOffResponse(503, { error: 'community.disabled' })).toBe(true);
  });
});
