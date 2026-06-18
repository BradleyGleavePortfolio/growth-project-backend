// TM-7b — Admin applicant-review DTOs (owner-only). The query + decision input
// shapes and the queue/result envelopes are shared with the listing half, so
// they are re-exported from admin-moderation.dto rather than redefined; only
// the application-specific response card is new here.
export {
  ReviewQueueQueryDto,
  ReviewDecisionDto,
} from './admin-moderation.dto';
export type {
  ReviewQueueResponse,
  ReviewDecisionResult,
} from './admin-moderation.dto';

// Allow-list card for the application review queue — no raw entity is spread.
export interface ApplicationReviewCardDto {
  id: string;
  listing_id: string;
  status: string;
  fit_score: number | null;
  created_at: string;
}
