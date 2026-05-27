/**
 * Adapter registry — single lookup point for the lead-sync worker.
 *
 * Constructing all adapters at module-init time keeps the worker hot path
 * branch-free: each loop iteration is just `registry.getAdapter(provider)`.
 * Adapters are stateless and side-effect-free at construction, so this
 * has no startup cost.
 */

import { Injectable } from '@nestjs/common';
import type { CrmProvider } from '@prisma/client';
import { CrmAdapter } from './crm-adapter.interface';
import { HubSpotAdapter } from './hubspot.adapter';
import { GoHighLevelAdapter } from './gohighlevel.adapter';
import { MailchimpAdapter } from './mailchimp.adapter';
import { ActiveCampaignAdapter } from './activecampaign.adapter';
import { WebhookAdapter } from './webhook.adapter';

@Injectable()
export class CrmRegistryService {
  private readonly adapters: Map<CrmProvider, CrmAdapter>;

  constructor() {
    this.adapters = new Map<CrmProvider, CrmAdapter>();
    this.adapters.set('hubspot', new HubSpotAdapter());
    this.adapters.set('gohighlevel', new GoHighLevelAdapter());
    this.adapters.set('mailchimp', new MailchimpAdapter());
    this.adapters.set('activecampaign', new ActiveCampaignAdapter());
    this.adapters.set('webhook', new WebhookAdapter());
  }

  /** Returns the adapter for a provider, or throws if unknown. */
  getAdapter(provider: CrmProvider): CrmAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No CRM adapter registered for provider '${provider}'`);
    }
    return adapter;
  }

  /** Used by tests to assert all enum values have an adapter. */
  listProviders(): CrmProvider[] {
    return Array.from(this.adapters.keys());
  }
}
