// Argument parser for scripts/set-coach-welcome-message.ts (kept in src so it
// is unit-tested without loading the script entrypoint).

export interface CliArgs {
  coachId?: string;
  coachEmail?: string;
  templateFile?: string;
  useDefault: boolean;
  enable?: boolean;
  show: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { useDefault: false, show: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--coach-id') out.coachId = next();
    else if (a === '--coach-email') out.coachEmail = next();
    else if (a === '--template-file') out.templateFile = next();
    else if (a === '--use-default') out.useDefault = true;
    else if (a === '--enable') out.enable = true;
    else if (a === '--disable') out.enable = false;
    else if (a === '--show') out.show = true;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!out.coachId && !out.coachEmail) throw new Error('--coach-id or --coach-email is required');
  if (out.templateFile && out.useDefault)
    throw new Error('use --template-file or --use-default, not both');
  return out;
}
