// growth-project-mobile mirrors this list (see its reaction registry); change both together
import { validateSync } from 'class-validator';
import { ReactDto } from '../../src/community/dto/community-reaction.dto';
import {
  COMMUNITY_REACTION_EMOJI,
  COMMUNITY_REACTION_KIND_BY_EMOJI,
  reactionKindForEmoji,
} from '../../src/community/reactions/community-emoji.allowlist';

const EXPECTED_REACTIONS = {
  '👍': 'like',
  '🔥': 'fire',
  '👨‍👩‍👧‍👦': 'family',
  '❤️': 'love',
  '🎉': 'celebrate',
  '💪': 'strength',
  '👏': 'clap',
  '😂': 'laugh',
  '😮': 'wow',
  '😢': 'sad',
};

describe('community reaction contract mirrored by mobile', () => {
  it('pins exactly the ten accepted graphemes, without duplicates', () => {
    expect([...COMMUNITY_REACTION_EMOJI].sort()).toEqual(
      Object.keys(EXPECTED_REACTIONS).sort(),
    );
  });

  it('pins the exact realtime name for every grapheme, with no extra keys', () => {
    expect(COMMUNITY_REACTION_KIND_BY_EMOJI).toEqual(EXPECTED_REACTIONS);
  });

  it.each(Object.entries(EXPECTED_REACTIONS))(
    'accepts %s in ReactDto and resolves its realtime name to %s',
    (emoji, name) => {
      expect(validateSync(Object.assign(new ReactDto(), { emoji }))).toEqual([]);
      expect(reactionKindForEmoji(emoji)).toBe(name);
    },
  );

  it.each(['🎯', '👀'])('rejects the former mobile reaction %s in ReactDto', (emoji) => {
    const errors = validateSync(Object.assign(new ReactDto(), { emoji }));
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('emoji');
    expect(errors[0].constraints).toHaveProperty('isIn');
  });
});
