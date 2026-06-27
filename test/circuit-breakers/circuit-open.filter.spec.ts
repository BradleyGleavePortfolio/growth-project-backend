/**
 * H6 — CircuitOpenFilter specs (D-H6-2 LOCKED).
 *
 * Verifies the Nest exception filter maps CircuitOpenError -> 503 Service
 * Unavailable with a Retry-After hint and a structured body that names the
 * failing upstream client (NO FAKE SUCCESS: the outage surfaces as 503, not a
 * fabricated 200). Standard Nest exception-filter test pattern: a stub
 * ArgumentsHost yielding mocked Express request/response objects.
 */
import { HttpStatus, ArgumentsHost } from '@nestjs/common';
import { CircuitOpenFilter } from '../../src/circuit-breakers/circuit-open.filter';
import { CircuitOpenError } from '../../src/circuit-breakers/circuit-breaker.factory';

function makeHost(method = 'POST', url = '/v1/payments') {
  const json = jest.fn();
  const setHeader = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ setHeader, json });
  // setHeader returns `this` (the response) so .json chains after it.
  const response = { status, setHeader, json };
  setHeader.mockReturnValue(response);
  status.mockReturnValue(response);
  const request = { method, url };
  // Typed stub: only switchToHttp() is exercised by the filter, so we expose a
  // typed partial and surface it as ArgumentsHost via a single direct cast
  // (no double-cast through an intermediate — R75 banned-cast hygiene).
  const hostStub: Pick<ArgumentsHost, 'switchToHttp'> = {
    switchToHttp: () =>
      ({
        getResponse: () => response,
        getRequest: () => request,
      }) as ReturnType<ArgumentsHost['switchToHttp']>,
  };
  const host = hostStub as ArgumentsHost;
  return { host, status, setHeader, json, response };
}

describe('CircuitOpenFilter (D-H6-2)', () => {
  it('maps CircuitOpenError to HTTP 503 Service Unavailable', () => {
    const filter = new CircuitOpenFilter();
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    const { host, status } = makeHost();

    filter.catch(new CircuitOpenError('stripe'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('sets a Retry-After: 30 header (the LOCKED 30s reset window)', () => {
    const filter = new CircuitOpenFilter();
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    const { host, setHeader } = makeHost();

    filter.catch(new CircuitOpenError('mux'), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('returns a structured body naming the failing client and a circuit_open code', () => {
    const filter = new CircuitOpenFilter();
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    const { host, json } = makeHost('POST', '/v1/email');

    filter.catch(new CircuitOpenError('sendgrid'), host);

    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.error).toBe('Service Unavailable');
    expect(body.code).toBe('circuit_open');
    expect(body.client).toBe('sendgrid');
    expect(body.path).toBe('/v1/email');
    expect(typeof body.timestamp).toBe('string');
    // NO FAKE SUCCESS: the body must not pretend the call succeeded.
    expect(body.statusCode).not.toBe(HttpStatus.OK);
  });

  it('logs a warning attributing the outage to the client', () => {
    const filter = new CircuitOpenFilter();
    const warn = jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    const { host } = makeHost('GET', '/v1/video/uploads');

    filter.catch(new CircuitOpenError('mux'), host);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('mux');
  });
});
