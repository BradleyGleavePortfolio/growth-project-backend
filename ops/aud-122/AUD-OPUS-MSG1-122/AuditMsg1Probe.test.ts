/**
 * AUD-OPUS-MSG1-122 probe (audit branch only, never merged).
 * B-377-1: a v2 "Not sent" bubble (failed send, device key kept for Send again)
 * must survive the next successful thread refresh unless the server actually
 * holds THAT send (same client_message_id). Today reconcilePending drops any
 * pending bubble whose body equals any server row, so a failed "Done" vanishes
 * when an earlier "Done" is in the thread, and the message is never sent.
 */
import { normalizeMessage, reconcilePending } from '../MessagesScreen';

const ME = 'client-1';
const COACH = 'coach-1';

describe('AUD-OPUS-MSG1-122 B-377-1 probe', () => {
  const failed = { ...normalizeMessage({ id: 'pending_key-new', sender_id: ME, sender_role: 'client', body: 'Done', client_message_id: 'key-new' }, ME), pending: true };

  it('keeps the failed v2 bubble when only an OLDER message with the same text is on the server', () => {
    const server = [
      normalizeMessage({ id: 'm-old', sender_id: ME, body: 'Done', created_at: '2026-10-04T18:00:00.000Z', client_message_id: 'key-old' }, ME),
      normalizeMessage({ id: 'm-coach', sender_id: COACH, body: 'Nice work', created_at: '2026-10-04T18:05:00.000Z' }, ME),
    ];
    const kept = reconcilePending([failed], server);
    expect(kept.map((m) => m.id)).toEqual(['pending_key-new']);
  });

  it('control: drops the bubble when the server row carries the same client_message_id (the send did land)', () => {
    const server = [
      normalizeMessage({ id: 'm-new', sender_id: ME, body: 'Done', created_at: new Date().toISOString(), client_message_id: 'key-new' }, ME),
    ];
    expect(reconcilePending([failed], server)).toEqual([]);
  });
});
