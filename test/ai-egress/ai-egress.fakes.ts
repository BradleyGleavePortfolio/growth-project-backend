/**
 * R2b test doubles. The REAL AiEgressService over a fake
 * ClientAiConsentReader, so every spec exercises the real gate logic.
 *
 *   grantAllEgress()          every client holds a live grant (legacy specs
 *                             whose subject is not consent)
 *   egressWithGrants([...])   only the listed clients hold a grant; the
 *                             returned reader can revoke / fail at runtime
 */
import type { ClientAiConsentReader } from '../../src/ai-consent/ai-consent.reader';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';

export class FakeConsentReader implements ClientAiConsentReader {
  readonly granted: Set<string>;
  grantAll = false;
  /** When set, every read throws (the real reader never throws; the gate must still fail closed). */
  failWith: Error | null = null;
  /** When true, reads resolve false/empty like the real reader on a DB error. */
  readFails = false;
  readonly calls: string[][] = [];

  constructor(granted: Iterable<string> = []) {
    this.granted = new Set(granted);
  }

  revoke(id: string): void {
    this.grantAll = false;
    this.granted.delete(id);
  }

  async hasClientAiConsent(userId: string): Promise<boolean> {
    this.calls.push([userId]);
    if (this.failWith) throw this.failWith;
    if (this.readFails) return false;
    return this.grantAll || this.granted.has(userId);
  }

  async clientsWithAiConsent(userIds: readonly string[]): Promise<ReadonlySet<string>> {
    this.calls.push([...userIds]);
    if (this.failWith) throw this.failWith;
    if (this.readFails) return new Set();
    return new Set(userIds.filter((id) => this.grantAll || this.granted.has(id)));
  }
}

export function egressWithGrants(granted: Iterable<string> = []): {
  egress: AiEgressService;
  reader: FakeConsentReader;
} {
  const reader = new FakeConsentReader(granted);
  return { egress: new AiEgressService(reader), reader };
}

export function grantAllEgress(): AiEgressService {
  const reader = new FakeConsentReader();
  reader.grantAll = true;
  return new AiEgressService(reader);
}

/**
 * Typed test double: hands a partial fake to a constructor parameter. The
 * type comes from the call site (e.g. `new Svc(fakeOf(prismaFake))`), so the
 * spec states only the members the code under test uses.
 */
export function fakeOf<T extends object>(impl: object): T {
  return impl as T;
}
