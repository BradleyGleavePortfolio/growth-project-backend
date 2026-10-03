/**
 * Pins the owner-approved community safety copy (approved 2026-10-01 09:07
 * PDT): the seven community guidelines, the 24-hour moderation commitment and
 * the safety contact email served by GET /community/safety. Any change to
 * these strings needs a new owner approval, so this spec compares them
 * byte for byte.
 */
import 'reflect-metadata';
import {
  COMMUNITY_GUIDELINES,
  COMMUNITY_REPORT_REASONS,
  COMMUNITY_RESPONSE_COMMITMENT,
  COMMUNITY_SAFETY_EMAIL,
} from '../../../src/community/safety/community-safety.service';
import { SUPPORT_EMAIL } from '../../../src/public-pages/trust-pages.html';
import { safetyWithBlocks } from './safety-test-helpers';

const APPROVED_GUIDELINES = [
  'Be respectful. No harassment, bullying, hate speech or threats.',
  'No sexual or explicit content.',
  'No spam, advertising or scams.',
  'Share training experience, not medical advice. This is a personal-training community.',
  "Keep private things private. Do not share anyone else's personal or health information.",
  'Report anything that breaks these rules. Reports go to your coach and to the team.',
  'This space is not for emergencies. If you are in danger, call 911. If you are struggling emotionally, call or text 988.',
];

const APPROVED_24H_SENTENCE =
  'Reports are reviewed within 24 hours, every day, by your coach and The Growth Project team.';

const APPROVED_COMMITMENT =
  `${APPROVED_24H_SENTENCE} Content that breaks these guidelines is removed, and people who ` +
  'break them repeatedly lose access. If you block someone, they can no longer see your posts ' +
  'or message you, and they are not told.';

// OR-109-1: the safety contact is the repo's one SUPPORT_EMAIL constant
// (backend #631 sets it to the owner's support inbox, ruling 10-01 14:19).
// Pinned by identity, so this spec stays true before and after #631 lands.
const APPROVED_SAFETY_EMAIL = SUPPORT_EMAIL;

const APPROVED_REPORT_REASON_LABELS = [
  'Harassment or bullying',
  'Hate speech or discrimination',
  'Sexual or explicit content',
  'Threats or violence',
  'Self-harm or suicide',
  'Spam or scams',
  'Harmful health misinformation',
  'Something else',
];

describe('community safety copy (owner-approved 2026-10-01)', () => {
  const saved = process.env.COMMUNITY_SAFETY_CONTACT_EMAIL;
  // safetyInfo() never touches the database.
  const safety = safetyWithBlocks();

  afterEach(() => {
    if (saved === undefined) delete process.env.COMMUNITY_SAFETY_CONTACT_EMAIL;
    else process.env.COMMUNITY_SAFETY_CONTACT_EMAIL = saved;
  });

  it('serves the seven approved guidelines in order, byte for byte', () => {
    expect([...COMMUNITY_GUIDELINES]).toEqual(APPROVED_GUIDELINES);
    expect(safety.safetyInfo().guidelines).toEqual(APPROVED_GUIDELINES);
  });

  it('serves the 24-hour moderation commitment exactly', () => {
    const info = safety.safetyInfo();
    expect(COMMUNITY_RESPONSE_COMMITMENT).toBe(APPROVED_COMMITMENT);
    expect(info.response_commitment).toBe(APPROVED_COMMITMENT);
    expect(info.response_commitment.startsWith(APPROVED_24H_SENTENCE)).toBe(true);
  });

  it('serves SUPPORT_EMAIL (the one support constant) as the safety contact', () => {
    delete process.env.COMMUNITY_SAFETY_CONTACT_EMAIL;
    expect(COMMUNITY_SAFETY_EMAIL).toBe(APPROVED_SAFETY_EMAIL);
    expect(safety.safetyInfo().contact_email).toBe(APPROVED_SAFETY_EMAIL);
    expect(APPROVED_SAFETY_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
  });

  it('ignores the retired COMMUNITY_SAFETY_CONTACT_EMAIL override (one address everywhere)', () => {
    process.env.COMMUNITY_SAFETY_CONTACT_EMAIL = 'safety@example.test';
    expect(safety.safetyInfo().contact_email).toBe(APPROVED_SAFETY_EMAIL);
  });

  it('offers the approved report reasons', () => {
    expect(COMMUNITY_REPORT_REASONS.map((r) => r.label)).toEqual(APPROVED_REPORT_REASON_LABELS);
  });

  it('keeps shipped copy free of exclamation marks and emojis', () => {
    for (const line of [...APPROVED_GUIDELINES, APPROVED_COMMITMENT]) {
      expect(line).not.toMatch(/!/);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
