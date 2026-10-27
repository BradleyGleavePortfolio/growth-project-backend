// FX-1137 (LS-1137 B2): a space's default notification mode follows its kind (Announcements: All), never who may
// post there; a saved choice and a running silence still win.
import type { CommunityPostingPolicy, CommunitySpaceKind } from '@prisma/client';
import { notifySettingOf } from '../community-space-reads.service';

const KINDS: CommunitySpaceKind[] = ['chat', 'announcement', 'section'];
const POLICIES: CommunityPostingPolicy[] = ['all', 'coach'];
const MATRIX = KINDS.flatMap((kind) => POLICIES.map((posting_policy) => ({ kind, posting_policy })));

describe('space notification default by kind', () => {
  it.each(MATRIX)('$kind space, posting $posting_policy: an unset preference gets the kind default', (space) => {
    const want = space.kind === 'announcement' ? 'all' : 'mute_low';
    expect(notifySettingOf(space, null)).toEqual({ mode: want, default_mode: want, effective_mode: want, silenced_until: null });
  });

  it('editing who may post never moves an unset default; a saved mode and a silence still win', () => {
    const space: { kind: CommunitySpaceKind; posting_policy: CommunityPostingPolicy } = { kind: 'chat', posting_policy: 'all' };
    expect(notifySettingOf(space, null).mode).toBe('mute_low');
    space.posting_policy = 'coach';
    expect(notifySettingOf(space, null).mode).toBe('mute_low');
    expect(notifySettingOf(space, { notify_mode: 'all', silenced_until: null }).mode).toBe('all');
    const until = new Date(Date.now() + 3_600_000);
    expect(notifySettingOf(space, { notify_mode: 'all', silenced_until: until }).effective_mode).toBe('mute_all');
  });
});
