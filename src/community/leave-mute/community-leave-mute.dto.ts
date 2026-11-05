/**
 * LEAVE-MUTE-BE (agent 176): response shapes. The server sends ids, kinds and times, never words (the phone
 * owns every line, owner rule 137-2).
 */
import { z } from 'zod';
import { CommunityCohortListResponseSchema } from '../dto/community-cohort.dto';

/** GET /community/cohorts?include_left=1: every row also carries left_at (null = in the space). */
export const CommunityCohortListWithLeftSchema = CommunityCohortListResponseSchema.extend({
  cohorts: z.array(
    CommunityCohortListResponseSchema.shape.cohorts.element.extend({
      left_at: z.string().datetime().nullable().optional(),
    }),
  ),
});
export type CommunityCohortListWithLeft = z.infer<typeof CommunityCohortListWithLeftSchema>;

export interface SpaceLeave {
  cohort_id: string;
  left_at: string | null;
}

export interface LeftMembers {
  cohort_id: string;
  left: { user_id: string; name: string; left_at: string }[];
}

export interface ThreadState {
  thread_message_id: string;
  state: 'muted' | 'left';
  since: string;
}

export interface ThreadStates {
  cohort_id: string;
  threads: ThreadState[];
}
