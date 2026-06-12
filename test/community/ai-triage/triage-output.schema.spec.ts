import {
  TRIAGE_CATEGORIES,
  TriageItemSchema,
  TriageResponseSchema,
  TriageModelOutputSchema,
  emptyBuckets,
  emptyTriage,
} from '../../../src/community/ai-triage/triage-output.schema';

// v2-4 — locked output contract tests. Five categories exactly; provenance
// mandatory; .strict() rejects smuggled keys; datetime + uuid validators.

describe('triage-output schema', () => {
  it('declares exactly the five required categories in priority order', () => {
    expect([...TRIAGE_CATEGORIES]).toEqual([
      'urgent',
      'win_to_celebrate',
      'form_check',
      'general',
      'no_action_needed',
    ]);
  });

  it('emptyBuckets() yields one bucket per category in order', () => {
    const buckets = emptyBuckets();
    expect(buckets).toHaveLength(TRIAGE_CATEGORIES.length);
    expect(buckets.map((b) => b.category)).toEqual([...TRIAGE_CATEGORIES]);
    expect(buckets.every((b) => b.items.length === 0)).toBe(true);
  });

  it('emptyTriage() is a valid, typed-empty wire response', () => {
    const out = emptyTriage(new Date('2026-06-10T12:00:00Z'));
    expect(() => TriageResponseSchema.parse(out)).not.toThrow();
    expect(out.is_empty).toBe(true);
    expect(out.source_item_ids).toEqual([]);
  });

  describe('TriageItemSchema', () => {
    const valid = {
      source_item_id: '11111111-1111-4111-8111-111111111111',
      source_kind: 'message',
      category: 'urgent',
      summary: 'A short neutral summary.',
    };

    it('accepts a well-formed item', () => {
      expect(() => TriageItemSchema.parse(valid)).not.toThrow();
    });

    it('requires a UUID source_item_id (provenance)', () => {
      expect(() =>
        TriageItemSchema.parse({ ...valid, source_item_id: 'not-a-uuid' }),
      ).toThrow();
    });

    it('rejects an unknown category (no sixth bucket)', () => {
      expect(() =>
        TriageItemSchema.parse({ ...valid, category: 'spam' }),
      ).toThrow();
    });

    it('rejects an empty or over-length summary', () => {
      expect(() => TriageItemSchema.parse({ ...valid, summary: '' })).toThrow();
      expect(() =>
        TriageItemSchema.parse({ ...valid, summary: 'x'.repeat(281) }),
      ).toThrow();
    });

    it('.strict() rejects an unknown key on the item', () => {
      expect(() =>
        TriageItemSchema.parse({ ...valid, draft_reply: 'do X' }),
      ).toThrow();
    });
  });

  describe('TriageModelOutputSchema', () => {
    it('requires exactly five buckets', () => {
      const four = {
        buckets: TRIAGE_CATEGORIES.slice(0, 4).map((category) => ({
          category,
          items: [],
        })),
      };
      expect(() => TriageModelOutputSchema.parse(four)).toThrow();
    });

    it('.strict() rejects a smuggled top-level key', () => {
      const bad = {
        buckets: TRIAGE_CATEGORIES.map((category) => ({ category, items: [] })),
        injected_command: 'send_all',
      };
      expect(() => TriageModelOutputSchema.parse(bad)).toThrow();
    });
  });

  describe('TriageResponseSchema', () => {
    const valid = {
      generated_at: new Date().toISOString(),
      is_empty: false,
      buckets: TRIAGE_CATEGORIES.map((category) => ({ category, items: [] })),
      source_item_ids: ['11111111-1111-4111-8111-111111111111'],
    };

    it('accepts a valid wire response', () => {
      expect(() => TriageResponseSchema.parse(valid)).not.toThrow();
    });

    it('requires an ISO-8601 datetime for generated_at', () => {
      expect(() =>
        TriageResponseSchema.parse({ ...valid, generated_at: 'yesterday' }),
      ).toThrow();
    });

    it('requires UUIDs in source_item_ids', () => {
      expect(() =>
        TriageResponseSchema.parse({ ...valid, source_item_ids: ['nope'] }),
      ).toThrow();
    });

    it('.strict() rejects an unknown top-level key', () => {
      expect(() =>
        TriageResponseSchema.parse({ ...valid, extra: true }),
      ).toThrow();
    });
  });
});
