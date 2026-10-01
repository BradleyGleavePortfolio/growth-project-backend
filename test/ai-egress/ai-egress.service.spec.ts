/**
 * R2b — AiEgressService, the single AI egress gate (D2 box 2).
 *
 * Proves, with the real gate over a fake ledger reader:
 *   - grant -> the provider is called; no grant / revoked / ledger error /
 *     ledger flag off (reader answers false) -> refused, provider NOT called;
 *   - revocation is effective on the very next send (no caching);
 *   - a multi-client subject needs every client;
 *   - client data is never sent to Perplexity (policy refusal, 503);
 *   - the refusal carries the stable code + calm, specific message.
 */
import { HttpStatus } from '@nestjs/common';
import {
  AI_CONSENT_REQUIRED_CLIENT_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_COACH_MESSAGE,
  AI_EGRESS_POLICY_CODE,
  AiConsentRequiredException,
  AiEgressPolicyException,
  isAiEgressRefusal,
} from '../../src/ai-egress/ai-consent-required.exception';
import {
  AiDataSubject,
  clientDataSubject,
  noClientDataSubject,
} from '../../src/ai-egress/ai-egress.types';
import type {
  AnthropicMessagesClient,
  PerplexityChatClient,
} from '../../src/ai-egress/ai-egress.service';
import { egressWithGrants } from './ai-egress.fakes';

function fakeAnthropic() {
  const create = jest.fn();
  create.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const stream = jest.fn();
  stream.mockReturnValue({ kind: 'stream' });
  const client: AnthropicMessagesClient = { messages: { create, stream } };
  return { client, create, stream };
}

function fakePerplexity() {
  const create = jest.fn();
  create.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
  const client: PerplexityChatClient = { chat: { completions: { create } } };
  return { client, create };
}

