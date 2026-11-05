import {
  CommunityCohortListResponseSchema,
  CommunityCohortResponseSchema,
  spacePurpose,
} from '../../../src/community/dto/community-cohort.dto';

/**
 * SC-PURPOSE-BE (agent 180): a space's purpose (CommunityCohort.description) on the two
 * space reads members use, GET /community/cohorts rows and GET /community/cohorts/:cohortId.
 * The field is a string or null; none, or a purpose the coach cleared (""), reads as null.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const PURPOSE = 'Morning check-ins and weekly wins for the 6am group.';

const row = (extra: object) => ({
  id: SPACE,
  workspace_id: WS,
  name: 'Morning crew',
  is_default: false,
  kind: 'chat',
  posting_policy: 'all',
  visibility: 'members',
  member_count: 3,
  my_role: 'client',
  unread_count: 0,
  ...extra,
});

const detail = (extra: object) => ({
  feature_flag_state: 'enabled',
  id: SPACE,
  workspace_id: WS,
  name: 'Morning crew',
  is_default: false,
  kind: 'chat',
  posting_policy: 'all',
  visibility: 'public',
  package_ids: null,
  member_count: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  my_membership: null,
  ...extra,
});

const list = (extra: object) => ({ feature_flag_state: 'enabled', cohorts: [row(extra)] });

describe('SC-PURPOSE-BE: spacePurpose', () => {
  it('keeps a stored purpose exactly as written', () => {
    expect(spacePurpose(PURPOSE)).toBe(PURPOSE);
    const long = 'a'.repeat(2000);
    expect(spacePurpose(long)).toBe(long);
  });

  it('null stays null; absent, empty and blank read as null', () => {
    expect(spacePurpose(null)).toBeNull();
    expect(spacePurpose(undefined)).toBeNull();
    expect(spacePurpose('')).toBeNull();
    expect(spacePurpose('   ')).toBeNull();
  });
});

const listRow = (extra: object) => CommunityCohortListResponseSchema.parse(list(extra)).cohorts[0];
const listOk = (extra: object) => CommunityCohortListResponseSchema.safeParse(list(extra)).success;
const detailOk = (extra: object) => CommunityCohortResponseSchema.safeParse(detail(extra)).success;

describe('SC-PURPOSE-BE: the space reads carry description (string or null)', () => {
  it('GET /community/cohorts rows: a purpose and a null purpose parse unchanged', () => {
    expect(listRow({ description: PURPOSE }).description).toBe(PURPOSE);
    expect(listRow({ description: null }).description).toBeNull();
  });

  it('GET /community/cohorts/:cohortId: a purpose and a null purpose parse unchanged', () => {
    const read = (extra: object) => CommunityCohortResponseSchema.parse(detail(extra));
    expect(read({ description: PURPOSE }).description).toBe(PURPOSE);
    expect(read({ description: null }).description).toBeNull();
  });

  it('both reads refuse a description that is not a string or null', () => {
    expect(listOk({ description: 42 })).toBe(false);
    expect(detailOk({ description: { text: PURPOSE } })).toBe(false);
  });

  it('both reads refuse a space object without description (the field is required)', () => {
    expect(listOk({ description: null })).toBe(true); // control: the same row with the field parses
    expect(detailOk({ description: null })).toBe(true);
    expect(listOk({})).toBe(false);
    expect(detailOk({})).toBe(false);
  });
});
