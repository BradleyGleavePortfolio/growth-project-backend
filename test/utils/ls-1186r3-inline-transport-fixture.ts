/** Statically named transport, using the inline import type already used in runtime source. */
export const INLINE_TRANSPORT_FILE = 'src/ls1186r3/inline-transport.ts';
export const INLINE_TRANSPORT_TEXT = `type Wire = import('../notifications/push/expo-push-client').ExpoPushClient;
export async function ordinaryNotice(wire: Wire, messages: Parameters<Wire['send']>[0], signal: AbortSignal) {
  return wire.send(messages, signal);
}
`;

export const NAMED_TRANSPORT_TEXT = INLINE_TRANSPORT_TEXT.replace(
  "type Wire = import('../notifications/push/expo-push-client').ExpoPushClient;",
  "import type { ExpoPushClient as Wire } from '../notifications/push/expo-push-client';",
);
