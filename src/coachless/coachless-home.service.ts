import { Injectable } from '@nestjs/common';
import { FeaturedCoachService, type FeaturedPackage } from './featured-coach.service';
import {
  CoachlessPromptService,
  decideRomanCard,
  type RomanCardHiddenReason,
} from './coachless-prompt.service';
import type { CoachCard } from './coach-code-lookup.service';

export interface CoachlessHomeResponse {
  /** True only for a student with no coach: the coachless surfaces apply. */
  eligible: boolean;
  coach_attached: boolean;
  banner: {
    title: string;
    /** The owner's offer line; null while the featured coach is not accepting clients. */
    offer_text: string | null;
    /** The featured code to prefill the sheet; null while not accepting. */
    code: string | null;
  } | null;
  roman_card: {
    text: string;
    code: string;
  } | null;
  roman_card_hidden_reason: RomanCardHiddenReason | null;
  featured_coach:
    | (Pick<CoachCard, 'name' | 'photo_url' | 'business_name'> & {
        package: FeaturedPackage | null;
      })
    | null;
}

/**
 * A1-COACHLESS — what the coachless Home shows. A coachless client is a
 * complete state: the banner is a quiet entry point (always available while
 * coachless), the offer line and the Roman card appear only while the
 * featured coach is accepting clients, and both disappear once a coach is
 * attached.
 */
@Injectable()
export class CoachlessHomeService {
  constructor(
    private readonly featured: FeaturedCoachService,
    private readonly prompts: CoachlessPromptService,
  ) {}

  async home(
    user: { id: string; role: string; coach_id: string | null },
    now = new Date(),
  ): Promise<CoachlessHomeResponse> {
    const attached = !!user.coach_id;
    if (user.role !== 'student' || attached) {
      return {
        eligible: false,
        coach_attached: attached,
        banner: null,
        roman_card: null,
        roman_card_hidden_reason: null,
        featured_coach: null,
      };
    }
    const offer = await this.featured.get();
    const accepting = offer.accepting_clients;
    const decision = decideRomanCard(offer, await this.prompts.getState(user.id), now);
    return {
      eligible: true,
      coach_attached: false,
      banner: {
        title: offer.banner_title,
        offer_text: accepting ? offer.offer_text : null,
        code: accepting ? offer.code : null,
      },
      roman_card:
        decision.show && offer.roman_pitch_text && offer.code
          ? { text: offer.roman_pitch_text, code: offer.code }
          : null,
      roman_card_hidden_reason: decision.show ? null : decision.reason,
      featured_coach:
        accepting && offer.coach
          ? {
              name: offer.coach.name,
              photo_url: offer.coach.photo_url,
              business_name: offer.coach.business_name,
              package: offer.package,
            }
          : null,
    };
  }
}
