import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * B5 — Thrown by the checkout path when a required contract is not yet SIGNED
 * (spec §4). The checkout service maps a blocked two-layer gate result into
 * this 409, which the client uses to drive the embedded signing step before
 * retrying checkout. Carries the envelope id + embed URL the client must sign.
 *
 * This is the structural guarantee behind the spec §4.1 invariant: the
 * checkout path RETURNS HERE instead of reaching Stripe whenever a contract is
 * required and unsigned — there is no code path to a PaymentIntent without a
 * SIGNED envelope.
 */
export class ContractRequiredException extends HttpException {
  constructor(args: {
    layer: 'platform_waiver' | 'coach_service';
    envelopeId: string;
    embedUrl: string | null;
    status: string;
  }) {
    super(
      {
        error: 'CONTRACT_SIGNATURE_REQUIRED',
        message:
          args.layer === 'platform_waiver'
            ? 'You must sign the platform agreement before purchasing.'
            : 'You must sign the coach service agreement before purchasing.',
        contract: {
          layer: args.layer,
          envelope_id: args.envelopeId,
          embed_url: args.embedUrl,
          status: args.status,
        },
      },
      HttpStatus.CONFLICT,
    );
  }
}
