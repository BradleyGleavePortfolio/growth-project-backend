import { PrismaClient } from '@prisma/client';
import {
  backfillLedgerPlatform,
  exitCodeFor,
  type BackfillClient,
  type BackfillOptions,
} from './scout-ledger-backfill';

/**
 * G2-B operator entry (not wired into the HTTP app or any module):
 *   DATABASE_URL=<service role url> npx ts-node src/scout/scout-ledger-backfill.cli.ts \
 *     [--batch=500] [--passes=3] [--lock-retries=2]
 * Prints one JSON report (counts only: no identifiers, payloads or platform values)
 * and exits 0 only for `drained`; 4 complete but unfenced, 2 unresolved, 3 stalled,
 * 1 on any other failure. Rerunning is safe at any point.
 */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = {};
  for (const arg of argv) {
    const match = /^--(batch|passes|lock-retries)=(\d{1,5})$/.exec(arg);
    if (!match) throw new RangeError(`G2-B backfill: unsupported argument ${arg}`);
    const value = Number(match[2]);
    if (match[1] === 'batch') options.batch = value;
    else if (match[1] === 'passes') options.maxPasses = value;
    else options.lockRetries = value;
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseBackfillArgs(process.argv.slice(2));
  const prisma: BackfillClient & { $disconnect(): Promise<void> } = new PrismaClient();
  try {
    const report = await backfillLedgerPlatform(prisma, options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return exitCodeFor(report.outcome);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // Class only for database failures (a raw error can carry identifiers);
      // usage and integrity errors are operator-facing and identifier-free.
      const detail =
        err instanceof RangeError || (err instanceof Error && err.name === 'BackfillIntegrityError')
          ? err.message
          : err instanceof Error
            ? err.name
            : 'unknown';
      console.error(`G2-B backfill failed: ${detail}`);
      process.exit(1);
    },
  );
}
