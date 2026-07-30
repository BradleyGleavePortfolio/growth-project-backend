import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  isAllowedWhileLocked,
  normalizePath,
} from '../src/checkout/dunning-v2/dunning-lockout.guard';

// P0-AUDIT (backend 5076a07a) Lens B P1-2: the allow-list was asserted only
// against hand-picked example paths, never the mounted route table, so an
// accidentally-matching route was unobservable. This spec enumerates every route
// mounted by a @Controller in src/ and pins the EXACT set DunningLockoutGuard
// admits while a client is locked out.
//
// The inventory comes from the TypeScript AST, one @Controller CLASS at a time,
// pairing each prefix with only its OWN method decorators. An earlier revision
// scanned each FILE with one non-global regex and attributed every method
// decorator to that file's FIRST prefix — the same blind spot one level up.
// Eight files declare multiple controllers, so their later routes were filed
// under the WRONG prefix: CoachPurchasesController (`v1/coach/purchases`) shares
// checkout.controller.ts with CheckoutController (`v1/checkout`), so its route
// landed in the allow-listed `checkout` subtree and `coach/purchases` never
// appeared in the scanned surface. See the counter-example at the bottom.
//
// If this test failed: do NOT paste the new path in to make it green. Answer
// "may a locked-out, non-paying client call this?" The only yes-answers are
// payment recovery, auth, liveness probes, and the Roman lockout explanation.

const REPO_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const HTTP_METHODS = 'Get|Post|Put|Patch|Delete|Head|Options|All';
const CONTROLLER_NAMES: ReadonlySet<string> = new Set(['Controller']);
const HTTP_METHOD_NAMES: ReadonlySet<string> = new Set(HTTP_METHODS.split('|'));

interface MountedRoute {
  readonly normalized: string; // path after the guard's normalizePath
  readonly controller: string; // declaring @Controller class
  readonly file: string; // repo-relative source
}

interface ParsedController {
  readonly className: string;
  readonly prefix: string;
  readonly file: string;
  readonly routes: readonly MountedRoute[];
}

/** The `@Foo(...)` call on `node`, if its name is in `names`. */
function decoratorCallNamed(
  node: ts.Node,
  names: ReadonlySet<string>,
): ts.CallExpression | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  for (const decorator of ts.getDecorators(node) ?? []) {
    const { expression } = decorator;
    if (!ts.isCallExpression(expression)) continue;
    const target = expression.expression;
    if (ts.isIdentifier(target) && names.has(target.text)) return expression;
  }
  return undefined;
}

/** `@Get('sessions')` → `sessions`; `@Get()` and `@Get(dynamic)` → ``. */
function firstStringArgument(call: ts.CallExpression): string {
  const [arg] = call.arguments;
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '';
}

/**
 * Parse one source into its @Controller CLASSES, pairing each prefix with only
 * its own members' method decorators. Takes source text so the mutation fixture
 * below drives this exact parser.
 */