const PARAMS = {
  model: 'claude-sonnet-4-6',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('AiEgressService.assertMaySend / anthropicMessagesCreate', () => {
  it('grant: the provider is called once with the exact params', async () => {
    const { egress } = egressWithGrants(['client-a']);
    const { client, create } = fakeAnthropic();
    await egress.anthropicMessagesCreate(
      client,
      clientDataSubject('client-a', 'coach'),
      'coach.churn_draft',
      PARAMS,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(PARAMS, undefined);
  });

  it('no grant: refused with ai_consent_required, provider never called', async () => {
    const { egress } = egressWithGrants([]);
    const { client, create } = fakeAnthropic();
    const err = await refusal(
      egress.anthropicMessagesCreate(
        client,
        clientDataSubject('client-a', 'coach'),
        'coach.churn_draft',
        PARAMS,
      ),
    );
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect(create).not.toHaveBeenCalled();
  });

  it('revoked: allowed, then the very next send is refused (no caching)', async () => {
    const { egress, reader } = egressWithGrants(['client-a']);
    const { client, create } = fakeAnthropic();
    const subject = clientDataSubject('client-a', 'client');
    await egress.anthropicMessagesCreate(client, subject, 'roman.chat', PARAMS);
    reader.revoke('client-a');
    const err = await refusal(
      egress.anthropicMessagesCreate(client, subject, 'roman.chat', PARAMS),
    );
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect(create).toHaveBeenCalledTimes(1);
    // Read the ledger on every send.
    expect(reader.calls).toHaveLength(2);
  });

  it('ledger error (reader throws): fails closed, provider never called', async () => {
    const { egress, reader } = egressWithGrants(['client-a']);
    reader.failWith = new Error('db down');
    const { client, create } = fakeAnthropic();
    const err = await refusal(
      egress.anthropicMessagesCreate(
        client,
        clientDataSubject('client-a', 'coach'),
        'coach.brief',
        PARAMS,
      ),
    );
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect(create).not.toHaveBeenCalled();
  });

  it('ledger read failure / flag off (reader answers false): fails closed', async () => {
    const { egress, reader } = egressWithGrants(['client-a']);
    reader.readFails = true;
    const { client, create } = fakeAnthropic();
    await expect(
      egress.anthropicMessagesCreate(
        client,
        clientDataSubject('client-a', 'coach'),
        'coach.brief',
        PARAMS,
      ),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(create).not.toHaveBeenCalled();
  });

  it('multi-client subject: every client needs a grant', async () => {
    const { egress } = egressWithGrants(['a', 'b']);
    const { client, create } = fakeAnthropic();
    await egress.anthropicMessagesCreate(
      client,
      clientDataSubject(['a', 'b'], 'coach'),
      'gateway',
      PARAMS,
    );
    await expect(
      egress.anthropicMessagesCreate(
        client,
        clientDataSubject(['a', 'b', 'c'], 'coach'),
        'gateway',
        PARAMS,
      ),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('client subject with no ids is a policy defect (503), not a pass', async () => {
    const { egress } = egressWithGrants(['a']);
    const { client, create } = fakeAnthropic();
    const bad: AiDataSubject = { kind: 'client_data', clientIds: [], audience: 'coach' };
    const err = await refusal(egress.anthropicMessagesCreate(client, bad, 'gateway', PARAMS));
    expect(err).toBeInstanceOf(AiEgressPolicyException);
    expect(create).not.toHaveBeenCalled();
  });

  it('unknown no-client-data reason is a policy defect (503)', async () => {
    const { egress } = egressWithGrants([]);
    const { client, create } = fakeAnthropic();
    // Built from JSON: a reason outside NO_CLIENT_DATA_REASONS cannot be typed.
    const bad: AiDataSubject = JSON.parse('{"kind":"no_client_data","reason":"because"}');
    await expect(
      egress.anthropicMessagesCreate(client, bad, 'gateway', PARAMS),
    ).rejects.toBeInstanceOf(AiEgressPolicyException);
    expect(create).not.toHaveBeenCalled();
  });

  it('declared no-client-data subjects proceed without reading the ledger', async () => {
    const { egress, reader } = egressWithGrants([]);
    const { client, create } = fakeAnthropic();
    await egress.anthropicMessagesCreate(
      client,
      noClientDataSubject('health_probe'),
      'coach_ai.health_probe',
      PARAMS,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(reader.calls).toHaveLength(0);
  });

  it('stream: refused before the stream is opened; allowed with a grant', async () => {
    const { egress, reader } = egressWithGrants(['s1']);
    const { client, stream } = fakeAnthropic();
    await egress.anthropicMessagesStream(
      client,
      clientDataSubject('s1', 'client'),
      'roman.chat',
      PARAMS,
    );
    expect(stream).toHaveBeenCalledTimes(1);
    reader.revoke('s1');
    await expect(
      egress.anthropicMessagesStream(
        client,
        clientDataSubject('s1', 'client'),
        'roman.chat',
        PARAMS,
      ),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('AiEgressService.perplexityChatCreate', () => {
  it('never sends client data to Perplexity, even with a grant (503 ai_egress_blocked)', async () => {
    const { egress } = egressWithGrants(['client-a']);
    const { client, create } = fakePerplexity();
    const err = await refusal(
      egress.perplexityChatCreate(client, clientDataSubject('client-a', 'client'), 'first_win', {
        model: 'sonar-pro',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(err).toBeInstanceOf(AiEgressPolicyException);
    expect((err as AiEgressPolicyException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as AiEgressPolicyException).getResponse()).toMatchObject({
      code: AI_EGRESS_POLICY_CODE,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('fixed templates proceed', async () => {
    const { egress } = egressWithGrants([]);
    const { client, create } = fakePerplexity();
    await egress.perplexityChatCreate(client, noClientDataSubject('fixed_template'), 'first_win', {
      model: 'sonar-pro',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('AiEgressService.consentedClients', () => {
  it('returns only granted ids, de-duplicated, empty input -> empty set without a read', async () => {
    const { egress, reader } = egressWithGrants(['a', 'c']);
    expect([...(await egress.consentedClients(['a', 'b', 'c', 'a']))].sort()).toEqual(['a', 'c']);
    expect((await egress.consentedClients([])).size).toBe(0);
    expect(reader.calls).toHaveLength(1);
  });

  it('chunks above the reader batch cap (200) instead of failing', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const { egress, reader } = egressWithGrants(ids.filter((_, i) => i % 2 === 0));
    const out = await egress.consentedClients(ids);
    expect(out.size).toBe(225);
    expect(reader.calls.map((c) => c.length)).toEqual([200, 200, 50]);
  });

  it('ledger error -> empty set (fail closed)', async () => {
    const { egress, reader } = egressWithGrants(['a', 'b']);
    reader.failWith = new Error('db down');
    expect((await egress.consentedClients(['a', 'b'])).size).toBe(0);
  });
});

describe('refusal wire contract (owner rule 13:34)', () => {
  it('coach audience: 403, stable code, specific calm message', () => {
    const e = new AiConsentRequiredException('coach');
    expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(e.getResponse()).toEqual({
      code: AI_CONSENT_REQUIRED_CODE,
      message: AI_CONSENT_REQUIRED_COACH_MESSAGE,
    });
    expect(AI_CONSENT_REQUIRED_CODE).toBe('ai_consent_required');
    expect(AI_CONSENT_REQUIRED_COACH_MESSAGE).toBe(
      "This client hasn't allowed AI help yet. They can turn it on in their app under Settings > Privacy.",
    );
  });

  it('client audience: points the client to their own setting', () => {
    expect(new AiConsentRequiredException('client').getResponse()).toEqual({
      code: AI_CONSENT_REQUIRED_CODE,
      message: AI_CONSENT_REQUIRED_CLIENT_MESSAGE,
    });
    expect(AI_CONSENT_REQUIRED_CLIENT_MESSAGE).toBe(
      "You haven't allowed AI help yet. You can turn it on in Settings > Privacy.",
    );
  });

  it('copy rules: no exclamation marks, no emoji, names no client', () => {
    for (const m of [AI_CONSENT_REQUIRED_COACH_MESSAGE, AI_CONSENT_REQUIRED_CLIENT_MESSAGE]) {
      expect(m).not.toMatch(/!/);
      expect(m).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('isAiEgressRefusal recognises both refusals and nothing else', () => {
    expect(isAiEgressRefusal(new AiConsentRequiredException('coach'))).toBe(true);
    expect(isAiEgressRefusal(new AiEgressPolicyException())).toBe(true);
    expect(isAiEgressRefusal(new Error('x'))).toBe(false);
  });
});
