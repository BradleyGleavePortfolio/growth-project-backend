/**
 * LO-1185 B-TEST B1 (b#1185 round 1, Claude Opus lens): each read form below reads a member-content table in a
 * way src/ already uses or can use without a reviewer noticing, and the scan must report it. At 5ca78135 every case
 * here is red: the scan reports no site for it, so a new unregistered read in that form passes the KT-2 gate.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMemberContentReads } from './member-content-scan';

const FORMS: Array<[name: string, model: string, source: string]> = [
  ['element access with a string key', 'CommunityMessage',
    "export class P { constructor(private prisma: any) {} f() { return this.prisma['communityMessage'].findMany({}); } }"],
  ['destructured delegate', 'CommunityPost',
    'export class P { constructor(private prisma: any) {} f() { const { communityPost } = this.prisma; return communityPost.findMany({}); } }'],
  ['delegate alias from a receiver not named like a client', 'CommunityWin',
    'export class P { constructor(private deps: any) {} f() { const d = this.deps.communityWin; return d.findMany({}); } }'],
  ['include held in a constant (the repo style: select: CONST, include: CONST)', 'CommunityMessage',
    'const INC = { community_messages_sent: true } as const;\n' +
    'export class P { constructor(private prisma: any) {} f() { return this.prisma.user.findMany({ include: INC }); } }'],
  ['fluent relation read', 'CommunityMessage',
    "export class P { constructor(private prisma: any) {} f(id: string) { return this.prisma.user.findUnique({ where: { id } }).community_messages_sent(); } }"],
  ['raw SQL on a schema-qualified quoted table', 'CommunityMessage',
    'export class P { constructor(private prisma: any) {} f() { return this.prisma.$queryRaw`SELECT m.body FROM "public"."community_messages" m`; } }'],
  ['raw SQL with the table in a FROM list', 'CommunityMessage',
    'export class P { constructor(private prisma: any) {} f() { return this.prisma.$queryRaw`SELECT m.body FROM users u, community_messages m WHERE m.sender_id = u.id`; } }'],
];

describe('LO-1185 B1: the KT-2 scan reports every read form', () => {
  for (const [name, model, source] of FORMS) {
    it(`reports a ${model} read through ${name}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'lo1185-b1-'));
      try {
        writeFileSync(join(root, 'probe.ts'), source);
        const sites = scanMemberContentReads(root).filter((s) => s.model === model);
        // Any site will do (the read itself or the constant it reads through); none is the B.
        expect(sites.map((s) => `${s.file}:${s.line} ${s.reader} ${s.model} ${s.via}`)).not.toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
