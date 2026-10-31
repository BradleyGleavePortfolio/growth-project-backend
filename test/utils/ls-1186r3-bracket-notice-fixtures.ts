/** Exact runtime fixture texts shared by the failing diagnostic and unchanged-whole-gate control. */
export const BRACKET_NOTICE_FORMS = [
  ['bracket-method', `db.notification['create']`],
  ['bracket-delegate', `db['notification'].create`],
  ['bracket-both', `db['notification']['create']`],
] as const;

export const bracketNoticeText = (access: string): string => `import type { Prisma } from '@prisma/client';
export async function ordinaryNotice(db: Pick<Prisma.TransactionClient, 'notification'>, userId: string) {
  return ${access}({ data: { user_id: userId, kind: 'message_received', body: 'Body', channel: 'inapp' } });
}
`;
export const bracketNoticeFile = (name: string): string => `src/ls1186r3-bracket/${name}.ts`;
