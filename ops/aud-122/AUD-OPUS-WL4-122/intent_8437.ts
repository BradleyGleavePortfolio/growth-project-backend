/**
 * S-COACH-3 (OR-112-16, B-329-1) — the coach's "create my first package"
 * operation, made durable so no retry can ever make a second package.
 *
 * One create attempt has ONE Idempotency-Key and ONE request body. Both are
 * written to device storage before the request leaves, and every retry (a
 * second tap, a timeout, the app being killed and reopened) re-sends exactly
 * that key and body. The backend stores the key per coach and replays the
 * package it created the first time; a second request that arrives while the
 * first is still running waits for it and gets the same package back. So the
 * guarantee no longer rests on reading the package list after a timeout.
 *
 * The key is replaced only when the server definitively refused the create
 * (nothing exists), or once the package is live and the intent is cleared.
 *
 * B-329-1 (B-COACH-5): the guarantee holds across restarts because a fresh
 * create is sent only after its intent is on disk, and a storage read that
 * fails is never taken to mean "nothing was sent".
 *
 * C-345-1: the intent lives in this device's storage for this account, and
 * sign-out wipes device storage (R15 shared-device rule). So the guarantee is
 * "for the same account on this device"; after a sign-out the server keeps
 * the package, and Packages shows it.
 */
import { prefsStorage } from "../../storage/mmkv";
import type { PackageCreateInput } from "../../api/packagesApi";
import { generateIdempotencyKey } from "../../utils/idempotency";

const KEY_BASE = "coachSetup.packageCreate.v1";
const EDITOR_KEY_BASE = "coachPackages.editorCreate.v1";

/**
 * B-329-1 (B-COACH-5): an unresolved intent is never dropped by age. The
 * backend keeps package-create keys with no expiry (the
 * WorkoutBuilderIdempotencyKey ledger is never purged), so re-sending the
 * stored key and body days later still replays the one package; dropping it
 * would turn that retry into a second create. An intent ends only when the
 * package is live (cleared) or the server definitively refused it.
 */

/** Which create flow owns the intent (one remembered create per flow). */
export type IntentScope = "wizard" | "editor";

export interface PackageCreateIntent {
  v: 1;
  /** Idempotency-Key sent with every try of this create. */
  key: string;
  /** The exact body sent with that key; never changes for this key. */
  input: PackageCreateInput;
  /** Set once the server answered with the package. */
  packageId: string | null;
  /** Device time the intent was first written. */
  createdAt: number;
}

export function intentStorageKey(
  coachId: string,
  scope: IntentScope = "wizard",
): string {
  return scope === "wizard"
    ? `${KEY_BASE}:${coachId}`
    : `${EDITOR_KEY_BASE}:${coachId}`;
}

export function newIntent(
  input: PackageCreateInput,
  now: number = Date.now(),
): PackageCreateIntent {
  return {
    v: 1,
    key: generateIdempotencyKey(),
    input,
    packageId: null,
    createdAt: now,
  };
}

function isInput(x: unknown): x is PackageCreateInput {
  if (!x || typeof x !== "object") return false;
  const i = x as Record<string, unknown>;
  return (
    typeof i.title === "string" &&
    typeof i.priceCents === "number" &&
    Number.isInteger(i.priceCents) &&
    typeof i.billingInterval === "string"
  );
}