export function parseControllerSource(sourceText: string, fileName: string): ParsedController[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const parsed: ParsedController[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const controller = decoratorCallNamed(node, CONTROLLER_NAMES);
      if (controller) {
        const prefix = firstStringArgument(controller);
        const className = node.name?.text ?? '(anonymous)';
        const routes: MountedRoute[] = [];
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const httpMethod = decoratorCallNamed(member, HTTP_METHOD_NAMES);
          if (!httpMethod) continue;
          const mounted = [prefix, firstStringArgument(httpMethod)].filter(Boolean).join('/');
          // The global prefix is `/api` (src/main.ts:148 setGlobalPrefix), which
          // is what the guard sees on a live request.
          const normalized = normalizePath(`/api/${mounted}`);
          routes.push({ normalized, controller: className, file: fileName });
        }
        parsed.push({ className, prefix, file: fileName, routes });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return parsed;
}

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) controllerFiles(p, out);
    else if (name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

/** `textual*` are raw decorator counts in the same sources — AST cross-checks. */
function scanRouteTable() {
  const files = controllerFiles(SRC_ROOT);
  const controllers: ParsedController[] = [];
  let textualControllers = 0;
  let textualHttp = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    controllers.push(...parseControllerSource(src, path.relative(REPO_ROOT, file)));
    textualControllers += (src.match(/@Controller\(/g) ?? []).length;
    textualHttp += (src.match(new RegExp(`@(?:${HTTP_METHODS})\\(`, 'g')) ?? []).length;
  }

  const routes: readonly MountedRoute[] = controllers.flatMap((c) => c.routes);
  return { files, controllers, routes, textualControllers, textualHttp };
}

// Every normalized path the guard admits while LOCKED OUT. Reviewed one by one;
// each is payment recovery, auth, a liveness probe, or the Roman explanation.
const EXPECTED_REACHABLE_WHILE_LOCKED: readonly string[] = [
  '', // public landing root (LandingPagePublicController, @Controller() + @Get())
  'auth/apple',
  'auth/attach-coach-code',
  'auth/attach-invite-code',
  'auth/become-coach',
  'auth/bootstrap-owner',
  'auth/extension/login',
  'auth/extension/refresh',
  'auth/forgot-password',
  'auth/google',
  'auth/login',
  'auth/me',
  'auth/recent-auth-token',
  'auth/register',
  'auth/select-role',
  'auth/signup-policy',
  'auth/signup-with-code',
  'auth/validate-invite-code',
  'checkout', // public landing checkout page (LandingPagePublicController)
  'checkout/billing-portal', // CheckoutController owns the rest of this block
  'checkout/entitlement',
  'checkout/payment-intent',
  'checkout/payment-method',
  'checkout/purchases',
  'checkout/purchases/:purchaseid/drops',
  'checkout/sessions',
  'checkout/sessions/:sessionid/confirm',
  'coach/billing/portal-session', // mobile coach billing (MobileCoachBillingController)
  'coach/billing/status',
  'coach/me/billing', // v1 coach billing (CoachBillingController) — Lens A P2-1
  'coach/me/billing/portal-session', // the Stripe portal a locked coach needs
  'health',
  'health/deep',
  'healthz',
  'readyz',
  'roman/sessions',
  'roman/sessions/:id',
  'roman/sessions/:id/messages',
];

// Files declaring MORE THAN ONE @Controller class, pinned in source order — the
// assertion a file-level scan cannot satisfy: it sees only each row's first entry.
const MULTI_CONTROLLER_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['src/checkout/checkout.controller.ts', ['CheckoutController', 'CoachPurchasesController']],
  ['src/macros/macros.controller.ts', ['CoachMacrosController', 'ClientMacrosController']],
  ['src/packages/packages.controller.ts', ['CoachPackagesController', 'ClientPackagesController']],
  [
    'src/checkout/payment-ops.controller.ts',
    ['AdminPaymentOpsController', 'CoachPaymentOpsController'],
  ],
  [
    'src/exercise-catalog/exercise-catalog.controller.ts',
    ['ExerciseCatalogController', 'AdminExerciseCatalogController'],
  ],
  [
    'src/meal-plans/client-meal-plans.controller.ts',
    ['ClientMealPlansController', 'ClientMealPlanAliasController'],
  ],
  [
    'src/real-meal-plans/real-meal-plans.controller.ts',
    ['CoachMealTemplatesController', 'CoachDailyMealPlansController', 'ClientMealPlanController'],
  ],
  [
    'src/workout-builder/workout-builder.controller.ts',
    ['WorkoutBuilderController', 'WorkoutProgramController', 'AssignmentController'],
  ],
];

describe('DunningLockoutGuard allow-list vs the real mounted route table', () => {
  const table = scanRouteTable();

  // Counts are asserted as derived cross-checks rather than hard-coded totals, so
  // an unrelated new controller does not turn this suite red for the wrong
  // reason. The security property is pinned by the exact reachable set below,
  // which DOES go red the moment a new route becomes reachable.
  it('parses every controller class and route the sources declare (no silent drops)', () => {
    expect(table.controllers).toHaveLength(table.textualControllers);
    expect(table.routes).toHaveLength(table.textualHttp);
    expect(table.controllers.every((c) => c.file.endsWith('.controller.ts'))).toBe(true);
    expect(table.routes.every((r) => r.controller.length > 0)).toBe(true);
  });

  it('scans the controller surface at a plausible scale (guards a silently empty scan)', () => {
    expect(table.files.length).toBeGreaterThan(100);
    expect(table.routes.length).toBeGreaterThan(500);
    // More classes than files — the parser really is class-aware.
    expect(table.controllers.length).toBeGreaterThan(table.files.length);
  });

  it.each(MULTI_CONTROLLER_FILES)(
    'pairs each @Controller class in %s with its own prefix',
    (file, expectedClasses) => {
      const declared = table.controllers.filter((c) => c.file === file);
      expect(declared.map((c) => c.className)).toEqual([...expectedClasses]);
      expect(new Set(declared.map((c) => c.prefix)).size).toBeGreaterThan(0);
    },
  );

  it('admits EXACTLY the reviewed recovery routes and nothing else', () => {
    const reachable = [
      ...new Set(
        table.routes.filter((r) => isAllowedWhileLocked(r.normalized)).map((r) => r.normalized),
      ),
    ].sort();
    expect(reachable).toEqual([...EXPECTED_REACHABLE_WHILE_LOCKED].sort());
  });

  // Lens A P1-1 — the positional second-segment match admitted any route whose
  // SECOND segment happened to be an allow-list token. Google Calendar OAuth is
  // a paid integration surface, not a payment-recovery route.
  it.each(['scheduling/auth/google/initiate', 'scheduling/auth/google/callback'])(
    'BLOCKS the paid integration route %s (Lens A P1-1)',
    (p) => {
      expect(table.routes.some((r) => r.normalized === p)).toBe(true);
      expect(isAllowedWhileLocked(p)).toBe(false);
    },
  );

  // Lens A P2-1 — the v1 coach billing surface is how a locked coach reaches the
  // Stripe portal to cure the delinquency. It must not be locked.
  it.each(['coach/me/billing', 'coach/me/billing/portal-session'])(
    'ALLOWS the v1 coach billing route %s (Lens A P2-1)',
    (p) => {
      expect(table.routes.some((r) => r.normalized === p)).toBe(true);
      expect(isAllowedWhileLocked(p)).toBe(true);
    },
  );

  // The route the previous file-level scan could not see at all: it lives in
  // checkout.controller.ts behind CheckoutController, so its single route was
  // recorded under the allow-listed `checkout` prefix instead of its own.
  it('sees coach/purchases under its own controller, and locks it', () => {
    const route = table.routes.find((r) => r.normalized === 'coach/purchases');
    expect(route).toBeDefined();
    expect(route?.controller).toBe('CoachPurchasesController');
    expect(route?.file).toBe('src/checkout/checkout.controller.ts');
    expect(isAllowedWhileLocked('coach/purchases')).toBe(false);
  });

  // The defect class, not just its two instances: an allow-list token in any
  // non-head position must never grant an exemption.
  it.each([
    'admin/auth/impersonate',
    'community/billing/tip',
    'scheduling/checkout/confirm',
    'workouts/health/summary',
    'talent-marketplace/recover/listing',
  ])('BLOCKS %s — an allow-list token off the head grants nothing', (p) => {
    expect(isAllowedWhileLocked(p)).toBe(false);
  });

  // Both coach billing surfaces reach the same BillingService capability; they
  // must not disagree about lockout.
  it('gives both coach billing surfaces the same lockout verdict', () => {
    const verdicts = [
      'coach/billing/status',
      'coach/billing/portal-session',
      'coach/me/billing',
      'coach/me/billing/portal-session',
    ].map(isAllowedWhileLocked);
    expect(verdicts).toEqual([true, true, true, true]);
  });
});

