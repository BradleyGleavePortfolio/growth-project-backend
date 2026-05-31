import {
  CoachInsightSchema,
  ClientInsightSchema,
  type CoachInsight,
  type ClientInsight,
} from './insight-output.schema';

// PR-HK-4 R2 — output-schema contract tests. Covers the strict() exact-
// field requirement (audit R1 #2).

function validCoach(): CoachInsight {
  return {
    observation: 'HRV trended down across five of the last seven nights.',
    hypothesis: 'Accumulated training load alongside shorter sleep windows.',
    suggested_action: 'Pull back tonight session intensity and protect sleep.',
    suggested_message_draft:
      'Your recovery has dipped this week. Lets keep tonight light tonight.',
    confidence_level: 'confident',
    source_metrics: ['HRV_MS', 'SLEEP_TOTAL_MIN'],
  };
}

function validClient(): ClientInsight {
  return {
    observation: 'Your sleep has been a bit short this week.',
    norm_comparison: 'Your 6h average is below the typical adult 7-9h range.',
    intervention: 'Aim to be in bed 30 minutes earlier tonight.',
    optional_cta: { label: 'Set a bedtime reminder', deep_link: 'tgp://sleep/reminder' },
    confidence_level: 'fairly_sure',
    source_metrics: ['SLEEP_TOTAL_MIN'],
  };
}

describe('insight output schemas', () => {
  describe('CoachInsightSchema.strict()', () => {
    it('accepts an exact coach payload', () => {
      expect(CoachInsightSchema.safeParse(validCoach()).success).toBe(true);
    });

    it('rejects an unknown key (prompt-injection extra field)', () => {
      const bad = { ...validCoach(), injected_admin_flag: true };
      const res = CoachInsightSchema.safeParse(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    });

    it('rejects client-only fields smuggled onto a coach payload', () => {
      const bad = {
        ...validCoach(),
        norm_comparison: 'not allowed here',
        intervention: 'nor this',
        optional_cta: null,
      };
      expect(CoachInsightSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects source_metrics shorter than 1 (min length contract)', () => {
      const bad = { ...validCoach(), source_metrics: [] };
      expect(CoachInsightSchema.safeParse(bad).success).toBe(false);
    });
  });

  describe('ClientInsightSchema.strict()', () => {
    it('accepts an exact client payload', () => {
      expect(ClientInsightSchema.safeParse(validClient()).success).toBe(true);
    });

    it('rejects an unknown key', () => {
      const bad = { ...validClient(), surprise: 1 };
      const res = ClientInsightSchema.safeParse(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    });

    it('rejects coach-only fields smuggled onto a client payload', () => {
      const bad = {
        ...validClient(),
        hypothesis: 'leaked',
        suggested_action: 'leaked',
        suggested_message_draft: 'leaked',
      };
      expect(ClientInsightSchema.safeParse(bad).success).toBe(false);
    });
  });
});
