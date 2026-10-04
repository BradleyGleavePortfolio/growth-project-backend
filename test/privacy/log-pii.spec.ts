/**
 * B-700-1, C-700-2, C-700-3 (agent 118, B-PRIVFU2-118; C-611-17, agent 117):
 * a failure is described by server-owned parts only. No provider body, no
 * exception message, no field text survives `describeFailure`, whatever it
 * holds (an address, a display name, a message body).
 */
import { Prisma } from '@prisma/client';
import {
  ProviderFailure,
  describeFailure,
  providerErrorCode,
} from '../../src/observability/log-pii';

const ADDRESS = 'pat.client+tgp@example.com';
const PERSON = 'Patricia Quill';
const PRIVATE_TEXT = 'private consultation details';

function expectNoText(out: string): void {
  expect(out).not.toContain('@');
  expect(out).not.toContain('pat.client');
  expect(out).not.toContain('Patricia');
  expect(out).not.toContain('Quill');
  expect(out).not.toContain('private');
}

describe('B-700-1: describeFailure keeps the class, status and a known code only', () => {
  it('a plain Error: the class, never the message', () => {
    const out = describeFailure(new Error(`Cannot render greeting for ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}`));
    expect(out).toBe('error=Error');
  });

  it('a TypeError from fetch: the network code from its cause', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: ADDRESS },
    });
    expect(describeFailure(err)).toBe('error=TypeError code=ECONNRESET');
  });

  it('a Supabase Auth error that echoes the address: status and Supabase code', () => {
    const supabaseShape = {
      message: `Email address "${ADDRESS}" is invalid`,
      code: 'email_address_invalid',
      status: 400,
    };
    const out = describeFailure(supabaseShape);
    expect(out).toBe('error=Object status=400 code=email_address_invalid');
    expectNoText(out);
  });

  it('a Prisma known request error: the P code', () => {
    const err = new Prisma.PrismaClientKnownRequestError(`Unique constraint failed: ${ADDRESS}`, {
      code: 'P2002',
      clientVersion: 'test',
    });
    const out = describeFailure(err);
    expect(out).toBe('error=PrismaClientKnownRequestError code=P2002');
  });

  it('a jose claim failure: the jose code and the claim name', () => {
    class JWTClaimValidationFailed extends Error {
      code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
      claim = 'aud';
    }
    expect(describeFailure(new JWTClaimValidationFailed(`unexpected "aud" ${ADDRESS}`))).toBe(
      'error=JWTClaimValidationFailed code=ERR_JWT_CLAIM_VALIDATION_FAILED claim=aud',
    );
  });

  it('a code outside every list is "other", even when it is shaped like a code', () => {
    const out = describeFailure({ code: 'patricia_quill', status: 422, message: PERSON });
    expect(out).toBe('error=Object status=422 code=other');
    expect(describeFailure({ code: 'MY_MODULE_CODE' }, new Set(['MY_MODULE_CODE']))).toBe(
      'error=Object code=MY_MODULE_CODE',
    );
    expect(describeFailure({ claim: PERSON, status: 9999 })).toBe('error=Object');
  });

  it('never throws, and describes values that are not errors', () => {
    expect(describeFailure(undefined)).toBe('error=none');
    expect(describeFailure(null)).toBe('error=none');
    expect(describeFailure(`${PERSON} ${ADDRESS}`)).toBe('error=non_error');
    expect(describeFailure(42)).toBe('error=non_error');
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(describeFailure(hostile)).toBe('error=other');
  });
});

describe('B-700-1 / C-700-3: provider failures carry the provider, status and code, never the body', () => {
  it.each([
    ['resend', JSON.stringify({ name: 'validation_error', message: `Invalid recipient ${PERSON} <${ADDRESS}>` }), 'validation_error'],
    ['resend', JSON.stringify({ name: 'Patricia-Quill', message: PRIVATE_TEXT }), 'other'],
    ['resend', JSON.stringify({ message: `Invalid recipient ${PERSON} <${ADDRESS}>; ${PRIVATE_TEXT}` }), 'other'],
    ['resend', `${' '.repeat(488)}${ADDRESS}`, 'unparsed'],
    ['resend', '', 'empty'],
    ['postmark', JSON.stringify({ ErrorCode: 300, Message: `Invalid 'To' address: '${ADDRESS}'.` }), 'postmark_300'],
    ['postmark', JSON.stringify({ ErrorCode: PERSON, Message: PERSON }), 'other'],
    ['sendgrid', JSON.stringify({ errors: [{ message: `${PERSON} ${ADDRESS}`, field: 'personalizations' }] }), 'other'],
  ] as const)('%s body %#: code %s', (provider, body, code) => {
    expect(providerErrorCode(provider, body)).toBe(code);
    const failure = new ProviderFailure(provider, 422, providerErrorCode(provider, body));
    expect(failure.message).toBe(`provider=${provider} status=422 code=${code}`);
    expect(describeFailure(failure)).toBe(failure.message);
    expectNoText(failure.message);
  });

  it('a code or status that is not server-owned is replaced', () => {
    expect(new ProviderFailure('resend', 422, PERSON).message).toBe('provider=resend status=422 code=other');
    expect(new ProviderFailure('resend', 4220, 'validation_error').message).toBe(
      'provider=resend status=none code=validation_error',
    );
  });
});