// A controller appended to a file whose FIRST controller is allow-listed — the
// mutation the previous file-level scan could not observe, and the reason this
// spec parses classes rather than files.
const APPENDED_CONTROLLER_MUTATION = `
import { Controller, Get } from '@nestjs/common';
@Controller('v1/checkout')
export class CheckoutController {
  @Get('sessions')
  createSession() { return null; }
}
// Appended by an unrelated feature PR: a paid community surface with nothing to
// do with payment recovery.
@Controller('v1/community')
export class CommunityFeedController {
  @Get('feed')
  feed() { return null; }
}
`;

/** The scan this spec replaced: one @Controller per FILE, all methods under it. */
function legacyFileLevelScan(sourceText: string): string[] {
  const controller = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/.exec(sourceText);
  if (!controller) return [];
  const prefix = controller[1] ?? controller[2] ?? '';
  const methodDecorator = new RegExp(
    `@(?:${HTTP_METHODS})\\(\\s*(?:'([^']*)'|"([^"]*)")?\\s*\\)`,
    'g',
  );
  const found: string[] = [];
  for (let m = methodDecorator.exec(sourceText); m; m = methodDecorator.exec(sourceText)) {
    const sub = m[1] ?? m[2] ?? '';
    found.push(normalizePath(`/api/${[prefix, sub].filter(Boolean).join('/')}`));
  }
  return found;
}

describe('appended-controller mutation', () => {
  const parsed = parseControllerSource(APPENDED_CONTROLLER_MUTATION, 'mutation.controller.ts');

  it('attributes the appended class to its OWN prefix, not the first in the file', () => {
    const names = parsed.map((c) => c.className);
    expect(names).toEqual(['CheckoutController', 'CommunityFeedController']);
    expect(parsed.map((c) => c.prefix)).toEqual(['v1/checkout', 'v1/community']);
    expect(parsed.flatMap((c) => c.routes.map((r) => r.normalized))).toEqual([
      'checkout/sessions',
      'community/feed',
    ]);
  });

  it('judges the appended paid surface LOCKED', () => {
    const appended = parsed
      .flatMap((c) => c.routes)
      .filter((r) => r.controller !== 'CheckoutController');
    expect(appended.map((r) => r.normalized)).toEqual(['community/feed']);
    expect(appended.some((r) => isAllowedWhileLocked(r.normalized))).toBe(false);
  });

  // The counter-example: the old scan mis-files the appended route into the
  // allow-listed `checkout` subtree, so `community/feed` never appears in the
  // inventory and the mutation passes review unobserved.
  it('is invisible to the file-level regex scan this spec replaced', () => {
    const legacy = legacyFileLevelScan(APPENDED_CONTROLLER_MUTATION);
    expect(legacy).toEqual(['checkout/sessions', 'checkout/feed']);
    expect(legacy).not.toContain('community/feed');
    // Worse than merely missing: the phantom path reads as payment recovery.
    expect(isAllowedWhileLocked('checkout/feed')).toBe(true);
  });
});
