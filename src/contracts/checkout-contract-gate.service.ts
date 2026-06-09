import { Injectable, Logger } from '@nestjs/common';
import type { CoachPackage } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ContractEnvelopeService } from './contract-envelope.service';
import { ContractTemplateService } from './contract-template.service';
import { ContractsTelemetry } from './contracts.telemetry';
import { isContractsEnabled } from './contracts.feature';
import { sampleMergeData, type MergeData } from './contract-merge';

/**
 * B5 — Two-layer checkout gate (spec §4, brief §C).
 *
 * The single seam the existing Stripe checkout path consults BEFORE creating
 * any Checkout Session or PaymentIntent. It enforces, in order:
 *
 *   Layer 1 — Platform Liability Waiver (TGP ↔ Client). REQUIRED for every
 *             client, signed once, idempotent + version-grandfathered. A
 *             client who has already SIGNED any platform waiver passes
 *             immediately; otherwise an in-flight waiver envelope is reused,
 *             or a fresh one is created and the gate HOLDS.
 *
 *   Layer 2 — Coach Service Agreement (Coach ↔ Client). Only when the package
 *             has `requires_contract = true` AND a `contract_template_id`.
 *             Reuses a SIGNED coach envelope for the same template version,
 *             reuses an in-flight one, or creates a fresh one and HOLDS.
 *
 * The gate NEVER calls Stripe. When a layer is unsatisfied it returns a
 * `blocked` result carrying the envelope id + embed URL the client must sign;
 * the checkout service maps that to a structured 409 and does not touch
 * Stripe (invariant: no PaymentIntent without a SIGNED envelope, spec §4.1).
 *
 * Flag posture: when `FEATURE_CONTRACTS_ENABLED` is OFF the gate is a no-op
 * (`{ ok: true, reason: 'contracts_disabled' }`) so existing checkout for
 * non-`requires_contract` packages is completely unchanged (spec §E).
 */

export type GateResult =
  | { ok: true; reason: 'contracts_disabled' | 'no_contract_required' | 'all_signed'; coachEnvelopeId?: string }
  | {
      ok: false;
      layer: 'platform_waiver' | 'coach_service';
      envelopeId: string;
      embedUrl: string | null;
      status: string;
    };

@Injectable()
export class CheckoutContractGate {
  private readonly logger = new Logger(CheckoutContractGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly envelopes: ContractEnvelopeService,
    private readonly templates: ContractTemplateService,
    private readonly telemetry: ContractsTelemetry,
  ) {}

  /**
   * Evaluate both layers for a (client, package) purchase attempt. Returns
   * `ok: true` when checkout may proceed, or a `blocked` result describing the
   * envelope the client must sign. Pure of any Stripe side effect.
   */
  async evaluate(args: {
    clientId: string;
    client: { email: string; name: string };
    pkg: CoachPackage;
    coach: { id: string; email: string; name: string };
  }): Promise<GateResult> {
    // OFF → gate disabled, existing behavior unchanged.
    if (!isContractsEnabled()) {
      return { ok: true, reason: 'contracts_disabled' };
    }

    // ── Layer 1: Platform Liability Waiver ──────────────────────────────────
    const layer1 = await this.evaluatePlatformWaiver(args.clientId, args.client);
    if (!layer1.ok) {
      this.telemetry.checkoutBlocked(args.clientId, {
        package_id: args.pkg.id,
        reason: 'platform_waiver_unsigned',
      });
      return layer1;
    }

    // ── Layer 2: Coach Service Agreement (opt-in per package) ───────────────
    const requiresCoachContract =
      args.pkg.requires_contract === true && !!args.pkg.contract_template_id;
    if (!requiresCoachContract) {
      return { ok: true, reason: 'no_contract_required' };
    }

    const layer2 = await this.evaluateCoachContract({
      clientId: args.clientId,
      client: args.client,
      templateId: args.pkg.contract_template_id as string,
      pkg: args.pkg,
      coach: args.coach,
    });
    if (!layer2.ok) {
      this.telemetry.checkoutBlocked(args.clientId, {
        package_id: args.pkg.id,
        reason: 'coach_contract_unsigned',
      });
      return layer2;
    }

    return { ok: true, reason: 'all_signed', coachEnvelopeId: layer2.coachEnvelopeId };
  }

  // ─── Layer 1 ──────────────────────────────────────────────────────────────