/** Parse a stored intent; anything malformed reads as none. Age never does. */
export function parseIntent(
  raw: string | null | undefined,
): PackageCreateIntent | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as Record<string, unknown>;
    if (
      x.v !== 1 ||
      typeof x.key !== "string" ||
      x.key.length < 8 ||
      !isInput(x.input) ||
      !(x.packageId === null || typeof x.packageId === "string") ||
      typeof x.createdAt !== "number"
    ) {
      return null;
    }
    return {
      v: 1,
      key: x.key,
      input: x.input,
      packageId: x.packageId,
      createdAt: x.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * What device storage holds for this coach and flow. "unreadable" (storage
 * threw) is NOT "none": an earlier create may be on its way, so the caller
 * must not send a fresh one; it shows specific copy and lets the coach retry.
 */
export type IntentRead =
  | { kind: "none" }
  | { kind: "found"; intent: PackageCreateIntent }
  | { kind: "unreadable" }
  | { kind: "no_account" };

export async function loadIntent(
  coachId: string | null,
  scope: IntentScope = "wizard",
): Promise<IntentRead> {
  if (!coachId) return { kind: "no_account" };
  let raw: string | null | undefined;
  try {
    raw = await prefsStorage.getStringAsync(intentStorageKey(coachId, scope));
  } catch {
    return { kind: "unreadable" };
  }
  const intent = parseIntent(raw);
  return intent ? { kind: "found", intent } : { kind: "none" };
}

/**
 * Write-ahead: a fresh create is sent ONLY after this resolves true. A false
 * (no account, or storage refused the write) means the key would live only in
 * memory, so a restart could send a second create under a new key.
 */
export async function saveIntent(
  coachId: string | null,
  intent: PackageCreateIntent,
  scope: IntentScope = "wizard",
): Promise<boolean> {
  if (!coachId) return false;
  try {
    await prefsStorage.set(
      intentStorageKey(coachId, scope),
      JSON.stringify(intent),
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearIntent(
  coachId: string | null,
  scope: IntentScope = "wizard",
): Promise<void> {
  if (!coachId) return;
  try {
    await prefsStorage.delete(intentStorageKey(coachId, scope));
  } catch {
    // A leftover intent only ever replays its own package (the backend keeps
    // the key), so a failed delete cannot make a second package.
  }
}

/**
 * B-329-5 (agent 118): the account, session or screen that started this
 * create is gone (sign-out, account switch, the form closed). Nothing more is
 * sent, no callback runs and storage is left as it was, so the same account
 * can finish the same create later with the same key.
 */
export class PackageCreateStoppedError extends Error {
  constructor() {
    super("package create stopped");
    this.name = "PackageCreateStoppedError";
  }
}

/** Storage could not hold the create's identity, so nothing was sent. */
export class IntentStorageError extends Error {
  constructor(readonly reason: "unreadable" | "unsaved" | "no_account") {
    super(`package create intent ${reason}`);
    this.name = "IntentStorageError";
  }
}

/** Specific, recoverable copy for an IntentStorageError (never generic). */
export function intentStorageCopy(err: IntentStorageError): {
  title: string;
  body: string;
} {
  switch (err.reason) {
    case "no_account":
      return {
        title: "Your account is still loading",
        body: "Nothing was sent. Wait a moment, then tap Create package again. If it keeps happening, sign out and sign in again.",
      };
    case "unreadable":
      return {
        title: "Your earlier package details could not be read",
        body: "Nothing new was sent, so a package cannot be made twice. Try again in a moment. If it keeps happening, restart the app; Packages shows anything already made.",
      };
    default:
      return {
        title: "This device could not save your package details",
        body: "Nothing was sent yet. Free up some space on the device if it is full, then try again.",
      };
  }
}

function bodyOf(err: unknown): Record<string, unknown> | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response
    ?.data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : null;
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof s === "number" ? s : undefined;
}

export function createErrorCode(err: unknown): string | null {
  const d = bodyOf(err);
  if (!d) return null;
  if (typeof d.code === "string") return d.code;
  return typeof d.error === "string" ? d.error : null;
}

/** A 4xx (other than 408 / 409 / 422 reuse / 429) means nothing was created. */
export function isDefinitiveRejection(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined || status < 400 || status >= 500) return false;
  if (status === 408 || status === 409 || status === 429) return false;
  return createErrorCode(err) !== "IDEMPOTENCY_KEY_REUSED";
}

/**
 * The server says this key already made a package from other details. The
 * answer names that package, so the app adopts it instead of creating another.
 */
export function reusedPackageId(err: unknown): string | null {
  if (createErrorCode(err) !== "IDEMPOTENCY_KEY_REUSED") return null;
  const d = bodyOf(err);
  return typeof d?.package_id === "string" ? d.package_id : null;
}

export interface CreateOnceDeps {
  create: (
    input: PackageCreateInput,
    key: string,
  ) => Promise<{ data: { id: string } }>;
  update: (id: string, input: PackageCreateInput) => Promise<unknown>;
}

/**
 * The one create path both flows use (B-329-1). `earlier` is the intent the
 * caller already holds (hydrated from storage or kept from a previous tap).
 *  1. An earlier unresolved intent is re-sent with its own key and body; the
 *     server replays its package or makes it now, never a second one.
 *  2. Only when nothing exists (a definitive refusal, or no earlier intent)
 *     is a fresh intent written to storage and, ONLY if that write
 *     succeeded, sent. A removed package (410) or changed details after a
 *     refusal start fresh in the same tap (C-329-8).
 *  3. Details changed after the package was made, or the key named a package
 *     made from other details (422 IDEMPOTENCY_KEY_REUSED): that package is
 *     updated with the coach's current details.
 * `onIntent` mirrors every intent change into the caller's memory.
 *
 * B-329-5 (agent 118): `isLive` says whether the account, session and screen
 * that started this create are still the current ones. It is checked before
 * the first step and again after every await, before any request, callback or
 * storage write. Once it answers false the create stops with
 * PackageCreateStoppedError: no request is sent, `onIntent` is not called and
 * nothing is removed from disk. B-345-1 (agent 119): that includes a fresh
 * intent this create wrote but never sent, because another form of the same
 * account may already have read and sent it.
 */
export async function createPackageOnce(args: {
  coachId: string | null;
  scope: IntentScope;
  input: PackageCreateInput;
  earlier: PackageCreateIntent | null;
  deps: CreateOnceDeps;
  onIntent: (next: PackageCreateIntent | null) => void;
  isLive?: () => boolean;
}): Promise<{ packageId: string; intent: PackageCreateIntent }> {
  const { coachId, scope, input, deps, onIntent } = args;
  const isLive = args.isLive ?? (() => true);
  const stopIfRetired = () => {
    if (!isLive()) throw new PackageCreateStoppedError();
  };
  if (!coachId) throw new IntentStorageError("no_account");
  stopIfRetired();
  const remember = async (next: PackageCreateIntent | null) => {
    stopIfRetired();
    onIntent(next);
    if (next) await saveIntent(coachId, next, scope);
    else await clearIntent(coachId, scope);
    stopIfRetired();
  };
  // The server named a package this key made from OTHER details: adopt it
  // and save the coach's current details onto it.
  let adopted = false;
  const send = async (
    it: PackageCreateIntent,
  ): Promise<PackageCreateIntent> => {
    stopIfRetired();
    try {
      const res = await deps.create(it.input, it.key);
      stopIfRetired();
      const done = { ...it, packageId: res.data.id };
      // Not strict: the key already made this package, so a lost write
      // only means a later re-send replays the same package.
      await remember(done);
      return done;
    } catch (err) {
      if (err instanceof PackageCreateStoppedError) throw err;
      stopIfRetired();
      const adopt = reusedPackageId(err);
      if (adopt) {
        adopted = true;
        const done = { ...it, packageId: adopt };
        await remember(done);
        return done;
      }
      if (isDefinitiveRejection(err)) await remember(null);
      throw err;
    }
  };

  let current: PackageCreateIntent | null = args.earlier;
  if (current && !current.packageId) {
    try {
      current = await send(current);
    } catch (err) {
      if (err instanceof PackageCreateStoppedError) throw err;
      const removed = createErrorCode(err) === "IDEMPOTENT_PACKAGE_REMOVED";
      if (
        !isDefinitiveRejection(err) ||
        (sameCreateInput(current.input, input) && !removed)
      )
        throw err;
      current = null;
    }
  }
  if (!current) {
    const fresh = newIntent(input);
    const saved = await saveIntent(coachId, fresh, scope);
    if (!isLive()) {
      // B-345-1 (agent 119): what was written stays. This create never sent
      // it, but once it is on disk another form of the same account may have
      // read it and sent its key, so this one cannot prove it unsent and must
      // not remove it (removing a sent key lets a later retry make a second
      // package). Kept, it only lets the same account finish this same create
      // with the same key. Sign-out still wipes it: storage applies writes in
      // the order they were issued, and this write was issued first.
      throw new PackageCreateStoppedError();
    }
    if (!saved) throw new IntentStorageError("unsaved");
    onIntent(fresh);
    current = await send(fresh);
  }
  const packageId = current.packageId as string;
  if (adopted || !sameCreateInput(current.input, input)) {
    stopIfRetired();
    await deps.update(packageId, input);
    stopIfRetired();
    current = { ...current, input };
    await remember(current);
  }
  return { packageId, intent: current };
}

/** Same body the backend would store for this key. */
export function sameCreateInput(
  a: PackageCreateInput,
  b: PackageCreateInput,
): boolean {
  return (
    a.title === b.title &&
    (a.description ?? null) === (b.description ?? null) &&
    a.priceCents === b.priceCents &&
    (a.currency ?? "usd") === (b.currency ?? "usd") &&
    a.billingInterval === b.billingInterval &&
    (a.intervalCount ?? 1) === (b.intervalCount ?? 1)
  );
}
