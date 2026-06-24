import { NotImplementedException } from '@nestjs/common';
import { SavedSearchService } from '../saved-search.service';

// TM-8b — saved-search persistence (per-hirer SavedSearch table + alert fanout)
// is deferred out of the 8a dispatch. Until it lands, the surface must fail
// closed with a typed 501 rather than fake a result. The full behaviour suite
// arrives with TM-8b.
describe('SavedSearchService — 8b deferral contract', () => {
  it('list() and create() surface a typed NotImplemented (501), never a faked result', () => {
    const service = new SavedSearchService();
    expect(() => service.list()).toThrow(NotImplementedException);
    expect(() => service.create()).toThrow(NotImplementedException);
  });

  it.skip('TM-8b: persists a per-hirer saved search with alert opt-in', () => {
    // Implemented in TM-8b alongside the SavedSearch schema + RLS.
  });

  it.skip('TM-8b: "candidates like this" reads off the existing fit signal', () => {
    // Implemented in TM-8b.
  });
});
