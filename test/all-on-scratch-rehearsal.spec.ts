import 'reflect-metadata';
import { NotImplementedException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ENV_RULES } from '../src/common/env-validation';
import { ContractsModule } from '../src/contracts/contracts.module';
import { SIGNATURE_PROVIDER } from '../src/contracts/providers/signature-provider.interface';
import { NativeCanvasProvider } from '../src/contracts/providers/native-canvas.provider';
import { DocuSignProvider } from '../src/contracts/providers/docusign.provider';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';

describe('ALL-ON-SMOKE-BE scratch observations (never merge)', () => {
  it('starts every registered boolean FEATURE_ switch as true', () => {
    const lists = new Set([
      'FEATURE_COMMUNITY_API_ALLOWLIST',
      'FEATURE_SCOUT_PILOT_COACH_IDS',
    ]);
    const names = ENV_RULES.map(rule => rule.name)
      .filter(name => name.startsWith('FEATURE_') && !lists.has(name));
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(process.env[name]).toBe('true');
  });

  it('observes that literal all-on selects the native-canvas stub', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ContractsModule);
    const binding = providers.find(
      (provider: { provide?: unknown }) => provider.provide === SIGNATURE_PROVIDER,
    );
    const native = new NativeCanvasProvider();
    const selected = binding.useFactory({}, new DocuSignProvider(), native);
    expect(selected).toBe(native);
    expect(() => selected.refreshEmbedUrl('scratch-request'))
      .toThrow(NotImplementedException);
  });

  it('observes that the current manifest capability list still excludes message drafts and insights', () => {
    const saved = process.env.AI_GATEWAY_CAPABILITIES;
    try {
      process.env.AI_GATEWAY_CAPABILITIES =
        'draft.create_workout_plan,draft.edit_workout_plan';
      const config = new AiGatewayConfig();
      for (const capability of [
        'draft.coach_message',
        'wearable_insight.client',
        'wearable_insight.coach',
        'community_ai_triage',
      ]) {
        expect(config.resolve(capability).capabilityAllowed).toBe(false);
      }
    } finally {
      if (saved === undefined) delete process.env.AI_GATEWAY_CAPABILITIES;
      else process.env.AI_GATEWAY_CAPABILITIES = saved;
    }
  });
});