  private async evaluatePlatformWaiver(
    clientId: string,
    client: { email: string; name: string },
  ): Promise<GateResult> {
    const waiver = await this.templates.getActivePlatformWaiver();
    if (!waiver) {
      // No platform waiver seeded yet → the feature is half-configured. Fail
      // closed loudly is wrong here (it would block ALL checkout the moment
      // the flag flips before seeding), so we hold this layer open and log;
      // the seeder is part of this PR so prod will always have one.
      this.logger.warn(
        'FEATURE_CONTRACTS_ENABLED is ON but no platform waiver template is seeded; skipping Layer 1.',
      );
      return { ok: true, reason: 'no_contract_required' };
    }

    // Grandfathering (spec §C): a client who already SIGNED any platform
    // waiver version is not asked to re-sign on a version bump.
    const alreadySigned = await this.envelopes.hasSignedAnyPlatformWaiver(clientId);
    if (alreadySigned) {
      return { ok: true, reason: 'all_signed' };
    }

    // Reuse an in-flight waiver for the CURRENT version rather than spawning
    // a new envelope on every buy click (idempotent, spec §C).
    const open = await this.envelopes.findOpenPlatformWaiver(
      clientId,
      waiver.id,
      waiver.version,
    );
    if (open) {
      const view = await this.envelopes.getEnvelopeViewForClient(open.id, clientId);
      return {
        ok: false,
        layer: 'platform_waiver',
        envelopeId: open.id,
        embedUrl: view.embedUrl,
        status: open.status,
      };
    }

    // Create a fresh waiver envelope and HOLD the gate.
    const tgpCoach = await this.platformCoachIdentity(waiver.coach_id);
    const mergeData = this.platformMergeData(client);
    const { envelope, embedUrl } = await this.envelopes.createEnvelope({
      templateId: waiver.id,
      clientId,
      coachId: waiver.coach_id,
      layer: 'platform_waiver',
      mergeData,
      title: waiver.name,
      client,
      coach: tgpCoach,
    });
    return {
      ok: false,
      layer: 'platform_waiver',
      envelopeId: envelope.id,
      embedUrl,
      status: envelope.status,
    };
  }

  // ─── Layer 2 ──────────────────────────────────────────────────────────────

  private async evaluateCoachContract(args: {
    clientId: string;
    client: { email: string; name: string };
    templateId: string;
    pkg: CoachPackage;
    coach: { id: string; email: string; name: string };
  }): Promise<GateResult & { coachEnvelopeId?: string }> {
    const tpl = await this.templates.getByIdUnscoped(args.templateId);

    // Already signed THIS template version → pass, carry the envelope id so
    // the caller can link it to the realized purchase post-payment.
    const signed = await this.envelopes.hasSignedCoachEnvelope(
      args.clientId,
      tpl.id,
      tpl.version,
    );
    if (signed) {
      return { ok: true, reason: 'all_signed', coachEnvelopeId: signed.id };
    }

    const open = await this.envelopes.findOpenCoachEnvelope(
      args.clientId,
      tpl.id,
      tpl.version,
    );
    if (open) {
      const view = await this.envelopes.getEnvelopeViewForClient(open.id, args.clientId);
      return {
        ok: false,
        layer: 'coach_service',
        envelopeId: open.id,
        embedUrl: view.embedUrl,
        status: open.status,
      };
    }

    const mergeData = this.coachMergeData(args.client, args.coach, args.pkg);
    const { envelope, embedUrl } = await this.envelopes.createEnvelope({
      templateId: tpl.id,
      clientId: args.clientId,
      coachId: args.coach.id,
      layer: 'coach_service',
      mergeData,
      title: tpl.name,
      client: args.client,
      coach: { email: args.coach.email, name: args.coach.name },
    });
    return {
      ok: false,
      layer: 'coach_service',
      envelopeId: envelope.id,
      embedUrl,
      status: envelope.status,
    };
  }

  // ─── Merge-data assembly ────────────────────────────────────────────────────

  private platformMergeData(client: { email: string; name: string }): MergeData {
    const [first, ...rest] = (client.name ?? '').trim().split(/\s+/);
    return {
      'client.first_name': first || client.name || 'Client',
      'client.last_name': rest.join(' ') || '—',
      'client.email': client.email,
      'coach.first_name': 'Growth Project',
      'coach.business_name': 'Growth Project',
      'package.name': 'Platform Access',
      'package.price': '—',
      'package.duration': '—',
      today: new Date().toISOString().slice(0, 10),
    };
  }

  private coachMergeData(
    client: { email: string; name: string },
    coach: { name: string },
    pkg: CoachPackage,
  ): MergeData {
    const [cFirst, ...cRest] = (client.name ?? '').trim().split(/\s+/);
    const [coachFirst] = (coach.name ?? '').trim().split(/\s+/);
    const price = `${(pkg.amount_cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: (pkg.currency ?? 'usd').toUpperCase(),
    })}`;
    return {
      'client.first_name': cFirst || client.name || 'Client',
      'client.last_name': cRest.join(' ') || '—',
      'client.email': client.email,
      'coach.first_name': coachFirst || coach.name || 'Coach',
      'coach.business_name': coach.name || 'Coach',
      'package.name': pkg.name ?? 'Coaching Package',
      'package.price': price,
      'package.duration': pkg.interval ? String(pkg.interval) : '—',
      today: new Date().toISOString().slice(0, 10),
    };
  }

  /** Resolve the TGP system-coach identity for the platform waiver signer-2. */
  private async platformCoachIdentity(
    coachId: string,
  ): Promise<{ email: string; name: string }> {
    const u = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { email: true, name: true },
    });
    return {
      email: u?.email ?? 'contracts@trygrowthproject.com',
      name: u?.name ?? 'Growth Project',
    };
  }
}
